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
const { getRuntimeTurnTimingPort } = await import(
  "../packages/core/src/runtime/runtime-turn-timing.ts"
);
const {
  getRuntimeCacheDiagnosticsPort,
  initializeRuntimeCacheDiagnostics,
} = await import("../packages/core/src/runtime/runtime-cache-diagnostics.ts");
const {
  getRuntimeForegroundExecutionPort,
  initializeRuntimeForegroundExecution,
} = await import("../packages/core/src/runtime/runtime-foreground-execution.ts");
const {
  getRuntimeMessageProjectionPort,
  initializeRuntimeMessageProjection,
} = await import("../packages/core/src/runtime/runtime-message-projection.ts");
const {
  getRuntimeContextInitPort,
  initializeRuntimeContextInit,
} = await import("../packages/core/src/runtime/runtime-context-init.ts");
const {
  getRuntimeMcpLifecyclePort,
  initializeRuntimeMcpLifecycle,
} = await import("../packages/core/src/runtime/runtime-mcp-lifecycle.ts");
const { getRuntimeToolCachePort, initializeRuntimeToolCache } = await import(
  "../packages/core/src/runtime/runtime-tool-cache.ts"
);
const { getRuntimeSidecarPort, initializeRuntimeSidecar } = await import(
  "../packages/core/src/runtime/runtime-sidecar.ts"
);
const { trackResidencyBlockingWork } = await import(
  "../packages/core/src/runtime/methods/residency.ts"
);
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
    // CLI-05 P1 第一切片：turn 时序字段收敛到 RuntimeTurnTimingOwner，同样只读不可替换。
    ["turnNumber", 999],
    ["activeTurn", { turnId: "turn_bad", kind: "regular", pendingInputs: [], steerable: true }],
    ["pendingInputSequence", 999],
    ["pendingInputReservations", new Map()],
    ["pendingInputDrains", 5],
    ["queueAutoDrain", false],
    ["queueExternalDrainActive", true],
    // R1-01 B1：cache 诊断 6 字段收敛到 RuntimeCacheDiagnosticsOwner，同样只读不可替换。
    [
      "mainTurnCacheHitAggregate",
      { requestCount: 0, totalInputTokens: 0, totalCacheReadTokens: 0, totalCacheWriteTokens: 0 },
    ],
    ["pendingCacheMissCause", "compaction"],
    ["cacheMissCauseCounts", { compaction: 5 }],
    ["autoCompactConsecutiveFailures", 5],
    ["lastRequestModelId", "model_bad"],
    ["lastAssistantCompletedAtMs", 12345],
    // R1-01 B2：TurnState 剩余 4 字段收敛——前 3 个归 RuntimeForegroundExecutionOwner
    // 只读 getter；runtimeCommandQueue 是构造期不可写数据属性（零 method 写点）。
    [
      "activeForegroundExecution",
      {
        controller: new AbortController(),
        disposeParentAbort: () => {},
        foregroundExecutionId: "exec_bad",
        preserveQueueAutoDrainOnCancel: false,
      },
    ],
    ["foregroundPromotionLease", { leaseId: "lease_bad", promotedInputId: "input_bad" }],
    ["currentTurnFileChanges", new Map()],
    ["runtimeCommandQueue", { enqueue: () => {} }],
    // R1-01 B3：MessageProjection 4 字段收敛到 RuntimeMessageProjectionOwner，同样只读不可替换。
    ["latestConversationMessageId", "msg_bad"],
    ["latestAssistantMessageId", "msg_bad"],
    ["latestAssistantTurnId", "turn_bad"],
    ["lastEmittedLocalDate", "2026-10-28"],
    // R1-01 B4：ContextMemory 19 字段收敛——18 个归 4 个子 owner 只读 getter；
    // readFileState 是构造期不可写数据属性（零 method 重赋值，同 runtimeCommandQueue 先例）。
    ["messageHistory", { addUser: () => {} }],
    ["readFileState", new Map()],
    ["cachedTools", []],
    ["toolSearchContext", {}],
    ["contextBuilder", null],
    ["contextInitialized", true],
    ["contextSourceSnapshot", {}],
    ["latestContextBuildResult", {}],
    ["memoryRoot", "mem_bad"],
    ["memoryIndexContent", "index_bad"],
    ["promptFileRouting", {}],
    ["memoryExtractionScheduler", { schedule: () => {} }],
    ["memorySemanticRecallChannel", {}],
    ["mcpStartupPromise", Promise.resolve({ statuses: {}, tools: [] })],
    ["mcpInitializationPromise", Promise.resolve()],
    ["mcpInitialized", true],
    ["mcpToolsRegistered", true],
    ["skillLoadOutcome", { skills: [], diagnostics: [], totalDiscovered: 0 }],
    ["residencyBlockingWorkCount", 5],
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

