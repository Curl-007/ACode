import assert from "node:assert/strict";
import test from "node:test";

// handlers/index.ts → 各 handler → ../executor.js → 回本 index 的环：executor 只在运行时
// 查 NATIVE_HANDLERS（非模块初始化期），先初始化 index 即与生产加载序一致（gateway 入口
// 先经 index）。直接先进 session-mgmt 会让 index 的 spread 撞 TDZ。
await import("../packages/bootstrap/src/acode-protocol-v4/commands/handlers/index.ts");
const { sessionMgmtHandlers } = await import(
  "../packages/bootstrap/src/acode-protocol-v4/commands/handlers/session-mgmt.ts"
);
const { goalCompactHandlers } = await import(
  "../packages/bootstrap/src/acode-protocol-v4/commands/handlers/goal-compact.ts"
);
const { querySessionGoalV4 } = await import(
  "../packages/bootstrap/src/acode-protocol-v4/session-goal-query.ts"
);
const { querySessionDebugV4 } = await import(
  "../packages/bootstrap/src/acode-protocol-v4/session-debug-query.ts"
);

/**
 * M2-2 session 控制面 handler 测试（apps/acode-cli/specs/m2-2-session-control.md §5 C 节）。
 * 钉住：closeSession 的 expectedPersistence 断言三态、goal query 的 supported/target 两态、
 * debug query 直通、clearGoal 的 hadTarget 两态、compact instructions 线程。
 */

function makeEnvelope(type, payload, sessionId = "s1") {
  return {
    commandId: `cmd-${type}-1`,
    clientId: "test-client",
    sessionId,
    type,
    payload,
    issuedAt: Date.now(),
  };
}

function makeRecord(overrides = {}) {
  return {
    app: {
      sessionId: "s1",
      runtime: {
        getActiveTurnInfo: () => undefined,
        releaseForegroundPromotionLease: () => {},
      },
      ...overrides.app,
    },
    persistence: "immediate",
    workspace: { workspacePath: "/w" },
    traceContext: {},
    ...overrides,
  };
}

function makeHost(record, hostOverrides = {}) {
  return {
    getRecord: (sessionId) => (sessionId === record.app.sessionId ? record : undefined),
    ...hostOverrides,
  };
}

// ── closeSession：expectedPersistence 断言等价物（spec §2.3）──
test("closeSession: expectedPersistence mismatch → graceful closed:false，不调 host.closeSession", async () => {
  const record = makeRecord({ persistence: "deferred" });
  let closeCalls = 0;
  const host = makeHost(record, {
    closeSession: async () => {
      closeCalls += 1;
    },
  });
  const result = await sessionMgmtHandlers.closeSession(
    host,
    makeEnvelope("closeSession", { expectedPersistence: "immediate" }),
  );
  assert.deepEqual(result, { type: "closeSession", closed: false });
  assert.equal(closeCalls, 0, "断言不匹配时不得执行关闭");
});

test("closeSession: expectedPersistence match → 执行关闭且 closed:true", async () => {
  const record = makeRecord({ persistence: "deferred" });
  const closed = [];
  const host = makeHost(record, {
    closeSession: async (sessionId) => {
      closed.push(sessionId);
    },
  });
  const result = await sessionMgmtHandlers.closeSession(
    host,
    makeEnvelope("closeSession", { expectedPersistence: "deferred" }),
  );
  assert.deepEqual(result, { type: "closeSession", closed: true });
  assert.deepEqual(closed, ["s1"]);
});

test("closeSession: expectedPersistence 缺席 → 无条件关闭（legacy 兼容面）", async () => {
  const record = makeRecord({ persistence: "immediate" });
  let closeCalls = 0;
  const host = makeHost(record, {
    closeSession: async () => {
      closeCalls += 1;
    },
  });
  const result = await sessionMgmtHandlers.closeSession(host, makeEnvelope("closeSession", {}));
  assert.deepEqual(result, { type: "closeSession", closed: true });
  assert.equal(closeCalls, 1);
});

test("closeSession: host.closeSession 钩子缺失 → 抛错（ACK failed，不静默降级）", async () => {
  const record = makeRecord();
  const host = makeHost(record);
  await assert.rejects(
    () => sessionMgmtHandlers.closeSession(host, makeEnvelope("closeSession", {})),
    /host\.closeSession/,
  );
});

// ── goal query（spec §2.2）──
const sampleGoal = {
  sessionID: 7,
  targetID: "t1",
  objective: "ship it",
  summaryTitle: "Ship",
  status: "active",
  tokenBudget: null,
  tokensUsed: 12,
  timeUsedSeconds: 3,
  time: { created: 100, updated: 200 },
};

test("goal query: app.readTarget 缺席 → supported:false", async () => {
  const record = makeRecord();
  delete record.app.readTarget;
  const context = { sessions: new Map([["s1", record]]) };
  const result = await querySessionGoalV4(context, { sessionId: "s1" });
  assert.deepEqual(result, { supported: false });
});

test("goal query: 有目标 → mapSessionGoal wire 收窄直通", async () => {
  const record = makeRecord({
    app: {
      sessionId: "s1",
      runtime: { getActiveTurnInfo: () => undefined },
      readTarget: async () => sampleGoal,
    },
  });
  const context = { sessions: new Map([["s1", record]]) };
  const result = await querySessionGoalV4(context, { sessionId: "s1" });
  assert.equal(result.supported, true);
  assert.equal(result.target.objective, "ship it");
  assert.equal(result.target.targetId, "t1");
  assert.equal(result.target.sessionId, "7");
  assert.equal(result.target.createdAt, 100);
  assert.equal(result.target.updatedAt, 200);
});

