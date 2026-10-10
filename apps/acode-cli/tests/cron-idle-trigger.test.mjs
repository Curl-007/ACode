import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * D6 验证（docs/cli-dispatch-and-system-prompt-upgrade-plan.md §D6）：
 * cron 到期是否打断进行中 turn。
 *
 * 被验证的真实链路（全部走产品代码，不用 mock 决策逻辑）：
 *   host dispatchCronRun（packages/desktop/src/host/index.ts:944 sendPrompt，automationId 归因）
 *   → services sendPromptToAgent 无附件主路径收敛 v4 sendText 命令
 *     （packages/services/src/acode-agent/acodeTaskServiceAdapter.ts，envelope 不带 requestedDelivery）
 *   → CLI v4 gateway NATIVE_HANDLERS.sendText（session-flow.ts）
 *   → startPromptTurn（prompt-turn.ts，delivery:"start_turn"，Cron 写工具进 turn 级 disallowlist）
 *   → core admitPrompt（prompt-admission.ts）busy 裁决 → enqueueDeferredInput（steering.ts）
 *
 * 断言的核心语义：到期命令落在 in-flight turn 中时是「延迟入队（queue lane）」，
 * 既不打断（无 abort/preempt，active turn 原样存续），也不 steer 进在飞 turn 的
 * 内存引导队列（pendingInputs 不被注入）；队列提升只在空闲发生
 * （shouldAutoDrainV4QueueHead 要求 !sessionBusy；requireIdle admission busy 时 rejected）。
 *
 * host 侧（packages/desktop / packages/services）不在 apps/acode-cli 测试进程内，
 * 本测试在 CLI 协议边界以 host cron 派发同形的 sendText envelope 复现入口载荷。
 */

// handlers 必须经 index.ts 进入：session-flow.ts ↔ v4-gateway.ts 存在模块环，
// 直接以 session-flow.ts 为入口会触发 TDZ（Cannot access 'sessionFlowHandlers'）。
const { NATIVE_HANDLERS } =
  await import("../packages/bootstrap/src/acode-protocol-v4/commands/handlers/index.ts");
const { shouldAutoDrainV4QueueHead } =
  await import("../packages/bootstrap/src/acode-protocol-v4/queue-auto-drain.ts");
const { admitPrompt } = await import("../packages/core/src/runtime/methods/prompt-admission.ts");
const steering = await import("../packages/core/src/runtime/methods/steering.ts");
const commandQueue = await import("../packages/core/src/runtime/methods/runtime-command-queue.ts");
const { initializeRuntimeTurnCoordination } =
  await import("../packages/core/src/runtime/turn-coordination.ts");
const { SessionEventType } = await import("../packages/contracts/src/index.ts");

const SESSION_ID = "sess-cron-idle-trigger";
const AUTOMATION_ID = "auto-cron-demo";
const CRON_WRITE_TOOLS = ["CronCreate", "CronUpdate", "CronDelete"];

/**
 * 最小 AgentRuntimeInternal 替身：状态字段 + 队列/事件账本，
 * 决策方法全部绑定真实实现（admitPrompt / steerTurn / enqueueDeferredInput /
 * reserveTurnStart / beginActiveTurn / finishActiveTurn / hasActiveOrQueuedTurnWork /
 * acquireForegroundPromotionLease）。
 */