test("CLI-05 P1: turn timing fields are owned by a finite write port, not the flat `this` surface", async (t) => {
  const { runtime } = await fixture(t);
  const port = getRuntimeTurnTimingPort(runtime);

  // turnNumber：只经端口推进/重建；读面 getter 反映 owner 真值。
  assert.equal(runtime.turnNumber, 0);
  port.advanceTurn();
  assert.equal(runtime.turnNumber, 1);
  port.setTurnNumber(7);
  assert.equal(runtime.turnNumber, 7);

  // activeTurn：set/clear，clear 是安全 no-op。
  assert.equal(runtime.activeTurn, undefined);
  const activeTurn = { turnId: "turn_timing", kind: "regular", pendingInputs: [], steerable: true };
  port.setActiveTurn(activeTurn);
  assert.equal(runtime.activeTurn, activeTurn);
  port.clearActiveTurn();
  assert.equal(runtime.activeTurn, undefined);
  port.clearActiveTurn();

  // pendingInputSequence：自增铸造。
  assert.equal(port.nextPendingInputSequence(), 1);
  assert.equal(runtime.pendingInputSequence, 1);
  assert.equal(port.nextPendingInputSequence(), 2);

  // pendingInputReservations：reserve/release，读面（size/has/get）不变。
  assert.equal(runtime.pendingInputReservations.size, 0);
  port.reservePendingInput("pending_a", "res_a");
  assert.equal(runtime.pendingInputReservations.get("pending_a"), "res_a");
  assert.equal(runtime.pendingInputReservations.has("pending_a"), true);
  port.releasePendingInputReservation("pending_a");
  assert.equal(runtime.pendingInputReservations.size, 0);
  // 缺键 release 是 no-op。
  port.releasePendingInputReservation("pending_missing");

  // pendingInputDrains：begin/end 配对；无 in-flight 时读面为 undefined（迁移前语义）。
  assert.equal(runtime.pendingInputDrains, undefined);
  port.beginPendingInputDrain();
  assert.equal(runtime.pendingInputDrains, 1);
  port.beginPendingInputDrain();
  assert.equal(runtime.pendingInputDrains, 2);
  port.endPendingInputDrain();
  port.endPendingInputDrain();
  assert.equal(runtime.pendingInputDrains, undefined);

  // queueAutoDrain：默认 true；暂停关闭 autoDrain + 外层窗口；恢复重开外层窗口。
  assert.equal(runtime.queueAutoDrain, true);
  assert.equal(runtime.queueExternalDrainActive, false);
  port.pauseQueueAutoDrain();
  assert.equal(runtime.queueAutoDrain, false);
  assert.equal(runtime.queueExternalDrainActive, false);
  // false → true：用户从暂停队列恢复，打开外层 FIFO 提升窗口（原 setQueueAutoDrain 语义）。
  port.applyQueueAutoDrainChange(true);
  assert.equal(runtime.queueAutoDrain, true);
  assert.equal(runtime.queueExternalDrainActive, true);
  port.completeExternalQueueDrain();
  assert.equal(runtime.queueExternalDrainActive, false);
  // true → true：不重新打开外层窗口（原 `if (autoDrain && !queueAutoDrain)` 分支不命中）。
  port.applyQueueAutoDrainChange(true);
  assert.equal(runtime.queueExternalDrainActive, false);
  // → false：关闭窗口。
  port.applyQueueAutoDrainChange(false);
  assert.equal(runtime.queueAutoDrain, false);
  assert.equal(runtime.queueExternalDrainActive, false);

  // 端口冻结：不能替换写方法。
  assert.throws(() => {
    port.advanceTurn = () => {};
  }, TypeError);
});