test("goal query: 无目标 → supported:true + target:null；未知会话 → 抛 sessionUnavailable", async () => {
  const record = makeRecord({
    app: {
      sessionId: "s1",
      runtime: { getActiveTurnInfo: () => undefined },
      readTarget: async () => null,
    },
  });
  const context = { sessions: new Map([["s1", record]]) };
  assert.deepEqual(await querySessionGoalV4(context, { sessionId: "s1" }), {
    supported: true,
    target: null,
  });
  await assert.rejects(() => querySessionGoalV4(context, { sessionId: "gone" }));
});

// ── debug query（spec §2.4）──
test("debug query: 无观测的 live record → 空快照直通；未知会话 → 抛错", async () => {
  const record = makeRecord();
  const context = { sessions: new Map([["s1", record]]) };
  const result = querySessionDebugV4(context, { sessionId: "s1" });
  assert.deepEqual(result, { sessionId: "s1", rounds: [], networkEntries: [], cache: null });
  assert.throws(() => querySessionDebugV4(context, { sessionId: "gone" }));
});

// ── clearGoal（spec §2.2）──
test("clearGoal: 无目标 → hadTarget:false 幂等成功；有目标 → clearTarget + hadTarget:true", async () => {
  const noTarget = makeRecord({
    app: {
      sessionId: "s1",
      runtime: { getActiveTurnInfo: () => undefined },
      readTarget: async () => null,
      clearTarget: async () => {
        throw new Error("must not be called");
      },
    },
  });
  const emptyResult = await goalCompactHandlers.clearGoal(
    makeHost(noTarget),
    makeEnvelope("clearGoal", {}),
  );
  assert.deepEqual(emptyResult, {
    type: "goalControl",
    action: "clear",
    hadTarget: false,
    target: null,
    startedTurn: false,
  });

  let cleared = 0;
  const mutations = [];
  const withTarget = makeRecord({
    app: {
      sessionId: "s1",
      runtime: { getActiveTurnInfo: () => undefined },
      readTarget: async () => sampleGoal,
      clearTarget: async () => {
        cleared += 1;
        return true;
      },
    },
  });
  const result = await goalCompactHandlers.clearGoal(
    makeHost(withTarget, {
      afterLegacyStateMutation: async (_record, reason) => {
        mutations.push(reason);
      },
    }),
    makeEnvelope("clearGoal", {}),
  );
  assert.equal(cleared, 1);
  assert.deepEqual(mutations, ["goal_cleared"]);
  assert.deepEqual(result, {
    type: "goalControl",
    action: "clear",
    hadTarget: true,
    target: null,
    startedTurn: false,
  });
});

// ── compact instructions 线程（spec §2.1）──
test("compact: instructions 非空 → 提交文本 '/compact <instructions>'（legacy 逐字构造）", async () => {
  const submitted = [];
  const record = makeRecord({
    app: {
      sessionId: "s1",
      runtime: {
        getActiveTurnInfo: () => undefined,
        releaseForegroundPromotionLease: () => {},
      },
      submitPrompt: async (text) => {
        submitted.push(text);
      },
      setQueueAutoDrain: async () => {},
    },
  });
  const host = makeHost(record, {
    ensureModelReady: async () => {},
    recordPersistentCommandFact: async () => {},
    afterLegacyStateMutation: async () => {},
  });
  const result = await goalCompactHandlers.compact(
    host,
    makeEnvelope("compact", { instructions: "  保留 TODO 上下文  " }),
  );
  assert.equal(result, undefined, "idle 直启回 accepted（无 typed result）");
  // 后台 compact 是 fire-and-forget；flush 让 submitPrompt 落地。
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(submitted, ["/compact 保留 TODO 上下文"], "trim 后并入提交文本");
});

test("compact: instructions 缺席 → 提交文本恒 '/compact'；运行中 → compactOperationLock", async () => {
  const submitted = [];
  const record = makeRecord({
    app: {
      sessionId: "s1",
      runtime: {
        getActiveTurnInfo: () => undefined,
        releaseForegroundPromotionLease: () => {},
      },
      submitPrompt: async (text) => {
        submitted.push(text);
      },
      setQueueAutoDrain: async () => {},
    },
  });
  const host = makeHost(record, {
    ensureModelReady: async () => {},
    recordPersistentCommandFact: async () => {},
    afterLegacyStateMutation: async () => {},
  });
  await goalCompactHandlers.compact(host, makeEnvelope("compact", {}));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(submitted, ["/compact"]);

  // compact 运行中（activeTurn.kind === "compact"）→ 拒绝词 compactOperationLock
  // （facade 据此映回 legacy already_running graceful 收口）。
  const busyRecord = makeRecord({
    app: {
      sessionId: "s1",
      runtime: {
        getActiveTurnInfo: () => ({ kind: "compact" }),
        releaseForegroundPromotionLease: () => {},
      },
    },
  });
  await assert.rejects(
    () =>
      goalCompactHandlers.compact(
        makeHost(busyRecord, { hasQueueItemKind: () => false }),
        makeEnvelope("compact", {}),
      ),
    (error) => error.reasonCode === "compactOperationLock",
  );
});