function createRuntimeHarness() {
  const events = [];
  /** 已入队未执行的 runtime command（等价真实 runtimeCommandQueue 的 pending 段）。 */
  const pendingCommands = [];
  /** TurnSteerQueued(delivery=queue) 事件账本派生的 held queue（供 rebuildProjection）。 */
  const heldQueue = [];

  const runtime = {
    sessionId: SESSION_ID,
    rootTraceContext: {
      traceId: "trace_cron_root",
      queryId: undefined,
      spanId: "span_cron_root",
      parentSpanId: undefined,
      sessionId: SESSION_ID,
      turnId: undefined,
      attributes: {},
    },
    logger: undefined,
    turnNumber: 1,
    // ── admitPrompt / hasActiveOrQueuedTurnWork 读取的 busy 事实 ──
    activeTurn: undefined,
    activeTurnStartReservation: undefined,
    foregroundPromotionLease: undefined,
    activeForegroundExecution: undefined,
    runtimeCommandDrainActive: false,
    // ── steering 状态 ──
    pendingInputSequence: 0,
    pendingInputReservations: new Map(),
    latestAssistantTurnId: undefined,
    permissionFullAccessPending: false,
    queueExternalDrainActive: false,
    queueAutoDrain: true,

    runtimeCommandQueue: {
      hasPending: () => pendingCommands.length > 0,
      enqueue: (command) => pendingCommands.push(command),
      dequeue: () => pendingCommands.shift(),
      removeById: (id) => {
        const index = pendingCommands.findIndex((command) => command.id === id);
        return index >= 0 ? pendingCommands.splice(index, 1)[0] : undefined;
      },
      markCancelPending: () => {},
      clearCancelPending: () => {},
      consumeCancelPending: () => false,
      size: () => pendingCommands.length,
      snapshot: () => [...pendingCommands],
      getByMaxPriority: () => [...pendingCommands],
      dequeueNextBatch: () => (pendingCommands.length > 0 ? [pendingCommands.shift()] : []),
    },
    // 真实 enqueueRuntimeCommand 会触发 drain 循环执行模型轮；测试要手动推进
    // turn 生命周期（beginActiveTurn/finishActiveTurn），所以只捕获命令。
    enqueueRuntimeCommand: (command) => {
      pendingCommands.push(command);
    },
    drainRuntimeCommandQueue: async () => {},

    appendEvent: async (event) => {
      events.push(event);
      if (event.type === SessionEventType.TurnSteerQueued && event.payload?.delivery === "queue") {
        heldQueue.push({
          pendingInputId: event.payload.pendingInputId,
          targetTurnId: event.payload.targetTurnId,
        });
      }
    },
    rebuildProjection: async () => ({ pendingSteerInputs: [...heldQueue] }),
    sessionStore: undefined,

    // ── 绑定真实决策实现（this 语义与 AgentRuntimeInternal 相同） ──
    admitPrompt,
    hasActiveOrQueuedTurnWork: commandQueue.hasActiveOrQueuedTurnWork,
    acquireForegroundPromotionLease: commandQueue.acquireForegroundPromotionLease,
    releaseForegroundPromotionLease: commandQueue.releaseForegroundPromotionLease,
    steerTurn: steering.steerTurn,
    enqueueDeferredInput: steering.enqueueDeferredInput,
    rejectTurnSteer: steering.rejectTurnSteer,
    reserveTurnStart: steering.reserveTurnStart,
    releaseTurnStart: steering.releaseTurnStart,
    beginActiveTurn: steering.beginActiveTurn,
    finishActiveTurn: steering.finishActiveTurn,
    createPendingInputId: steering.createPendingInputId,
    hasPendingInput: steering.hasPendingInput,
  };

  initializeRuntimeTurnCoordination(runtime);
  return { runtime, events, pendingCommands, heldQueue };
}