test("R1-01 B1: cache diagnostics fields are owned by a finite write port, not the flat `this` surface", async (t) => {
  const { runtime } = await fixture(t);
  const port = getRuntimeCacheDiagnosticsPort(runtime);

  // 初始值（迁移前 agent-runtime.ts 的字段初始化字面量等价）。
  assert.deepEqual(runtime.mainTurnCacheHitAggregate, {
    requestCount: 0,
    totalInputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
  });
  assert.equal(runtime.pendingCacheMissCause, undefined);
  assert.deepEqual(runtime.cacheMissCauseCounts, {});
  assert.equal(runtime.autoCompactConsecutiveFailures, 0);
  assert.equal(runtime.lastRequestModelId, undefined);
  assert.equal(runtime.lastAssistantCompletedAtMs, undefined);

  // recordAssistantCompleted：推进 assistant 完成时间戳（归因 idle_ttl_suspected 输入）。
  port.recordAssistantCompleted(1000);
  assert.equal(runtime.lastAssistantCompletedAtMs, 1000);

  // recordMainTurnUsage：原子累计 aggregate + 消费 pending + 更新 lastRequestModelId。
  port.setPendingCacheMissCause("compaction");
  assert.equal(runtime.pendingCacheMissCause, "compaction");
  const first = port.recordMainTurnUsage({
    inputTokens: 100,
    cacheReadTokens: 0,
    cacheWriteTokens: 20,
    isMiss: true,
    cause: "compaction",
    modelId: "model_a",
  });
  assert.equal(runtime.mainTurnCacheHitAggregate.requestCount, 1);
  assert.equal(runtime.mainTurnCacheHitAggregate.totalInputTokens, 100);
  assert.equal(runtime.mainTurnCacheHitAggregate.totalCacheReadTokens, 0);
  assert.equal(runtime.mainTurnCacheHitAggregate.totalCacheWriteTokens, 20);
  // pending 消费即清（无论命中或 miss）。
  assert.equal(runtime.pendingCacheMissCause, undefined);
  // miss 计数累计。
  assert.deepEqual(runtime.cacheMissCauseCounts, { compaction: 1 });
  assert.deepEqual(first.missCauses, { compaction: 1 });
  // lastRequestModelId 更新。
  assert.equal(runtime.lastRequestModelId, "model_a");
  // lastAssistantCompletedAtMs 不被 recordMainTurnUsage 触碰（由 recordAssistantCompleted 负责）。
  assert.equal(runtime.lastAssistantCompletedAtMs, 1000);

  // 第二次命中：isMiss=false，cause 不累计，但 aggregate 仍累计、pending 仍清空。
  port.setPendingCacheMissCause("context_refresh");
  const second = port.recordMainTurnUsage({
    inputTokens: 200,
    cacheReadTokens: 150,
    cacheWriteTokens: 0,
    isMiss: false,
    modelId: "model_b",
  });
  assert.equal(runtime.mainTurnCacheHitAggregate.requestCount, 2);
  assert.equal(runtime.mainTurnCacheHitAggregate.totalInputTokens, 300);
  assert.equal(runtime.mainTurnCacheHitAggregate.totalCacheReadTokens, 150);
  assert.deepEqual(runtime.cacheMissCauseCounts, { compaction: 1 });
  assert.equal(runtime.pendingCacheMissCause, undefined);
  assert.equal(runtime.lastRequestModelId, "model_b");
  assert.deepEqual(second.missCauses, { compaction: 1 });

  // miss-cause 归因优先级（resolveCacheMissCause 读取的 3 个 peek 端口语义）。
  port.setPendingCacheMissCause("control_only_turn");
  assert.equal(port.peekPendingCacheMissCause(), "control_only_turn");
  assert.equal(port.peekLastRequestModelId(), "model_b");
  assert.equal(port.peekLastAssistantCompletedAtMs(), 1000);

  // consumePendingCacheMissCause：原子「读 + 清」。
  assert.equal(port.consumePendingCacheMissCause(), "control_only_turn");
  assert.equal(runtime.pendingCacheMissCause, undefined);
  assert.equal(port.consumePendingCacheMissCause(), undefined);

  // recordAutoCompactFailure：原子 ++ 并返回新值（用于日志）。
  assert.equal(port.recordAutoCompactFailure(), 1);
  assert.equal(runtime.autoCompactConsecutiveFailures, 1);
  assert.equal(port.recordAutoCompactFailure(), 2);
  assert.equal(runtime.autoCompactConsecutiveFailures, 2);
  // resetAutoCompactFailures：成功路径 reset 0。
  port.resetAutoCompactFailures();
  assert.equal(runtime.autoCompactConsecutiveFailures, 0);

  // resume/rewind 重建端口：聚合重置 + 计数清空 + pending 清空 + 时间戳恢复。
  port.setPendingCacheMissCause("conversation_rewind");
  port.recordMainTurnUsage({
    inputTokens: 50,
    cacheReadTokens: 0,
    cacheWriteTokens: 10,
    isMiss: true,
    cause: "conversation_rewind",
  });
  assert.deepEqual(runtime.cacheMissCauseCounts, { compaction: 1, conversation_rewind: 1 });
  port.resetMainTurnCacheHitAggregate({
    requestCount: 5,
    totalInputTokens: 500,
    totalCacheReadTokens: 400,
    totalCacheWriteTokens: 50,
  });
  port.resetCacheMissCauseCounts();
  port.clearPendingCacheMissCause();
  port.restoreLastAssistantCompletedAtMs(2000);
  assert.equal(runtime.mainTurnCacheHitAggregate.requestCount, 5);
  assert.deepEqual(runtime.cacheMissCauseCounts, {});
  assert.equal(runtime.pendingCacheMissCause, undefined);
  assert.equal(runtime.lastAssistantCompletedAtMs, 2000);

  // restoreLastAssistantCompletedAtMs(undefined)：rewind 到无 assistant 消息的状态。
  port.restoreLastAssistantCompletedAtMs(undefined);
  assert.equal(runtime.lastAssistantCompletedAtMs, undefined);

  // 端口冻结：不能替换写方法。
  assert.throws(() => {
    port.recordMainTurnUsage = () => ({ aggregate: {} });
  }, TypeError);
  assert.throws(() => {
    port.recordAutoCompactFailure = () => 0;
  }, TypeError);

  // 重复初始化是幂等 no-op（owners.has 短路）：重新初始化不会重置已有计数。
  port.recordAutoCompactFailure();
  initializeRuntimeCacheDiagnostics(runtime);
  assert.equal(runtime.autoCompactConsecutiveFailures, 1);
});

