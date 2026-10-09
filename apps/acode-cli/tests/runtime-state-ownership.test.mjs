import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import ts from "typescript";

const { AgentRuntime } = await import("../packages/core/src/runtime/agent-runtime.ts");
const { createSqliteSessionStore } =
  await import("../packages/adapters/src/storage/session-store/sqlite-session-store.ts");
const { createInMemorySessionEventStore } =
  await import("../packages/contracts/src/events/in-memory-session-event-store.ts");
const { getRuntimeBranchRestorePort, getRuntimeCommandDrainPort } =
  await import("../packages/core/src/runtime/turn-coordination.ts");
const { getRuntimeLifecyclePort, initializeRuntimeLifecycle } =
  await import("../packages/core/src/runtime/runtime-lifecycle.ts");
const { getRuntimeNotificationSealPort, initializeRuntimeNotificationSeal } =
  await import("../packages/core/src/runtime/runtime-notification-seal.ts");
const { getRuntimeModelSelectionPort, initializeRuntimeModelSelection } =
  await import("../packages/core/src/runtime/runtime-model-selection.ts");
const {
  getRuntimeSessionPersistencePort,
  initializeRuntimeSessionPersistence,
} = await import("../packages/core/src/runtime/runtime-session-persistence.ts");
const { getRuntimePermissionGrantPort, initializeRuntimePermissionGrant } =
  await import("../packages/core/src/runtime/runtime-permission-grant.ts");
const {
  getRuntimeModelChangeTimelinePort,
  initializeRuntimeModelChangeTimeline,
} = await import("../packages/core/src/runtime/runtime-model-change-timeline.ts");
const { applySubmissionExecutionState } =
  await import("../packages/core/src/runtime/methods/turn-model.ts");
const { maybeStartSessionTitleGeneration } =
  await import("../packages/core/src/runtime/methods/session-title.ts");
const { isStaleBranchRuntimeCommand } =
  await import("../packages/core/src/runtime/methods/runtime-command-generation.ts");