/** V4SessionRecordView / host 替身：只提供 sendText handler 与 startPromptTurn 触及的钩子。 */
function createHostHarness(runtime) {
  const app = {
    sessionId: runtime.sessionId,
    getMode: () => "build",
    getModel: () => "test-provider/test-model",
    runtime: {
      getSessionModelSelection: () => ({ providerId: "test-provider", modelId: "test-model" }),
      getPlanEnabled: () => false,
      acquireForegroundPromotionLease: (options) =>
        runtime.acquireForegroundPromotionLease(options),
      releaseForegroundPromotionLease: (leaseId) =>
        runtime.releaseForegroundPromotionLease(leaseId),
    },
    // 与 bootstrap input-facade.sendInput 相同的 receipt 映射（started → started_turn）。
    sendInput: async (input, options) => {
      const result = await runtime.admitPrompt(input.text, input.attachments, options);
      if (result.kind === "started") {
        return { kind: "started_turn", turnId: result.turnId, completion: result.completion };
      }
      return result;
    },
    enqueueDeferredInput: async (text, options) => runtime.enqueueDeferredInput(text, options),
  };
  const record = {
    app,
    persistence: "immediate",
    restoreWarning: undefined,
    activeAutomationId: undefined,
    activeOffPeakTaskId: undefined,
    activeBotDeliveryTarget: undefined,
    traceContext: runtime.rootTraceContext,
  };
  // computeInputRouting（projection-state.ts）：idle → startNow；running + followupMode=queue → enqueue。
  const host = {
    getRecord: (sessionId) => (sessionId === runtime.sessionId ? record : undefined),
    getInputRoutingMode: () =>
      runtime.activeTurn || runtime.activeTurnStartReservation ? "enqueue" : "startNow",
    hasUsableRuntimeModelTarget: () => true,
    ensureModelReady: async () => {},
    afterLegacyStateMutation: async () => {},
    logger: { info() {}, warn() {}, debug() {} },
  };
  return { host, record, app };
}

/** host 定时派发同形 envelope：acodeTaskServiceAdapter v4 sendText 分支的载荷字段。 */
function cronSendTextEnvelope(commandId, text) {
  return {
    type: "sendText",
    sessionId: SESSION_ID,
    commandId,
    clientId: "desktop-host-cron-dispatch",
    payload: {
      text,
      heldQueueDisposition: "keepQueueAndSend",
      automationId: AUTOMATION_ID,
      // host 派发不携带 requestedDelivery —— forceStartNow（抢占）只能由显式
      // payload.requestedDelivery === "startNow" 触发（session-flow.ts:199）。
    },
  };
}

function steerQueuedEvents(events) {
  return events.filter((event) => event.type === SessionEventType.TurnSteerQueued);
}

/** 从 harness 队列取出一条 prompt command 并把 turn 置为在飞（模拟真实 drain 执行）。 */
function startEnqueuedTurn(runtime, { inputId, steerable = true }) {
  const command = runtime.runtimeCommandQueue.dequeue();
  assert.equal(command?.mode, "prompt", "expected a prompt runtime command");
  assert.ok(command.startReservation, "admission must carry a turn start reservation");
  const activeTurn = runtime.beginActiveTurn(
    command.startReservation.turnId,
    command.startReservation.traceContext,
    "regular",
    steerable,
    inputId === undefined ? undefined : { inputId },
  );
  return { command, activeTurn };
}

test("(1) idle 到期：startNow 直启，命令以 next 档入队并携带 automation 归因", async () => {
  const { runtime, pendingCommands } = createRuntimeHarness();
  const { host, record } = createHostHarness(runtime);
  const runId = `${AUTOMATION_ID}:1700000000000`;

  const result = await NATIVE_HANDLERS.sendText(
    host,
    cronSendTextEnvelope(runId, "cron 巡检：汇报状态"),
  );

  assert.deepEqual(result, { type: "inputAccepted", delivery: "startNow", inputId: runId });
  assert.equal(pendingCommands.length, 1);
  const command = pendingCommands[0];
  assert.equal(command.priority, "next", "到期命令与常规用户 prompt 同档（next），不得插队");
  assert.equal(command.mode, "prompt");
  assert.equal(command.options.automationId, AUTOMATION_ID);
  // automation 轮守卫：Cron 写工具在本 turn 工具面被移除（prompt-turn.ts buildTurnToolDisallowlist）。
  assert.deepEqual([...command.options.toolDisallowlist].sort(), [...CRON_WRITE_TOOLS].sort());
  assert.equal(record.activeAutomationId, AUTOMATION_ID, "turn 期间记录 automation 归属");
  assert.equal(runtime.activeTurn, undefined, "admission 不等待 turn 启动");
});