test("R1-01 B2: foreground execution fields are owned by a finite write port, not the flat `this` surface", async (t) => {
  const { runtime } = await fixture(t);
  const port = getRuntimeForegroundExecutionPort(runtime);

  // 初始值（迁移前 agent-runtime.ts 的字段初始化等价）。
  assert.equal(runtime.activeForegroundExecution, undefined);
  assert.equal(runtime.foregroundPromotionLease, undefined);
  assert.ok(runtime.currentTurnFileChanges instanceof Map);
  assert.equal(runtime.currentTurnFileChanges.size, 0);

  // beginForegroundExecution：owner 持有 state；引用不冻结——
  // stopActiveForegroundExecution 的 preserveQueueAutoDrainOnCancel 容器内写保留
  // （与 activeTurn.pendingInputs 原地 splice 同先例）。
  const state = {
    controller: new AbortController(),
    disposeParentAbort: () => {},
    foregroundExecutionId: "exec_1",
    preserveQueueAutoDrainOnCancel: false,
  };
  port.beginForegroundExecution(state);
  assert.equal(runtime.activeForegroundExecution, state);
  state.preserveQueueAutoDrainOnCancel = true;
  assert.equal(runtime.activeForegroundExecution.preserveQueueAutoDrainOnCancel, true);

  // finishForegroundExecution：identity 不匹配是 no-op，命中才清除。
  const stranger = { ...state, foregroundExecutionId: "exec_stranger" };
  port.finishForegroundExecution(stranger);
  assert.equal(runtime.activeForegroundExecution, state);
  port.finishForegroundExecution(state);
  assert.equal(runtime.activeForegroundExecution, undefined);

  // commitPromotionLease：owner 唯一写点；入库浅冻结，读面不能反向改写。
  port.commitPromotionLease({ leaseId: "lease_a", promotedInputId: "input_a" });
  assert.deepEqual(runtime.foregroundPromotionLease, {
    leaseId: "lease_a",
    promotedInputId: "input_a",
  });
  assert.throws(() => {
    runtime.foregroundPromotionLease.promotedInputId = "input_bad";
  }, TypeError);

  // releasePromotionLease：leaseId 不匹配返回 false 且 lease 保持；命中清除返回 true。
  assert.equal(port.releasePromotionLease("lease_bad"), false);
  assert.equal(runtime.foregroundPromotionLease?.leaseId, "lease_a");
  assert.equal(port.releasePromotionLease("lease_a"), true);
  assert.equal(runtime.foregroundPromotionLease, undefined);
  // 无 lease 时释放是安全 no-op。
  assert.equal(port.releasePromotionLease("lease_a"), false);

  // consumePromotionLease：出队 promoted command 成功后的同步消费点。
  port.commitPromotionLease({ leaseId: "lease_b", promotedInputId: "input_b" });
  port.consumePromotionLease();
  assert.equal(runtime.foregroundPromotionLease, undefined);

  // resetTurnFileChanges：整体替换为新空 Map（identity 变化），旧 Map 内容写不受影响。
  const oldMap = runtime.currentTurnFileChanges;
  oldMap.set("file.ts", { path: "file.ts" });
  port.resetTurnFileChanges();
  assert.notEqual(runtime.currentTurnFileChanges, oldMap);
  assert.equal(runtime.currentTurnFileChanges.size, 0);
  assert.equal(oldMap.size, 1);
  // 新 Map 内容写保留（recordTurnFileChange 的容器内写不经端口）。
  runtime.currentTurnFileChanges.set("other.ts", { path: "other.ts" });
  assert.equal(runtime.currentTurnFileChanges.size, 1);

  // 端口冻结：不能替换写方法。
  assert.throws(() => {
    port.beginForegroundExecution = () => {};
  }, TypeError);
  assert.throws(() => {
    port.releasePromotionLease = () => true;
  }, TypeError);

  // 重复初始化是幂等 no-op（owners.has 短路）：重新初始化不重置已有状态。
  port.commitPromotionLease({ leaseId: "lease_c", promotedInputId: "input_c" });
  initializeRuntimeForegroundExecution(runtime);
  assert.equal(runtime.foregroundPromotionLease?.leaseId, "lease_c");
});

test("R1-01 B3: message projection fields are owned by a finite write port, not the flat `this` surface", async (t) => {
  const { runtime } = await fixture(t);
  const port = getRuntimeMessageProjectionPort(runtime);

  // 初始值（迁移前 agent-runtime.ts 的 optional 字段缺省 undefined 等价）。
  assert.equal(runtime.latestConversationMessageId, undefined);
  assert.equal(runtime.latestAssistantMessageId, undefined);
  assert.equal(runtime.latestAssistantTurnId, undefined);
  assert.equal(runtime.lastEmittedLocalDate, undefined);

  // recordConversationMessage：推进会话游标（user prompt / synthetic notice /
  // compact summary / workflow launch 四处写点共用同一语义）。
  port.recordConversationMessage("msg_user_1");
  assert.equal(runtime.latestConversationMessageId, "msg_user_1");
  assert.equal(runtime.latestAssistantMessageId, undefined);
  assert.equal(runtime.latestAssistantTurnId, undefined);

  // recordAssistantMessage：会话与 assistant 游标同步推进；无 turnId 不动 turn 游标。
  port.recordAssistantMessage("msg_asst_1");
  assert.equal(runtime.latestConversationMessageId, "msg_asst_1");
  assert.equal(runtime.latestAssistantMessageId, "msg_asst_1");
  assert.equal(runtime.latestAssistantTurnId, undefined);
  // 有 turnId 时三游标同时推进。
  port.recordAssistantMessage("msg_asst_2", "turn_1");
  assert.equal(runtime.latestConversationMessageId, "msg_asst_2");
  assert.equal(runtime.latestAssistantMessageId, "msg_asst_2");
  assert.equal(runtime.latestAssistantTurnId, "turn_1");

  // restoreFromPersistenceAnchor：identity 前置条件与恢复同一事务——
  // 游标仍指向被回滚消息才恢复（turn-stop 持久化失败回滚语义）。
  const anchor = {
    latestConversationMessageId: "msg_anchor_conv",
    latestAssistantMessageId: "msg_anchor_asst",
    latestAssistantTurnId: "turn_anchor",
  };
  // 未命中：零恢复。
  port.restoreFromPersistenceAnchor("msg_stranger", anchor);
  assert.equal(runtime.latestConversationMessageId, "msg_asst_2");
  assert.equal(runtime.latestAssistantMessageId, "msg_asst_2");
  assert.equal(runtime.latestAssistantTurnId, "turn_1");
  // conversation 游标命中：只恢复 conversation 游标。
  port.recordConversationMessage("msg_rolled");
  port.restoreFromPersistenceAnchor("msg_rolled", anchor);
  assert.equal(runtime.latestConversationMessageId, "msg_anchor_conv");
  assert.equal(runtime.latestAssistantMessageId, "msg_asst_2");
  assert.equal(runtime.latestAssistantTurnId, "turn_1");
  // assistant 游标命中：assistant + turn 游标一起恢复。
  port.recordAssistantMessage("msg_rolled_2", "turn_2");
  port.restoreFromPersistenceAnchor("msg_rolled_2", anchor);
  assert.equal(runtime.latestAssistantMessageId, "msg_anchor_asst");
  assert.equal(runtime.latestAssistantTurnId, "turn_anchor");

  // rebuildFromMessages：resume/rewind 整体替换三个 ID 游标（含清 undefined）。
  port.rebuildFromMessages({
    latestConversationMessageId: "msg_rebuilt",
    latestAssistantMessageId: undefined,
    latestAssistantTurnId: undefined,
  });
  assert.equal(runtime.latestConversationMessageId, "msg_rebuilt");
  assert.equal(runtime.latestAssistantMessageId, undefined);
  assert.equal(runtime.latestAssistantTurnId, undefined);
  // 重建不动日期游标（rewind 不重置日期游标，与迁移前一致）。
  assert.equal(runtime.lastEmittedLocalDate, undefined);

  // emitLocalDateReminder：原子「读旧值 + 写新值」，返回更新前的值——
  // 调用方用 previousDate 判断是否注入提醒（首日 undefined / 同日相等 → 不注入）。
  assert.equal(port.emitLocalDateReminder("2026-10-28"), undefined);
  assert.equal(runtime.lastEmittedLocalDate, "2026-10-28");
  assert.equal(port.emitLocalDateReminder("2026-10-28"), "2026-10-28");
  assert.equal(runtime.lastEmittedLocalDate, "2026-10-28");
  assert.equal(port.emitLocalDateReminder("2026-10-29"), "2026-10-28");
  assert.equal(runtime.lastEmittedLocalDate, "2026-10-29");
  // resetLocalDateCursor：cold resume 重置。
  port.resetLocalDateCursor();
  assert.equal(runtime.lastEmittedLocalDate, undefined);

  // 端口冻结：不能替换写方法。
  assert.throws(() => {
    port.recordConversationMessage = () => {};
  }, TypeError);
  assert.throws(() => {
    port.emitLocalDateReminder = () => undefined;
  }, TypeError);

  // 重复初始化是幂等 no-op（owners.has 短路）：重新初始化不重置已有状态。
  port.recordConversationMessage("msg_keep");
  initializeRuntimeMessageProjection(runtime);
  assert.equal(runtime.latestConversationMessageId, "msg_keep");
});