const trace = {
  attributes: {},
  sessionId: "sess_state_owner",
  spanId: "span_state_owner",
  traceId: "trace_state_owner",
};

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture(t, config = {}) {
  const dir = await mkdtemp(join(tmpdir(), "acode-runtime-state-"));
  const store = createSqliteSessionStore({ dbPath: join(dir, "sessions.db") });
  const session = await store.createSession({
    directory: dir,
    id: trace.sessionId,
    projectID: "proj_state_owner",
    slug: "state-owner",
    title: "state owner",
    version: "v4",
  });
  const runtime = new AgentRuntime(
    trace.sessionId,
    { mode: "build", workingDirectory: dir, ...config },
    {
      eventStore: createInMemorySessionEventStore(),
      modelFactory: () => {
        throw new Error("This state ownership fixture must not request a model");
      },
      sessionStore: store,
      traceContext: trace,
    },
  );
  t.after(async () => {
    runtime.beginShutdown();
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { runtime, session, store };
}

function notification(generation) {
  return {
    branchGeneration: generation,
    createdAt: new Date(),
    id: `cmd_notify_${generation}`,
    mode: "task-notification",
    priority: "next",
    source: "background_task",
    taskId: "task_state_owner",
    text: "completed",
    traceContext: trace,
  };
}

test("CLI-05 I4: runtime restart reminder is owned by a one-shot consume port", () => {
  const runtime = {};
  initializeRuntimeLifecycle(runtime);
  const port = getRuntimeLifecyclePort(runtime);

  assert.equal(runtime.runtimeRestartReminderEmitted, false);
  assert.equal(port.consumeRuntimeRestartReminder(), true);
  assert.equal(runtime.runtimeRestartReminderEmitted, true);
  assert.equal(port.consumeRuntimeRestartReminder(), false);

  assert.throws(() => {
    runtime.runtimeRestartReminderEmitted = false;
  }, TypeError);
  assert.throws(
    () => Object.defineProperty(runtime, "runtimeRestartReminderEmitted", { value: false }),
    TypeError,
  );
  assert.throws(() => {
    port.consumeRuntimeRestartReminder = () => true;
  }, TypeError);
});

test("CLI-05 I4: session title attempt is owned by the same one-shot lifecycle port", () => {
  const runtime = {};
  initializeRuntimeLifecycle(runtime);
  const port = getRuntimeLifecyclePort(runtime);

  assert.equal(runtime.sessionTitleGenerationAttempted, false);
  assert.equal(port.consumeSessionTitleGenerationAttempted(), true);
  assert.equal(runtime.sessionTitleGenerationAttempted, true);
  assert.equal(port.consumeSessionTitleGenerationAttempted(), false);

  assert.throws(() => {
    runtime.sessionTitleGenerationAttempted = false;
  }, TypeError);
  assert.throws(
    () => Object.defineProperty(runtime, "sessionTitleGenerationAttempted", { value: false }),
    TypeError,
  );
  assert.throws(() => {
    port.consumeSessionTitleGenerationAttempted = () => true;
  }, TypeError);
});

test("CLI-05 I5: notification seal is a child-only one-shot owner with frozen reason", () => {
  const runtime = {};
  initializeRuntimeNotificationSeal(runtime, () => true);
  const port = getRuntimeNotificationSealPort(runtime);

  assert.equal(runtime.backgroundTaskNotificationsSealed, false);
  assert.equal(runtime.backgroundTaskNotificationSealReason, undefined);
  assert.equal(port.seal("subagent_cancelled"), true);
  assert.equal(runtime.backgroundTaskNotificationsSealed, true);
  assert.equal(runtime.backgroundTaskNotificationSealReason, "subagent_cancelled");
  assert.equal(port.seal("subagent_terminal"), false);
  assert.equal(runtime.backgroundTaskNotificationSealReason, "subagent_cancelled");

  assert.throws(() => {
    runtime.backgroundTaskNotificationsSealed = false;
  }, TypeError);
  assert.throws(() => {
    runtime.backgroundTaskNotificationSealReason = "subagent_terminal";
  }, TypeError);
  assert.throws(
    () => Object.defineProperty(runtime, "backgroundTaskNotificationsSealed", { value: false }),
    TypeError,
  );
  assert.throws(() => {
    port.seal = () => true;
  }, TypeError);
});

test("CLI-05 I5: sealed background Bash notifications are suppressed only for child runtimes", async (t) => {
  const { runtime: parent } = await fixture(t);
  assert.equal(parent.backgroundTaskNotificationsSealed, false);
  parent.sealBackgroundTaskNotifications({ reason: "subagent_terminal", traceContext: trace });
  assert.equal(parent.backgroundTaskNotificationsSealed, false);

  const { runtime: child } = await fixture(t, { taskType: "subagent_child" });
  const { shouldSuppressTaskNotificationRuntimeCommand } =
    await import("../packages/core/src/runtime/methods/background-notifications.ts");
  const bash = { ...notification(0), toolName: "Bash" };
  const other = { ...notification(0), toolName: "Read" };
  assert.equal(shouldSuppressTaskNotificationRuntimeCommand.call(child, bash), false);
  assert.equal(shouldSuppressTaskNotificationRuntimeCommand.call(child, other), false);

  child.sealBackgroundTaskNotifications({ reason: "subagent_terminal", traceContext: trace });
  assert.equal(shouldSuppressTaskNotificationRuntimeCommand.call(child, bash), true);
  assert.equal(shouldSuppressTaskNotificationRuntimeCommand.call(child, other), false);
  child.sealBackgroundTaskNotifications({ reason: "subagent_cancelled", traceContext: trace });
  assert.equal(child.backgroundTaskNotificationSealReason, "subagent_terminal");
});

test("CLI-05 I6: model selection owner clones input and read projections", () => {
  const runtime = {};
  const selection = {
    providerId: "provider-owner",
    modelId: "model-owner",
    options: { reasoningLevel: "high" },
  };
  initializeRuntimeModelSelection(runtime, selection);
  const port = getRuntimeModelSelectionPort(runtime);

  selection.options.reasoningLevel = "low";
  assert.equal(runtime.sessionModelSelection.options.reasoningLevel, "high");
  const projected = port.get();
  projected.options.reasoningLevel = "minimal";
  assert.equal(runtime.sessionModelSelection.options.reasoningLevel, "high");

  port.set({
    providerId: "provider-next",
    modelId: "model-next",
    options: { reasoningLevel: "medium" },
  });
  assert.deepEqual(port.get(), {
    providerId: "provider-next",
    modelId: "model-next",
    options: { reasoningLevel: "medium" },
  });
  port.set(undefined);
  assert.equal(runtime.sessionModelSelection, undefined);

  assert.throws(() => {
    runtime.sessionModelSelection = selection;
  }, TypeError);
  assert.throws(
    () => Object.defineProperty(runtime, "sessionModelSelection", { value: selection }),
    TypeError,
  );
  assert.throws(() => {
    port.set = () => {};
  }, TypeError);
});

test("CLI-05 I6: execution-scope model preparation does not mutate session selection", async () => {
  const selection = {
    providerId: "provider-session",
    modelId: "model-session",
    options: { reasoningLevel: "high" },
  };
  let setCalls = 0;
  const runtime = {
    getSessionModelSelection: () => selection,
    setSessionModelSelection: () => {
      setCalls += 1;
    },
    rootTraceContext: trace,
    config: {},
  };
  const preparedModel = { providerId: "provider-execution", modelId: "model-execution" };
  const result = await applySubmissionExecutionState(
    runtime,
    {
      modelSelection: {
        providerId: "provider-execution",
        modelId: "model-execution",
        options: { reasoningLevel: "minimal" },
      },
    },
    trace,
    { selectionScope: "execution" },
    preparedModel,
  );
  assert.equal(result, preparedModel);
  assert.equal(setCalls, 0);
});

test("CLI-05: session persistence is a monotonic owner port", () => {
  const runtime = {};
  initializeRuntimeSessionPersistence(runtime);
  const port = getRuntimeSessionPersistencePort(runtime);

  assert.equal(runtime.sessionPersisted, false);
  assert.equal(port.markPersisted(), true);
  assert.equal(runtime.sessionPersisted, true);
  assert.equal(port.markPersisted(), false);

  assert.throws(() => {
    runtime.sessionPersisted = false;
  }, TypeError);
  assert.throws(
    () => Object.defineProperty(runtime, "sessionPersisted", { value: false }),
    TypeError,
  );
  assert.throws(() => {
    port.markPersisted = () => true;
  }, TypeError);
});

test("CLI-05 I4: shutdown is a monotonic commit-once lifecycle flag", () => {
  const runtime = {};
  initializeRuntimeLifecycle(runtime);
  const port = getRuntimeLifecyclePort(runtime);

  assert.equal(runtime.shuttingDown, false);
  port.commitShutdown();
  assert.equal(runtime.shuttingDown, true);
  // 幂等：重复提交不能产生第二次状态变化，也没有写回 false 的端口。
  port.commitShutdown();
  assert.equal(runtime.shuttingDown, true);
  assert.equal(typeof port.commitShutdown, "function");

  assert.throws(() => {
    runtime.shuttingDown = false;
  }, TypeError);
  assert.throws(
    () => Object.defineProperty(runtime, "shuttingDown", { value: false }),
    TypeError,
  );
  assert.throws(() => {
    port.commitShutdown = () => {};
  }, TypeError);
});

test("CLI-05 I7: permission grant owner reserves atomically and releases only via end", () => {
  const runtime = {};
  initializeRuntimePermissionGrant(runtime);
  const port = getRuntimePermissionGrantPort(runtime);

  assert.equal(runtime.permissionFullAccessPending, false);
  assert.equal(port.tryBeginPermissionFullAccess(), true);
  assert.equal(runtime.permissionFullAccessPending, true);
  // 预约期间的第二次 begin 得到 false：调用方沿用既有 busy 拒绝语义。
  assert.equal(port.tryBeginPermissionFullAccess(), false);
  port.endPermissionFullAccess();
  assert.equal(runtime.permissionFullAccessPending, false);
  assert.equal(port.tryBeginPermissionFullAccess(), true);
  // 无预约（含重复）的 end 是安全 no-op，不影响后来者。
  port.endPermissionFullAccess();
  port.endPermissionFullAccess();
  assert.equal(runtime.permissionFullAccessPending, false);
  assert.equal(port.tryBeginPermissionFullAccess(), true);
  port.endPermissionFullAccess();

  assert.throws(() => {
    runtime.permissionFullAccessPending = true;
  }, TypeError);
  assert.throws(
    () => Object.defineProperty(runtime, "permissionFullAccessPending", { value: true }),
    TypeError,
  );
  assert.throws(() => {
    port.tryBeginPermissionFullAccess = () => true;
  }, TypeError);
  assert.throws(() => {
    port.endPermissionFullAccess = () => {};
  }, TypeError);
});

test("CLI-05 I7: lastPermissionGrantId is replace/clear only via the owner port", () => {
  const runtime = {};
  initializeRuntimePermissionGrant(runtime);
  const port = getRuntimePermissionGrantPort(runtime);

  assert.equal(runtime.lastPermissionGrantId, undefined);
  port.setLastPermissionGrantId("grant_a");
  assert.equal(runtime.lastPermissionGrantId, "grant_a");
  port.setLastPermissionGrantId("grant_b");
  assert.equal(runtime.lastPermissionGrantId, "grant_b");
  port.setLastPermissionGrantId(undefined);
  assert.equal(runtime.lastPermissionGrantId, undefined);

  assert.throws(() => {
    runtime.lastPermissionGrantId = "grant_bad";
  }, TypeError);
  assert.throws(
    () => Object.defineProperty(runtime, "lastPermissionGrantId", { value: "grant_bad" }),
    TypeError,
  );
  assert.throws(() => {
    port.setLastPermissionGrantId = () => {};
  }, TypeError);
});

test("CLI-05 I8: model change timeline consumes once and stores frozen records", () => {
  const runtime = {};
  initializeRuntimeModelChangeTimeline(runtime);
  const port = getRuntimeModelChangeTimelinePort(runtime);

  // 空 owner 的 consume 是安全 no-op。
  assert.equal(port.consumePendingModelChangeTimeline(), undefined);

  const timeline = {
    createdAt: 1,
    fromModel: { providerId: "provider-a", modelId: "model-a" },
    requestId: "req_timeline",
    toModel: { providerId: "provider-b", modelId: "model-b" },
    toModelLabel: "provider-b/model-b",
  };
  port.setPendingModelChangeTimeline(timeline);
  assert.equal(runtime.pendingModelChangeTimeline.requestId, "req_timeline");
  // 存储记录被冻结：读面不能原地改写 owner 事实。
  assert.throws(() => {
    runtime.pendingModelChangeTimeline.requestId = "req_bad";
  }, TypeError);

  const consumed = port.consumePendingModelChangeTimeline();
  assert.equal(consumed.requestId, "req_timeline");
  assert.equal(runtime.pendingModelChangeTimeline, undefined);
  // consume 即取出并清空：二次 consume 不会拿到同一条记录。
  assert.equal(port.consumePendingModelChangeTimeline(), undefined);

  // set(undefined) 清除语义。
  port.setPendingModelChangeTimeline({ ...timeline, requestId: "req_second" });
  port.setPendingModelChangeTimeline(undefined);
  assert.equal(runtime.pendingModelChangeTimeline, undefined);

  assert.throws(() => {
    runtime.pendingModelChangeTimeline = timeline;
  }, TypeError);
  assert.throws(
    () => Object.defineProperty(runtime, "pendingModelChangeTimeline", { value: timeline }),
    TypeError,
  );
  assert.throws(() => {
    port.setPendingModelChangeTimeline = () => {};
  }, TypeError);
});

test("CLI-05 I4: real runtime shutdown commits once and the getter stays read-only", async (t) => {
  const { runtime } = await fixture(t);
  assert.equal(runtime.shuttingDown, false);
  assert.throws(() => {
    runtime.shuttingDown = true;
  }, TypeError);

  runtime.beginShutdown();
  assert.equal(runtime.shuttingDown, true);
  // 重复 beginShutdown 幂等；没有端口能写回 false。
  runtime.beginShutdown();
  assert.equal(runtime.shuttingDown, true);
  getRuntimeLifecyclePort(runtime).commitShutdown();
  assert.equal(runtime.shuttingDown, true);

  const descriptor = Object.getOwnPropertyDescriptor(runtime, "shuttingDown");
  assert.equal(descriptor.set, undefined);
  assert.equal(descriptor.configurable, false);
});

test("CLI-05 I7: concurrent full-access grants reserve once and keep the busy rejection", async (t) => {
  const { runtime } = await fixture(t);
  const port = getRuntimePermissionGrantPort(runtime);

  // 已被预约时，授权路径沿用既有 busy 拒绝，且不会误释放他人的预约。
  assert.equal(port.tryBeginPermissionFullAccess(), true);
  await assert.rejects(runtime.grantPermissionFullAccess("grant_busy"), /Queue mutation is busy/);
  assert.equal(runtime.permissionFullAccessPending, true);
  port.endPermissionFullAccess();

  // 真实并发：第一个调用在首次 await 前同步预约，第二个得到同一 busy 拒绝。
  const first = runtime.grantPermissionFullAccess("grant_first");
  const second = runtime.grantPermissionFullAccess("grant_second");
  await assert.rejects(second, /Queue mutation is busy/);
  assert.equal(typeof (await first), "string");
  assert.equal(runtime.permissionFullAccessPending, false);
  assert.equal(runtime.lastPermissionGrantId, "grant_first");
  assert.throws(() => {
    runtime.lastPermissionGrantId = "grant_bad";
  }, TypeError);
});

test("CLI-05 I8: real runtime keeps replace-or-clear rules behind the timeline port", async (t) => {
  const { runtime } = await fixture(t);
  const modelA = { providerId: "provider-a", modelId: "model-a" };
  const modelB = { providerId: "provider-b", modelId: "model-b" };

  runtime.recordPendingModelChange({ fromModel: modelA, toModel: modelB, toModelLabel: "B" });
  const first = runtime.pendingModelChangeTimeline;
  assert.equal(first.toModel.modelId, "model-b");
  assert.throws(() => {
    first.requestId = "req_bad";
  }, TypeError);

  // 反向切换等价 from/to：沿用既有 clear 规则。
  runtime.recordPendingModelChange({ fromModel: modelB, toModel: modelA, toModelLabel: "A" });
  assert.equal(runtime.pendingModelChangeTimeline, undefined);

  runtime.recordPendingModelChange({ fromModel: modelA, toModel: modelB, toModelLabel: "B" });
  const consumed = getRuntimeModelChangeTimelinePort(runtime).consumePendingModelChangeTimeline();
  assert.equal(consumed.toModel.modelId, "model-b");
  assert.equal(runtime.pendingModelChangeTimeline, undefined);
  assert.throws(() => {
    runtime.pendingModelChangeTimeline = consumed;
  }, TypeError);
});

test("CLI-05 I4: plan exit reminder is armed once and consumed atomically", () => {
  const runtime = {};
  initializeRuntimeLifecycle(runtime);
  const port = getRuntimeLifecyclePort(runtime);

  assert.equal(runtime.needsPlanModeExitReminder, false);
  port.armPlanModeExitReminder();
  port.armPlanModeExitReminder();
  assert.equal(runtime.needsPlanModeExitReminder, true);
  assert.deepEqual(
    [port.consumePlanModeExitReminder(), port.consumePlanModeExitReminder()],
    [true, false],
  );
  assert.equal(runtime.needsPlanModeExitReminder, false);

  // 新的 plan → off 转换可以再次 arm；消费期间重复 arm 仍只有一个 pending token。
  port.armPlanModeExitReminder();
  assert.equal(port.consumePlanModeExitReminder(), true);
  assert.equal(port.consumePlanModeExitReminder(), false);

  assert.throws(() => {
    runtime.needsPlanModeExitReminder = true;
  }, TypeError);
  assert.throws(
    () => Object.defineProperty(runtime, "needsPlanModeExitReminder", { value: true }),
    TypeError,
  );
  assert.throws(() => {
    port.armPlanModeExitReminder = () => {};
  }, TypeError);
});

test("CLI-05 I4: only a committed plan → off transition arms the real runtime reminder", async (t) => {
  const { runtime } = await fixture(t);
  const port = getRuntimeLifecyclePort(runtime);

  // off → on 与重复 off 不会 arm。
  runtime.updateConfig({ planEnabled: true });
  assert.equal(port.consumePlanModeExitReminder(), false);
  runtime.updateConfig({ planEnabled: false });
  assert.equal(runtime.needsPlanModeExitReminder, true);
  assert.equal(port.consumePlanModeExitReminder(), true);
  runtime.updateConfig({ planEnabled: false });
  runtime.updateConfig({ mode: "build" });
  assert.equal(port.consumePlanModeExitReminder(), false);

  // 第二个真实 plan → off 转换可以重新 arm。
  runtime.updateConfig({ planEnabled: true });
  runtime.updateConfig({ planEnabled: false });
  assert.equal(port.consumePlanModeExitReminder(), true);
});

test("CLI-05 I4: real AgentRuntime consumes the title attempt only after eligibility", async (t) => {
  const { runtime } = await fixture(t, { titleGeneration: { enabled: true } });
  const port = getRuntimeLifecyclePort(runtime);

  assert.equal(runtime.sessionTitleGenerationAttempted, false);
  assert.equal(maybeStartSessionTitleGeneration.call(runtime, "hi", undefined, trace), false);
  assert.equal(runtime.sessionTitleGenerationAttempted, false);
  runtime.maybeStartSessionTitleGenerationFromExternalInput(
    "Describe the runtime state ownership boundary",
    { traceContext: trace },
  );
  assert.equal(runtime.sessionTitleGenerationAttempted, true);
  assert.equal(port.consumeSessionTitleGenerationAttempted(), false);
  runtime.maybeStartSessionTitleGenerationFromExternalInput("A second eligible title seed", {
    traceContext: trace,
  });
  assert.equal(runtime.sessionTitleGenerationAttempted, true);
  await setImmediate();
});

test("CLI-05 I4: concurrent session-start calls share one in-flight claim", async (t) => {
  const { runtime } = await fixture(t);
  const entered = deferred();
  const release = deferred();
  let activateCalls = 0;
  let hookCalls = 0;
  runtime.workspaceHookAdmission = {
    activate: async () => {
      activateCalls += 1;
      entered.resolve();
      await release.promise;
    },
  };
  runtime.hookRunner = {
    run: async () => {
      hookCalls += 1;
      return { additionalContexts: [] };
    },
  };

  const first = runtime.runSessionStartHooks("startup", trace);
  await entered.promise;
  const second = runtime.runSessionStartHooks("resume", trace);
  assert.deepEqual(await second, { additionalContexts: [] });
  assert.equal(activateCalls, 1);
  assert.equal(runtime.sessionStartHookRan, false);

  release.resolve();
  assert.deepEqual(await first, { additionalContexts: [] });
  assert.equal(activateCalls, 1);
  assert.equal(hookCalls, 1);
  assert.equal(runtime.sessionStartHookRan, true);
  assert.deepEqual(await runtime.runSessionStartHooks("clear", trace), {
    additionalContexts: [],
  });
  assert.equal(activateCalls, 1);
  assert.equal(hookCalls, 1);
});

test("CLI-05 I4: failed session-start activation releases the claim for retry", async (t) => {
  const { runtime } = await fixture(t);
  let activateCalls = 0;
  let hookCalls = 0;
  runtime.workspaceHookAdmission = {
    activate: async () => {
      activateCalls += 1;
      if (activateCalls === 1) throw new Error("activation failed");
    },
  };
  runtime.hookRunner = {
    run: async () => {
      hookCalls += 1;
      return { additionalContexts: [] };
    },
  };

  await assert.rejects(runtime.runSessionStartHooks("startup", trace), /activation failed/);
  assert.equal(runtime.sessionStartHookRan, false);
  assert.deepEqual(await runtime.runSessionStartHooks("startup", trace), {
    additionalContexts: [],
  });
  assert.equal(activateCalls, 2);
  assert.equal(hookCalls, 1);
  assert.equal(runtime.sessionStartHookRan, true);
});

test("CLI-05: real runtime exposes non-writable, non-replaceable state getters", async (t) => {
  const { runtime } = await fixture(t);
  for (const [field, value] of [
    ["activeTurnStartReservation", { kind: "regular", traceContext: trace, turnId: "turn_bad" }],
    ["branchGeneration", 100],
    ["runtimeCommandDrainActive", true],
    ["needsPlanModeExitReminder", true],
    ["sessionStartHookRan", true],
    ["shuttingDown", true],
    ["permissionFullAccessPending", true],
    ["lastPermissionGrantId", "grant_bad"],
    ["pendingModelChangeTimeline", { requestId: "req_bad" }],
  ]) {
    assert.throws(() => {
      runtime[field] = value;
    }, TypeError);
    assert.throws(() => Object.defineProperty(runtime, field, { value }), TypeError);
    const descriptor = Object.getOwnPropertyDescriptor(runtime, field);
    assert.equal(descriptor.set, undefined);
    assert.equal(descriptor.configurable, false);
  }
  runtime.reserveTurnStart("turn_owned", trace, "regular");
  assert.throws(() => {
    runtime.activeTurnStartReservation.turnId = "turn_bad";
  }, TypeError);
  runtime.releaseTurnStart("turn_bad");
  assert.equal(runtime.activeTurnStartReservation.turnId, "turn_owned");
  runtime.releaseTurnStart("turn_owned");
  assert.equal(runtime.activeTurnStartReservation, undefined);
});

test("CLI-05: admission reserves synchronously and cancellation releases only its accepted turn", async (t) => {
  const { runtime } = await fixture(t);
  // 暂停实际执行调度，观察真实 admission 在首次 await 前的预约与 queued command 取消。
  const enqueue = runtime.enqueueRuntimeCommand;
  runtime.enqueueRuntimeCommand = (command) => runtime.runtimeCommandQueue.enqueue(command);
  const controller = new AbortController();
  const [first, second] = await Promise.all([
    runtime.admitPrompt("first", undefined, { abortSignal: controller.signal, requireIdle: true }),
    runtime.admitPrompt("second", undefined, { requireIdle: true }),
  ]);
  assert.equal(first.kind, "started");
  assert.equal(second.kind, "rejected");
  assert.equal(runtime.activeTurnStartReservation.turnId, first.turnId);
  assert.equal(runtime.runtimeCommandQueue.size(), 1);
  controller.abort(new Error("cancel fixture"));
  await assert.rejects(first.completion);
  assert.equal(runtime.activeTurnStartReservation, undefined);
  assert.equal(runtime.runtimeCommandQueue.size(), 0);
  runtime.enqueueRuntimeCommand = enqueue;

  // 只替换模型 turn 边界；admission、command FIFO、reservation 及取消均为产品实现。
  runtime.executeTurnCommand = async (_input, _attachments, _options, reservation) => {
    const active = runtime.beginActiveTurn(reservation.turnId, trace, "regular", true);
    runtime.finishActiveTurn(active);
    return { response: "accepted after cancellation", traceId: trace.traceId };
  };
  const next = await runtime.admitPrompt("next", undefined, { requireIdle: true });
  assert.equal(next.kind, "started");
  assert.equal((await next.completion).response, "accepted after cancellation");
  await setImmediate();
  assert.equal(runtime.hasActiveOrQueuedTurnWork(), false);
});

test("CLI-05: real command drain cannot reenter during await and resumes FIFO after release", async (t) => {
  const { runtime } = await fixture(t);
  const entered = deferred();
  const gate = deferred();
  const inputs = [];
  runtime.executeTurnCommand = async (input) => {
    inputs.push(input);
    if (input === "first") {
      entered.resolve();
      await gate.promise;
    }
    return { response: input, traceId: trace.traceId };
  };
  const first = runtime.executeTurn("first");
  await entered.promise;
  const second = runtime.executeTurn("second");
  assert.equal(runtime.runtimeCommandDrainActive, true);
  await Promise.all([runtime.drainRuntimeCommandQueue(), runtime.drainRuntimeCommandQueue()]);
  assert.deepEqual(inputs, ["first"]);
  assert.equal(runtime.runtimeCommandQueue.size(), 1);
  gate.resolve();
  assert.deepEqual(
    (await Promise.all([first, second])).map((result) => result.response),
    ["first", "second"],
  );
  await setImmediate();
  assert.equal(runtime.runtimeCommandDrainActive, false);
  assert.equal(runtime.runtimeCommandQueue.size(), 0);
});

test("CLI-05: a late release from an old drain lease cannot revoke a newer lease", async (t) => {
  const { runtime } = await fixture(t);
  const port = getRuntimeCommandDrainPort(runtime);
  const old = port.tryAcquire();
  assert.equal(port.tryAcquire(), null);
  old.release();
  const current = port.tryAcquire();
  old.release();
  assert.equal(runtime.runtimeCommandDrainActive, true);
  assert.equal(port.tryAcquire(), null);
  current.release();
  assert.equal(runtime.runtimeCommandDrainActive, false);
});

test("CLI-05: real resume restores the branch owner and old task terminal stays observable", async (t) => {
  const { runtime, store } = await fixture(t);
  await store.setRevert({
    sessionID: trace.sessionId,
    revert: { branchGeneration: 3, messageID: "msg_restore" },
  });
  await runtime.resumeFromStore();
  assert.equal(runtime.branchGeneration, 3);
  runtime.runtimeTaskRegistry.register({
    branchGeneration: 1,
    description: "old worker",
    startedAt: new Date(),
    status: "completed",
    taskId: "task_state_owner",
    type: "local_agent",
  });
  assert.equal(isStaleBranchRuntimeCommand(runtime, notification(1)), true);
  assert.equal(
    (await runtime.runtimeTaskRegistry.waitForTerminal("task_state_owner")).status,
    "completed",
  );
  await store.setRevert({
    sessionID: trace.sessionId,
    revert: { branchGeneration: 1, messageID: "msg_old_restore" },
  });
  await assert.rejects(runtime.resumeFromStore(), /restore branch snapshot is stale/);
  assert.equal(runtime.branchGeneration, 3);
  assert.equal(isStaleBranchRuntimeCommand(runtime, notification(1)), true);
});

test("CLI-05: real conversation rewind persists before the owner advances and fences old notifications", async (t) => {
  const { runtime, store } = await fixture(t);
  await store.saveMessage({
    id: "msg_rewind_user",
    role: "user",
    sessionID: trace.sessionId,
    time: { created: Date.now() },
  });
  const persistRevert = store.setRevert.bind(store);
  const gate = deferred();
  const entered = deferred();
  store.setRevert = async (input) => {
    entered.resolve();
    await gate.promise;
    return persistRevert(input);
  };
  const rewind = runtime.rewindConversationToMessage({
    events: [],
    targetMessageId: "msg_rewind_user",
    traceContext: trace,
  });
  await entered.promise;
  assert.equal(runtime.branchGeneration, 0);
  gate.resolve();
  await rewind;
  assert.equal(runtime.branchGeneration, 1);
  assert.equal((await store.getSession(trace.sessionId)).revert.branchGeneration, 1);
  runtime.runtimeTaskRegistry.register({
    description: "new worker",
    startedAt: new Date(),
    status: "running",
    taskId: "task_new_generation",
    type: "local_agent",
  });
  assert.equal(runtime.runtimeTaskRegistry.get("task_new_generation").branchGeneration, 1);
  assert.equal(isStaleBranchRuntimeCommand(runtime, notification(0)), true);
  assert.equal(isStaleBranchRuntimeCommand(runtime, notification(1)), false);
});

test("CLI-05: parallel real rewinds reject the obsolete plan before its persistence callback", async (t) => {
  const { runtime, store } = await fixture(t);
  await store.saveMessage({
    id: "msg_parallel_rewind",
    role: "user",
    sessionID: trace.sessionId,
    time: { created: Date.now() },
  });
  const gate = deferred();
  const entered = deferred();
  const persist = store.setRevert.bind(store);
  let writes = 0;
  store.setRevert = async (input) => {
    writes += 1;
    entered.resolve();
    await gate.promise;
    return persist(input);
  };
  const runRewind = () =>
    runtime.rewindConversationToMessage({
      events: [],
      targetMessageId: "msg_parallel_rewind",
      traceContext: trace,
    });
  const first = runRewind();
  await entered.promise;
  const second = runRewind();
  // 第二条异步计划已经读到同一代；持久化回调仍被第一条 branch write 授权挡住。
  await setImmediate();
  gate.resolve();
  const results = await Promise.allSettled([first, second]);
  assert.equal(results[0].status, "fulfilled");
  assert.equal(results[1].status, "rejected");
  assert.match(results[1].reason.message, /branch transition is stale/);
  assert.equal(writes, 1);
  assert.equal(runtime.branchGeneration, 1);
  assert.equal((await store.getSession(trace.sessionId)).revert.branchGeneration, 1);
});

test("CLI-05: concurrent branch restore waits for in-flight persistence and never rewrites its generation", async (t) => {
  const { runtime, session } = await fixture(t);
  const port = getRuntimeBranchRestorePort(runtime);
  const gate = deferred();
  const entered = deferred();
  const transition = port.prepareRewind(session);
  const commit = transition.commitAfterPersist(async () => {
    entered.resolve();
    await gate.promise;
  });
  await entered.promise;
  const restore = port.restoreFromSession({ revert: { branchGeneration: 5 } });
  assert.equal(runtime.branchGeneration, 0);
  gate.resolve();
  assert.equal(await commit, true);
  assert.equal(await restore, 5);
  assert.equal(runtime.branchGeneration, 5);
});

test("CLI-05: stale or repeated branch transition cannot write a restored newer branch", async (t) => {
  const { runtime, session } = await fixture(t);
  const port = getRuntimeBranchRestorePort(runtime);
  const old = port.prepareRewind(session);
  await port.restoreFromSession({ revert: { branchGeneration: 5 } });
  assert.equal(
    await old.commitAfterPersist(async () => assert.fail("stale transition must not write")),
    false,
  );
  const current = port.prepareRewind({ revert: { branchGeneration: 5 } });
  assert.equal(current.generation, 6);
  assert.equal(runtime.branchGeneration, 5);
  assert.equal(await current.commitAfterPersist(async () => {}), true);
  assert.equal(
    await current.commitAfterPersist(async () =>
      assert.fail("duplicate transition must not write"),
    ),
    false,
  );
  assert.equal(runtime.branchGeneration, 6);
});

test("CLI-05: TypeScript rejects direct state writers on AgentRuntimeInternal", () => {
  const coreDir = fileURLToPath(new URL("../packages/core/", import.meta.url));
  const virtualPath = join(coreDir, "src/runtime/non-owner-negative-check.mts");
  const source = `import type { AgentRuntimeInternal } from "./internal.js";
declare const runtime: AgentRuntimeInternal;
const readableGeneration: number = runtime.branchGeneration;
const reservation = runtime.activeTurnStartReservation;
runtime.branchGeneration = readableGeneration + 1;
runtime.runtimeCommandDrainActive = false;
runtime.activeTurnStartReservation = undefined;
runtime.sessionModelSelection = undefined;
runtime.sessionPersisted = false;
runtime.shuttingDown = false;
runtime.permissionFullAccessPending = true;
runtime.lastPermissionGrantId = "grant_bad";
runtime.pendingModelChangeTimeline = undefined;
if (reservation) reservation.turnId = reservation.turnId;
runtime.setBranchGeneration(4);
`;
  const configPath = join(coreDir, "tsconfig.json");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath));
  const options = { ...parsed.options, noEmit: true };
  const host = ts.createCompilerHost(options);
  const originalRead = host.readFile.bind(host);
  const originalExists = host.fileExists.bind(host);
  const originalGetSource = host.getSourceFile.bind(host);
  const matchesVirtual = (path) =>
    path.replaceAll("\\", "/").toLowerCase() === virtualPath.replaceAll("\\", "/").toLowerCase();
  host.readFile = (path) => (matchesVirtual(path) ? source : originalRead(path));
  host.fileExists = (path) => matchesVirtual(path) || originalExists(path);
  host.getSourceFile = (path, languageVersion, onError, shouldCreateNewSourceFile) =>
    matchesVirtual(path)
      ? ts.createSourceFile(path, source, languageVersion, true)
      : originalGetSource(path, languageVersion, onError, shouldCreateNewSourceFile);
  const program = ts.createProgram([virtualPath], options, host);
  const input = program.getSourceFile(virtualPath);
  assert.ok(input, "TypeScript 必须真正读取负例文件，不能把空 program 当作通过");
  const diagnostics = [
    ...program.getSyntacticDiagnostics(input),
    ...program.getSemanticDiagnostics(input),
  ];
  const detail = diagnostics
    .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))
    .join("\n");
  assert.equal(diagnostics.length, 11, detail);
  assert.equal(diagnostics.filter((diagnostic) => diagnostic.code === 2540).length, 10, detail);
  // TS 有拼写建议时用 2551、没有时用 2339；两者都必须真正拒绝不存在的任意 setter。
  assert.equal(
    diagnostics.filter((diagnostic) => diagnostic.code === 2339 || diagnostic.code === 2551).length,
    1,
    detail,
  );
  assert.match(detail, /Property 'setBranchGeneration' does not exist/);
});