test("(2) 到期落在 in-flight turn：延迟入队而非中断，也不 steer 进在飞 turn", async () => {
  const { runtime, events, pendingCommands } = createRuntimeHarness();
  const { host, record } = createHostHarness(runtime);

  // 第一条 cron 到期（idle）→ 直启，并推进到 turn 在飞。
  const runId1 = `${AUTOMATION_ID}:1700000000001`;
  await NATIVE_HANDLERS.sendText(host, cronSendTextEnvelope(runId1, "第一轮 cron prompt"));
  const first = startEnqueuedTurn(runtime, { inputId: runId1 });
  assert.equal(pendingCommands.length, 0);

  // 第二条 cron 到期，落在第一轮 in-flight 中。
  const runId2 = `${AUTOMATION_ID}:1700000060001`;
  const result = await NATIVE_HANDLERS.sendText(
    host,
    cronSendTextEnvelope(runId2, "第二轮 cron prompt"),
  );

  // —— 延迟入队（queue lane），不是 startNow ——
  assert.deepEqual(result, { type: "inputAccepted", delivery: "queue", inputId: runId2 });

  // —— 不打断：在飞 turn 原样存续，无 abort/preempt，无第二条命令入队 ——
  assert.equal(runtime.activeTurn, first.activeTurn, "在飞 turn 必须原样存续（未被中断/替换）");
  assert.equal(runtime.activeTurn.turnId, first.activeTurn.turnId);
  assert.equal(pendingCommands.length, 0, "到期不得立即启动第二条 turn 命令");

  // —— 不 steer：queue lane 不注入在飞 turn 的内存引导队列 ——
  assert.equal(
    runtime.activeTurn.pendingInputs.length,
    0,
    "cron 到期输入不得注入在飞 turn 的 pendingInputs（那是 guide/steer 车道）",
  );

  // —— 排队事实：TurnSteerQueued(delivery=queue)，携带归因与工具守卫 ——
  const queued = steerQueuedEvents(events).filter(
    (event) => event.payload.intent?.sourceCommandId === runId2,
  );
  assert.equal(queued.length, 1);
  assert.equal(queued[0].payload.delivery, "queue");
  assert.equal(queued[0].payload.input, "第二轮 cron prompt");
  assert.equal(queued[0].payload.targetTurnId, first.activeTurn.turnId);
  assert.deepEqual([...queued[0].payload.toolDisallowlist].sort(), [...CRON_WRITE_TOOLS].sort());
  assert.equal(queued[0].payload.intent.requestedDelivery, "queue");
  assert.equal(queued[0].payload.intent.admittedDelivery, "queue");

  // —— queued admission 后 record 归因还原为在飞 turn 的 automationId（prompt-turn.ts clearPromptRecordState）——
  assert.equal(record.activeAutomationId, AUTOMATION_ID);
});

test("(3) busy 期间队列不得自动提升：drain 闸门与 requireIdle admission 双保险", async () => {
  const { runtime } = createRuntimeHarness();
  const { host } = createHostHarness(runtime);
  const runId1 = `${AUTOMATION_ID}:1700000000002`;
  await NATIVE_HANDLERS.sendText(host, cronSendTextEnvelope(runId1, "占用会话的 turn"));
  const first = startEnqueuedTurn(runtime, { inputId: runId1 });

  // 自动 drain 唯一闸门：sessionBusy 时一律不放行（queue-auto-drain.ts）。
  assert.equal(
    shouldAutoDrainV4QueueHead({
      autoDrain: true,
      dispatchState: "queued",
      sessionBusy: true,
      targetStatus: null,
    }),
    false,
  );

  // sendQueuedNow(autoDrain) 的 Core admission 带 requireIdle：busy 时 rejected，
  // handler 视之为 promotion 未启动（queue.ts），不抢占、不打断。
  const promotion = await runtime.admitPrompt("被延迟的 cron prompt", undefined, {
    delivery: "start_turn",
    inputId: `${AUTOMATION_ID}:1700000060002`,
    requireIdle: true,
  });
  assert.equal(promotion.kind, "rejected");
  assert.equal(runtime.activeTurn, first.activeTurn, "rejected 的 promotion 不得触碰在飞 turn");
});