test("R1-01 B4: context init fields are owned by a finite write port, not the flat `this` surface", () => {
  const runtime = {};
  initializeRuntimeContextInit(runtime);
  const port = getRuntimeContextInitPort(runtime);

  // 初始值（迁移前 agent-runtime.ts 字段默认值等价：builder null、initialized false、
  // 其余 undefined；messageHistory 容器默认值由 owner 构造）。
  assert.equal(runtime.contextInitialized, false);
  assert.equal(runtime.contextBuilder, null);
  assert.equal(runtime.contextSourceSnapshot, undefined);
  assert.equal(runtime.latestContextBuildResult, undefined);
  assert.equal(runtime.memoryRoot, undefined);
  assert.equal(runtime.memoryIndexContent, undefined);
  assert.equal(runtime.promptFileRouting, undefined);
  assert.equal(runtime.skillLoadOutcome, undefined);
  assert.equal(runtime.messageHistory.getMessageCount(), 0);

  // 初始化面逐点提交（与 ensureContextInitialized 的交错写点一一对应）。
  port.commitContextSourceSnapshot({ workingDirectory: "/w" });
  assert.equal(runtime.contextSourceSnapshot.workingDirectory, "/w");
  const outcome = { skills: [], diagnostics: [], totalDiscovered: 0 };
  port.commitSkillLoadOutcome(outcome);
  assert.equal(runtime.skillLoadOutcome, outcome);
  port.commitSkillLoadOutcome(undefined);
  assert.equal(runtime.skillLoadOutcome, undefined);
  port.commitMemoryRoot("/mem");
  port.commitMemoryIndexContent("# INDEX");
  assert.equal(runtime.memoryRoot, "/mem");
  assert.equal(runtime.memoryIndexContent, "# INDEX");
  port.commitPromptFileRouting({});
  assert.deepEqual(runtime.promptFileRouting, {});
  const builder = { build: () => ({ sections: [] }) };
  port.commitContextBuilder(builder);
  assert.equal(runtime.contextBuilder, builder);
  const buildResult = { sections: [], totalChars: 0, totalTokens: 0 };
  port.commitContextBuildResult(buildResult);
  assert.equal(runtime.latestContextBuildResult, buildResult);

  // markContextInitialized 单调提交；重复提交幂等（与迁移前重复赋 true 等价）。
  port.markContextInitialized();
  assert.equal(runtime.contextInitialized, true);
  port.markContextInitialized();
  assert.equal(runtime.contextInitialized, true);

  // resetForResume：cold resume 三联重置同一事务——messageHistory 整体替换
  //（identity 变化、新容器为空）、builder 清 null、initialized 回退 false；
  // 其余初始化面字段不动（与迁移前 resume.ts 连续同步块逐点等价）。
  const oldHistory = runtime.messageHistory;
  port.resetForResume();
  assert.notEqual(runtime.messageHistory, oldHistory);
  assert.equal(runtime.messageHistory.getMessageCount(), 0);
  assert.equal(oldHistory.getMessageCount(), 0);
  assert.equal(runtime.contextBuilder, null);
  assert.equal(runtime.contextInitialized, false);
  assert.equal(runtime.contextSourceSnapshot.workingDirectory, "/w");
  assert.equal(runtime.memoryRoot, "/mem");

  // 端口冻结：不能替换写方法。
  assert.throws(() => {
    port.markContextInitialized = () => {};
  }, TypeError);
  assert.throws(() => {
    port.resetForResume = () => {};
  }, TypeError);

  // 重复初始化是幂等 no-op（owners.has 短路）：重新初始化不重置已有状态。
  port.markContextInitialized();
  initializeRuntimeContextInit(runtime);
  assert.equal(runtime.contextInitialized, true);
  assert.equal(runtime.memoryRoot, "/mem");
});

test("R1-01 B4: MCP lifecycle claim/monotonic commits are owned by a finite write port", () => {
  const runtime = {};
  initializeRuntimeMcpLifecycle(runtime);
  const port = getRuntimeMcpLifecyclePort(runtime);

  // 初始值。
  assert.equal(runtime.mcpInitialized, false);
  assert.equal(runtime.mcpToolsRegistered, false);
  assert.equal(runtime.mcpStartupPromise, undefined);
  assert.equal(runtime.mcpInitializationPromise, undefined);

  // claimStartup 原子「读 + 写」：并发/重复调用只第一个拿到 claimed:true。
  const first = port.claimStartup();
  assert.equal(first.claimed, true);
  assert.equal(first.startupPromise, undefined);
  assert.equal(runtime.mcpInitialized, true);
  const second = port.claimStartup();
  assert.equal(second.claimed, false);
  assert.equal(second.startupPromise, undefined);

  // commitStartupPromise：后续 claim 读到同一 promise（重复 startMcpStartup 的返回面）。
  const startup = Promise.resolve({ statuses: {}, tools: [] });
  port.commitStartupPromise(startup);
  assert.equal(runtime.mcpStartupPromise, startup);
  const third = port.claimStartup();
  assert.equal(third.claimed, false);
  assert.equal(third.startupPromise, startup);

  // claim/release 配对（initializeMcp 并发守卫）；无守卫的释放是安全 no-op。
  const initialization = Promise.resolve();
  port.claimInitialization(initialization);
  assert.equal(runtime.mcpInitializationPromise, initialization);
  port.releaseInitialization();
  assert.equal(runtime.mcpInitializationPromise, undefined);
  port.releaseInitialization();

  // commitToolsRegistered 单调提交；重复提交幂等（含失败路径 fail-closed 同端口）。
  port.commitToolsRegistered();
  assert.equal(runtime.mcpToolsRegistered, true);
  port.commitToolsRegistered();
  assert.equal(runtime.mcpToolsRegistered, true);

  // 端口冻结 + 幂等初始化。
  assert.throws(() => {
    port.claimStartup = () => ({ claimed: true, startupPromise: undefined });
  }, TypeError);
  assert.throws(() => {
    port.commitToolsRegistered = () => {};
  }, TypeError);
  initializeRuntimeMcpLifecycle(runtime);
  assert.equal(runtime.mcpToolsRegistered, true);
  assert.equal(runtime.mcpInitialized, true);
});

test("R1-01 B4: tool cache fields are owned by a finite write port", () => {
  const runtime = {};
  initializeRuntimeToolCache(runtime);
  const port = getRuntimeToolCachePort(runtime);

  // 初始值（cachedTools=null 派生缓存待建；toolSearchContext=undefined 未启用）。
  assert.equal(runtime.cachedTools, null);
  assert.equal(runtime.toolSearchContext, undefined);

  // 派生缓存：commit → invalidate 循环。
  const tools = [{ name: "Bash" }, { name: "Read" }];
  port.commitCachedTools(tools);
  assert.equal(runtime.cachedTools, tools);
  port.invalidateCachedTools();
  assert.equal(runtime.cachedTools, null);

  // 请求级搜索 context：commit → clear。
  const searchContext = { allowedToolNames: new Set(["Grep"]) };
  port.commitToolSearchContext(searchContext);
  assert.equal(runtime.toolSearchContext, searchContext);
  port.clearToolSearchContext();
  assert.equal(runtime.toolSearchContext, undefined);
  // 重复 clear 是安全 no-op。
  port.clearToolSearchContext();
  assert.equal(runtime.toolSearchContext, undefined);

  // 端口冻结 + 幂等初始化。
  assert.throws(() => {
    port.commitCachedTools = () => {};
  }, TypeError);
  assert.throws(() => {
    port.clearToolSearchContext = () => {};
  }, TypeError);
  port.commitCachedTools(tools);
  initializeRuntimeToolCache(runtime);
  assert.equal(runtime.cachedTools, tools);
});