test("(4) turn 结束后空闲提升：idle-only lease + requireIdle 直启，仍是 next 档", async () => {
  const { runtime, pendingCommands } = createRuntimeHarness();
  const { host, record } = createHostHarness(runtime);

  const runId1 = `${AUTOMATION_ID}:1700000000003`;
  await NATIVE_HANDLERS.sendText(host, cronSendTextEnvelope(runId1, "第一轮 cron prompt"));
  const first = startEnqueuedTurn(runtime, { inputId: runId1 });
  const runId2 = `${AUTOMATION_ID}:1700000060003`;
  const queued = await NATIVE_HANDLERS.sendText(
    host,
    cronSendTextEnvelope(runId2, "第二轮 cron prompt"),
  );
  assert.equal(queued.delivery, "queue");

  // 第一轮真实完成（prompt-turn 后台 finally 等价：finishActiveTurn + 归因还原）。
  runtime.finishActiveTurn(first.activeTurn);
  record.activeAutomationId = undefined;
  assert.equal(runtime.hasActiveOrQueuedTurnWork(), false);
  assert.equal(
    shouldAutoDrainV4QueueHead({
      autoDrain: true,
      dispatchState: "queued",
      sessionBusy: false,
      targetStatus: null,
    }),
    true,
  );

  // 自动提升（sendQueuedNow autoDrainPromotion 同型）：idle-only lease 只在空闲可得。
  const lease = runtime.acquireForegroundPromotionLease({
    leaseId: `queue-promotion:${runId2}`,
    mode: "idle-only",
    promotedInputId: runId2,
  });
  assert.equal(lease.kind, "acquired");
  const promotion = await runtime.admitPrompt("第二轮 cron prompt", undefined, {
    delivery: "start_turn",
    inputId: runId2,
    queryId: runId2,
    requireIdle: true,
    automationId: AUTOMATION_ID,
  });
  assert.equal(promotion.kind, "started");
  assert.equal(pendingCommands.length, 1);
  assert.equal(pendingCommands[0].priority, "next");
  assert.equal(
    pendingCommands[0].options.inputId,
    runId2,
    "提升必须沿用原 runId，终态才能与派发对账",
  );
  assert.equal(pendingCommands[0].options.automationId, AUTOMATION_ID);
  runtime.releaseForegroundPromotionLease(`queue-promotion:${runId2}`);
});

test("(5) 车道对照：用户 auto 输入 steer 进在飞 turn，cron start_turn 输入只进 deferred 队列", async () => {
  const { runtime } = createRuntimeHarness();
  const { host } = createHostHarness(runtime);
  const runId1 = `${AUTOMATION_ID}:1700000000004`;
  await NATIVE_HANDLERS.sendText(host, cronSendTextEnvelope(runId1, "占用会话的 turn"));
  const first = startEnqueuedTurn(runtime, { inputId: runId1 });

  // 用户跟随输入（delivery auto，legacy/交互语义）：可 steer 时在飞 turn 内引导，不打断。
  const userSteer = await runtime.admitPrompt("用户补充说明", undefined, {
    delivery: "auto",
    inputId: "user-followup-1",
  });
  assert.equal(userSteer.kind, "queued");
  assert.equal(runtime.activeTurn.pendingInputs.length, 1, "auto 车道进入在飞 turn 内存引导队列");
  assert.equal(runtime.activeTurn.turnId, first.activeTurn.turnId);

  // cron 到期输入（delivery start_turn）：同一在飞 turn 下只落 deferred 队列，不进内存车道。
  const cronDeferred = await runtime.admitPrompt("第二轮 cron prompt", undefined, {
    delivery: "start_turn",
    inputId: `${AUTOMATION_ID}:1700000060004`,
    automationId: AUTOMATION_ID,
  });
  assert.equal(cronDeferred.kind, "queued");
  assert.equal(
    runtime.activeTurn.pendingInputs.length,
    1,
    "start_turn 车道不得向在飞 turn 注入内存引导输入",
  );
  assert.equal(runtime.activeTurn.turnId, first.activeTurn.turnId, "在飞 turn 全程未被打断");
});