test("R1-01 B4: sidecar lazy construction and residency counter are owned by a finite write port", async () => {
  const runtime = {};
  initializeRuntimeSidecar(runtime);
  const port = getRuntimeSidecarPort(runtime);

  // 初始值。
  assert.equal(runtime.memoryExtractionScheduler, undefined);
  assert.equal(runtime.memorySemanticRecallChannel, undefined);
  assert.equal(runtime.residencyBlockingWorkCount, 0);

  // getOrCreateExtractionScheduler：factory 只在缺席时求值一次（`??=` 短路语义）。
  let schedulerCreations = 0;
  const scheduler = { schedule() {}, hasPendingWork: () => false };
  const firstScheduler = port.getOrCreateExtractionScheduler(() => {
    schedulerCreations += 1;
    return scheduler;
  });
  const secondScheduler = port.getOrCreateExtractionScheduler(() => {
    schedulerCreations += 1;
    return { schedule() {}, hasPendingWork: () => true };
  });
  assert.equal(firstScheduler, scheduler);
  assert.equal(secondScheduler, scheduler);
  assert.equal(schedulerCreations, 1);
  assert.equal(runtime.memoryExtractionScheduler, scheduler);

  // getOrCreateSemanticRecallChannel：同形态幂等。
  let channelCreations = 0;
  const channel = { injector: {}, metrics: {}, pipeline: {} };
  assert.equal(
    port.getOrCreateSemanticRecallChannel(() => {
      channelCreations += 1;
      return channel;
    }),
    channel,
  );
  assert.equal(
    port.getOrCreateSemanticRecallChannel(() => {
      channelCreations += 1;
      return { injector: {}, metrics: {}, pipeline: {} };
    }),
    channel,
  );
  assert.equal(channelCreations, 1);
  assert.equal(runtime.memorySemanticRecallChannel, channel);

  // residency 计数器：begin/end 原子配对（真实 method trackResidencyBlockingWork 驱动），
  // 计数在 Promise 启动的同一同步片增加、finally 释放；下界钳制 0。
  const gate = deferred();
  const trackedFirst = trackResidencyBlockingWork.call(runtime, gate.promise);
  assert.equal(runtime.residencyBlockingWorkCount, 1);
  const trackedSecond = trackResidencyBlockingWork.call(runtime, gate.promise);
  assert.equal(runtime.residencyBlockingWorkCount, 2);
  gate.resolve();
  await trackedFirst;
  await trackedSecond;
  assert.equal(runtime.residencyBlockingWorkCount, 0);
  port.endBlockingWork();
  assert.equal(runtime.residencyBlockingWorkCount, 0);

  // 端口冻结 + 幂等初始化。
  assert.throws(() => {
    port.beginBlockingWork = () => {};
  }, TypeError);
  assert.throws(() => {
    port.getOrCreateExtractionScheduler = () => scheduler;
  }, TypeError);
  initializeRuntimeSidecar(runtime);
  assert.equal(runtime.memoryExtractionScheduler, scheduler);
  assert.equal(runtime.residencyBlockingWorkCount, 0);
});

test("R1-01 B4: real runtime keeps context init gate and MCP constructor startup behind the owners", async (t) => {
  const { runtime } = await fixture(t);

  // 构造期 MCP startup 已被 claim 一次（无 mcpPort → fail-closed 单调提交）：
  // 重复 startMcpStartup 被拒并返回 undefined（既有 startupPromise 缺省）。
  assert.equal(runtime.mcpInitialized, true);
  assert.equal(runtime.mcpToolsRegistered, true);
  assert.equal(runtime.mcpStartupPromise, undefined);
  assert.equal(runtime.startMcpStartup(trace), undefined);
  assert.equal(runtime.mcpInitialized, true);

  // ensureContextInitialized 幂等（收敛门 = 最后单调提交的 contextInitialized）：
  // 第二次调用直接返回，builder/snapshot 引用不变。
  assert.equal(runtime.contextInitialized, false);
  assert.equal(runtime.contextBuilder, null);
  await runtime.ensureContextInitialized(trace);
  assert.equal(runtime.contextInitialized, true);
  const builder = runtime.contextBuilder;
  const snapshot = runtime.contextSourceSnapshot;
  assert.ok(builder);
  assert.ok(snapshot);
  await runtime.ensureContextInitialized(trace);
  assert.equal(runtime.contextBuilder, builder);
  assert.equal(runtime.contextSourceSnapshot, snapshot);

  // readFileState 是构造期不可写数据属性（容器内写是设计内行为）。
  runtime.readFileState.set("k", { path: "k" });
  assert.equal(runtime.readFileState.has("k"), true);
  assert.throws(() => {
    runtime.readFileState = new Map();
  }, TypeError);

  // messageHistory 容器内写不经端口（本批只封整体替换）。
  const messageCountBefore = runtime.messageHistory.getMessageCount();
  runtime.messageHistory.addUser("hello");
  assert.equal(runtime.messageHistory.getMessageCount(), messageCountBefore + 1);
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
runtime.turnNumber = 999;
runtime.activeTurn = undefined;
runtime.pendingInputSequence = 999;
runtime.pendingInputReservations = new Map();
runtime.pendingInputDrains = 5;
runtime.queueAutoDrain = false;
runtime.queueExternalDrainActive = true;
runtime.mainTurnCacheHitAggregate = { requestCount: 0, totalInputTokens: 0, totalCacheReadTokens: 0, totalCacheWriteTokens: 0 };
runtime.pendingCacheMissCause = "compaction";
runtime.cacheMissCauseCounts = {};
runtime.autoCompactConsecutiveFailures = 5;
runtime.lastRequestModelId = "model_bad";
runtime.lastAssistantCompletedAtMs = 12345;
runtime.activeForegroundExecution = undefined;
runtime.foregroundPromotionLease = undefined;
runtime.runtimeCommandQueue = runtime.runtimeCommandQueue;
runtime.currentTurnFileChanges = new Map();
runtime.latestConversationMessageId = runtime.latestConversationMessageId;
runtime.latestAssistantMessageId = runtime.latestAssistantMessageId;
runtime.latestAssistantTurnId = runtime.latestAssistantTurnId;
runtime.lastEmittedLocalDate = "2026-10-28";
runtime.messageHistory = runtime.messageHistory;
runtime.readFileState = new Map();
runtime.cachedTools = null;
runtime.toolSearchContext = undefined;
runtime.contextBuilder = null;
runtime.contextInitialized = true;
runtime.contextSourceSnapshot = undefined;
runtime.latestContextBuildResult = undefined;
runtime.memoryRoot = undefined;
runtime.memoryIndexContent = undefined;
runtime.promptFileRouting = undefined;
runtime.memoryExtractionScheduler = undefined;
runtime.memorySemanticRecallChannel = undefined;
runtime.mcpStartupPromise = undefined;
runtime.mcpInitializationPromise = undefined;
runtime.mcpInitialized = true;
runtime.mcpToolsRegistered = true;
runtime.skillLoadOutcome = undefined;
runtime.residencyBlockingWorkCount = 1;
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
  // R1-01 B1：新增 6 个 cache 诊断字段（mainTurnCacheHitAggregate / pendingCacheMissCause /
  // cacheMissCauseCounts / autoCompactConsecutiveFailures / lastRequestModelId /
  // lastAssistantCompletedAtMs），readonly 违例 17 → 23、总诊断数 18 → 24。
  // R1-01 B2：新增 4 个 TurnState 剩余字段（activeForegroundExecution /
  // foregroundPromotionLease / runtimeCommandQueue / currentTurnFileChanges），
  // readonly 违例 23 → 27、总诊断数 24 → 28。
  // R1-01 B3：新增 4 个 MessageProjection 字段（latestConversationMessageId /
  // latestAssistantMessageId / latestAssistantTurnId / lastEmittedLocalDate；前三个是
  // 品牌类型，用自赋值避免引入额外 2322 类型违例），readonly 违例 27 → 31、总诊断数 28 → 32。
  // R1-01 B4：新增 19 个 ContextMemory 字段（messageHistory 用自赋值避免额外类型违例；
  // readFileState 是类型级 readonly + 构造期不可写数据属性，同样只报 2540；其余 17 个
  // 用类型兼容值只触发 2540），readonly 违例 31 → 50、总诊断数 32 → 51。
  assert.equal(diagnostics.length, 51, detail);
  assert.equal(diagnostics.filter((diagnostic) => diagnostic.code === 2540).length, 50, detail);
  // TS 有拼写建议时用 2551、没有时用 2339；两者都必须真正拒绝不存在的任意 setter。
  assert.equal(
    diagnostics.filter((diagnostic) => diagnostic.code === 2339 || diagnostic.code === 2551).length,
    1,
    detail,
  );
  assert.match(detail, /Property 'setBranchGeneration' does not exist/);
});

test("R1-01 gate: every proto-injected method is declared on the AgentRuntime type surface", () => {
  // 验收项（review §2 P1 验收）：把「原型注入面失控」钉住——installAgentRuntimeMethods
  // 经 proto.X = X 挂到 AgentRuntime.prototype 的每个方法名，必须在类型面
  // （公开的 declaration-merged AgentRuntime 类+接口，或 AgentRuntimeInternal 的方法簇）
  // 有对应声明。出现 proto 上未在任一接口声明的方法即红：那是绕过类型约束的裸注入。
  const coreDir = fileURLToPath(new URL("../packages/core/", import.meta.url));
  const agentRuntimePath = join(coreDir, "src/runtime/agent-runtime.ts");
  const internalPath = join(coreDir, "src/runtime/internal.ts");
  const configPath = join(coreDir, "tsconfig.json");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath));
  const options = { ...parsed.options, noEmit: true };
  const program = ts.createProgram([agentRuntimePath, internalPath], options);
  const checker = program.getTypeChecker();

  // 取一个导出符号（class 或 interface）的实例类型全部成员名（含继承的方法簇）。
  const memberNames = (sourcePath, exportName) => {
    const sourceFile = program.getSourceFile(sourcePath);
    assert.ok(sourceFile, `TypeScript 必须真正读取 ${sourcePath}`);
    const nameNode = ts.forEachChild(sourceFile, (node) =>
      (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) &&
      node.name?.text === exportName
        ? node.name
        : undefined,
    );
    assert.ok(nameNode, `${sourcePath} 必须声明 ${exportName}`);
    const symbol = checker.getSymbolAtLocation(nameNode);
    // getDeclaredTypeOfSymbol：class 取实例类型（含 declaration-merged interface 成员），
    // interface 取接口类型（含继承的方法簇成员）。
    const type = checker.getDeclaredTypeOfSymbol(symbol);
    return new Set(type.getProperties().map((property) => property.getName()));
  };

  const declared = memberNames(agentRuntimePath, "AgentRuntime");
  for (const name of memberNames(internalPath, "AgentRuntimeInternal")) declared.add(name);

  // proto 注入面：AgentRuntime.prototype 的自有键（module 加载时已跑完 install）。
  const protoKeys = Object.getOwnPropertyNames(AgentRuntime.prototype).filter(
    (key) => key !== "constructor",
  );
  assert.ok(protoKeys.length > 100, `注入面应含大量方法，实测 ${protoKeys.length}`);

  const undeclared = protoKeys.filter((key) => !declared.has(key));
  assert.deepEqual(
    undeclared,
    [],
    `proto 上存在未在 AgentRuntime / AgentRuntimeInternal 声明的注入方法：${undeclared.join(", ")}`,
  );
});

