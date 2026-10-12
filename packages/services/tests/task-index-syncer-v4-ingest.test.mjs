// task index syncer 的 v4 帧摄入回归测试（2026-10-11「任务对话被吞」事故第二失效面）。
//
// 事故事实（desktop 日志 + tasks-index.sqlite 取证）：0.0.7 自动更新重启后，
// 已有会话（zoode f9bd56c6）在重启基线里以终态入册，用户继续对话产生
// terminal→running 的 sessions-index delta，但 syncer 全程零写入——任务行的
// updated_at 冻结在重启前的 04:19:17，直到当日结束再未推进。
//
// 本文件用桩 agentService 直灌 v4 wire 帧，验证：
//   R1 runtime available 后 syncer 必须发出 sessions-index 订阅；
//   R2 初始 snapshot 基线经 seedTaskMetaIfMissing 静默补行；
//   R3 新会话首次出现的 delta（previous undefined）必须回源写行；
//   R4 终态→非终态（重启后恢复活动）的 delta 必须刷新任务行（事故回归）。

import assert from "node:assert/strict";
import test from "node:test";

const { createACodeTaskIndexSyncer } = await import("../src/acode-agent/acodeTaskIndexSyncer.ts");
const { Emitter } = await import("@acode/rpc");

const WORKSPACE_PATH = "C:\\Users\\ZhuanZ\\Desktop\\zoode";
const TOPIC = `sessions-index/${WORKSPACE_PATH}`;
const LOG_EPOCH = "ep-syncer-test";

function summary(sessionId, phase, lastActivityAt, extra = {}) {
  return {
    sessionId,
    workspaceId: WORKSPACE_PATH,
    title: `task-${sessionId}`,
    phase,
    sessionEnded: false,
    hasBackgroundWork: false,
    lastActivityAt,
    createdAt: lastActivityAt - 1000,
    ...extra,
  };
}

function wireFrame(subscriptionId, frame) {
  return {
    wireVersion: 1,
    kind: "complete",
    deliveryKind: "online",
    logicalFrameId: `lf-${frame.toSeq}`,
    logicalFrameOrdinal: frame.toSeq,
    topic: TOPIC,
    subscriptionId,
    frame,
  };
}

function createHarness() {
  const indexEmitters = [];
  const configEmitters = [];
  const lifecycleListeners = [];
  const subscribeCalls = [];
  const sessionSnapshots = new Map();
  let subscriptionCounter = 0;

  const agentService = {
    readSession: async (target) => {
      const snapshot = sessionSnapshots.get(target.sessionId);
      if (!snapshot) throw new Error(`Session not found: ${target.sessionId}`);
      return snapshot;
    },
    subscribeSessionsIndexV4: async (params) => {
      subscribeCalls.push({ kind: "sessions-index", params });
      subscriptionCounter += 1;
      return {
        ack: {
          subscriptionId: `sub-${subscriptionCounter}`,
          mode: "snapshot",
          logEpoch: LOG_EPOCH,
        },
      };
    },
    unsubscribeSessionsIndexV4: async () => {},
    subscribeWorkspaceConfigV4: async (params) => {
      subscribeCalls.push({ kind: "workspace-config", params });
      subscriptionCounter += 1;
      return {
        ack: {
          subscriptionId: `sub-${subscriptionCounter}`,
          mode: "snapshot",
          logEpoch: LOG_EPOCH,
        },
      };
    },
    unsubscribeWorkspaceConfigV4: async () => {},
    onDynamicSessionsIndexFrame: () => {
      const emitter = new Emitter();
      indexEmitters.push(emitter);
      return emitter.event;
    },
    onDynamicWorkspaceConfigFrame: () => {
      const emitter = new Emitter();
      configEmitters.push(emitter);
      return emitter.event;
    },
    onAgentRuntimeLifecycle: (listener) => {
      lifecycleListeners.push(listener);
      return { dispose: () => {} };
    },
  };

  const repoCalls = { seedIfMissing: [], syncTaskMeta: [], updateTaskState: [], applyAgentPatch: [] };
  const taskIndexRepo = {
    seedTaskMetaIfMissing: async (meta) => {
      repoCalls.seedIfMissing.push(meta);
      return meta;
    },
    // 返回 null = 「行缺失」，让 applyTerminalTransition 的 .then 走回源分支而不广播，
    // 把断言聚焦在迁移表是否触发 applyAgentPatch（status/lastError 收敛）这一决策点上。
    applyAgentPatch: async (params) => {
      repoCalls.applyAgentPatch.push(params);
      return null;
    },
    syncTaskMeta: async ({ meta }) => {
      repoCalls.syncTaskMeta.push(meta);
      return meta;
    },
    updateTaskState: async (input) => {
      repoCalls.updateTaskState.push(input);
      return input.patch;
    },
    listTaskMetas: async () => [],
    syncTaskMetaAtGroupedTop: async ({ meta }) => {
      repoCalls.syncTaskMeta.push(meta);
      return { meta, initializedGroupedOrder: true };
    },
  };

  const syncer = createACodeTaskIndexSyncer({ agentService, taskIndexRepo });

  function fireRuntimeAvailable() {
    for (const listener of lifecycleListeners) {
      listener({
        workspacePath: WORKSPACE_PATH,
        workspaceKey: WORKSPACE_PATH,
        runtimeIdentity: { generation: 1, identity: `${WORKSPACE_PATH}:1:101` },
        state: "available",
      });
    }
  }

  /** 模拟 CLI 侧会话快照：resyncTaskIndexRowFromAgent 经 readSession 回源的权威态。 */
  function stubSnapshot(summaryLike) {
    sessionSnapshots.set(summaryLike.sessionId, {
      session: {
        sessionId: summaryLike.sessionId,
        workspace: { workspacePath: WORKSPACE_PATH },
        createdAt: summaryLike.createdAt,
        updatedAt: summaryLike.lastActivityAt,
        mode: "build",
        status: "idle",
        title: summaryLike.title,
        sessionKind: "interactive",
      },
      settings: {
        model: { providerId: "test-provider", modelId: "test-model" },
        thoughtLevel: { enabled: false, current: "default", available: [] },
      },
      projection: {},
      runtime: { activeTurnId: null, eventSeq: 1, pendingRequestIds: [], stateRevision: 0 },
      messages: [
        {
          info: { id: `msg_${summaryLike.sessionId}`, role: "user" },
          parts: [{ type: "text", text: `user input ${summaryLike.sessionId}` }],
        },
      ],
    });
  }

  function emitFrame(frame) {
    const subId = `sub-${subscribeCalls.filter((c) => c.kind === "sessions-index").length}`;
    for (const emitter of indexEmitters) {
      emitter.fire(wireFrame(subId, frame));
    }
  }

  return { syncer, repoCalls, subscribeCalls, fireRuntimeAvailable, emitFrame, stubSnapshot };
}

test("R1+R2：runtime available 后订阅 sessions-index，初始 snapshot 静默补缺失行", async () => {
  const h = createHarness();
  h.fireRuntimeAvailable();
  await new Promise((r) => setTimeout(r, 20));

  const indexSubscribe = h.subscribeCalls.find((c) => c.kind === "sessions-index");
  assert.ok(indexSubscribe, "runtime available 后必须订阅 sessions-index");

  h.emitFrame({
    topic: TOPIC,
    subscriptionId: "sub-1",
    fromSeq: 0,
    toSeq: 1,
    sentAt: Date.now(),
    payload: {
      kind: "snapshot",
      snapshot: {
        protocolVersion: 1,
        workspaceId: WORKSPACE_PATH,
        logEpoch: LOG_EPOCH,
        sessions: [summary("sess_existing", "completedSuccess", 1000)],
      },
    },
  });
  await new Promise((r) => setTimeout(r, 30));

  assert.equal(
    h.repoCalls.seedIfMissing.filter((m) => m.taskId === "sess_existing").length,
    1,
    "初始 snapshot 的非 draft 会话必须经 seedTaskMetaIfMissing 补行",
  );
  h.syncer.disposeAll();
});

test("R3：新会话首次出现的 delta（previous undefined）必须回源写任务行", async () => {
  const h = createHarness();
  h.fireRuntimeAvailable();
  await new Promise((r) => setTimeout(r, 20));

  h.emitFrame({
    topic: TOPIC,
    subscriptionId: "sub-1",
    fromSeq: 0,
    toSeq: 1,
    sentAt: Date.now(),
    payload: {
      kind: "snapshot",
      snapshot: {
        protocolVersion: 1,
        workspaceId: WORKSPACE_PATH,
        logEpoch: LOG_EPOCH,
        sessions: [],
      },
    },
  });
  await new Promise((r) => setTimeout(r, 30));

  h.stubSnapshot(summary("sess_new", "running", 2000));
  h.emitFrame({
    topic: TOPIC,
    subscriptionId: "sub-1",
    fromSeq: 1,
    toSeq: 2,
    sentAt: Date.now(),
    payload: {
      kind: "deltas",
      deltas: [{ op: "session.upserted", session: summary("sess_new", "running", 2000) }],
    },
  });
  await new Promise((r) => setTimeout(r, 30));

  assert.ok(
    h.repoCalls.syncTaskMeta.some((m) => m.taskId === "sess_new") ||
      h.repoCalls.seedIfMissing.some((m) => m.taskId === "sess_new"),
    "新会话首次 delta 必须写入 task index（否则新任务在重启后从侧栏消失）",
  );
  h.syncer.disposeAll();
});

test("R4（事故回归）：终态→running（重启后恢复活动）的 delta 必须刷新任务行", async () => {
  const h = createHarness();
  h.fireRuntimeAvailable();
  await new Promise((r) => setTimeout(r, 20));

  // 重启基线：会话以 completedSuccess 入册（sqlite 已有行，seed 只补缺失）。
  h.emitFrame({
    topic: TOPIC,
    subscriptionId: "sub-1",
    fromSeq: 0,
    toSeq: 1,
    sentAt: Date.now(),
    payload: {
      kind: "snapshot",
      snapshot: {
        protocolVersion: 1,
        workspaceId: WORKSPACE_PATH,
        logEpoch: LOG_EPOCH,
        sessions: [summary("sess_resumed", "completedSuccess", 1000)],
      },
    },
  });
  await new Promise((r) => setTimeout(r, 30));

  // 用户恢复对话：phase 从 completedSuccess → running，lastActivityAt 推进。
  h.stubSnapshot(summary("sess_resumed", "running", 5000));
  h.emitFrame({
    topic: TOPIC,
    subscriptionId: "sub-1",
    fromSeq: 1,
    toSeq: 2,
    sentAt: Date.now(),
    payload: {
      kind: "deltas",
      deltas: [
        {
          op: "session.upserted",
          session: summary("sess_resumed", "running", 5000),
        },
      ],
    },
  });
  await new Promise((r) => setTimeout(r, 30));

  const reactivated = h.repoCalls.syncTaskMeta.some(
    (m) => m.taskId === "sess_resumed" && m.updatedAt === 5000,
  );
  assert.ok(
    reactivated,
    "终态→running 的 delta 必须把任务行刷新为 running/新 lastActivity（事故：updated_at 永久冻结在重启前水位）",
  );
  h.syncer.disposeAll();
});

// R5/R6（conflated snapshot 缺口）：断档降级 snapshot 只携带每会话的最新 phase，
// 落后期间 error→running→completedSuccess 被折叠成一次 error↔completedSuccess 迁移。
// 迁移表原本无「终态→不同 kind 终态」分支 → 四个旧分支全部 false → 任务行 status/
// updatedAt/lastError 永久冻结在旧终态。这里用「基线 snapshot + 第二帧 snapshot（更高
// toSeq）」直灌 applySessionsIndexFrame 的断档降级 diff 路径复现该缺口。
function emitSnapshot(h, toSeq, sessions) {
  h.emitFrame({
    topic: TOPIC,
    subscriptionId: "sub-1",
    fromSeq: toSeq - 1,
    toSeq,
    sentAt: Date.now(),
    payload: {
      kind: "snapshot",
      snapshot: {
        protocolVersion: 1,
        workspaceId: WORKSPACE_PATH,
        logEpoch: LOG_EPOCH,
        sessions,
      },
    },
  });
}

test("R5（conflated snapshot 缺口）：error→completedSuccess 的断档 diff 必须收敛为 completed", async () => {
  const h = createHarness();
  h.fireRuntimeAvailable();
  await new Promise((r) => setTimeout(r, 20));

  // 基线 snapshot：会话以 error 入册（seeded=true，state.summaries 记录 S=error）。
  emitSnapshot(h, 1, [summary("sess_retry", "error", 1000)]);
  await new Promise((r) => setTimeout(r, 30));

  // 落后期间用户重试成功：断档降级 snapshot 只带最新 phase completedSuccess，
  // 中间的 running 被 conflate 掉 → diff 变成 error→completedSuccess。
  h.stubSnapshot(summary("sess_retry", "completedSuccess", 5000));
  emitSnapshot(h, 2, [summary("sess_retry", "completedSuccess", 5000)]);
  await new Promise((r) => setTimeout(r, 30));

  const converged = h.repoCalls.applyAgentPatch.some(
    (p) => p.taskId === "sess_retry" && p.patch.status === "completed",
  );
  assert.ok(
    converged,
    "终态(error)→不同 kind 终态(completedSuccess) 的 conflated snapshot diff 必须经 applyTerminalTransition 收敛 status=completed（缺口：侧栏永久显示 error、lastError 不清空、updatedAt 冻结）",
  );
  h.syncer.disposeAll();
});

test("R6（conflated snapshot 缺口）：completedSuccess→error 的断档 diff 必须收敛为 error", async () => {
  const h = createHarness();
  h.fireRuntimeAvailable();
  await new Promise((r) => setTimeout(r, 20));

  // 基线 snapshot：会话以 completedSuccess 入册。
  emitSnapshot(h, 1, [summary("sess_regress", "completedSuccess", 1000)]);
  await new Promise((r) => setTimeout(r, 30));

  // 落后期间恢复对话后失败：断档降级 snapshot 折叠成 completedSuccess→error。
  h.stubSnapshot(summary("sess_regress", "error", 6000));
  emitSnapshot(h, 2, [summary("sess_regress", "error", 6000)]);
  await new Promise((r) => setTimeout(r, 30));

  const converged = h.repoCalls.applyAgentPatch.some(
    (p) => p.taskId === "sess_regress" && p.patch.status === "error",
  );
  assert.ok(
    converged,
    "终态(completedSuccess)→不同 kind 终态(error) 的 conflated snapshot diff 必须经 applyTerminalTransition 收敛 status=error（缺口：侧栏永久显示 completed/绿色而会话实际失败）",
  );
  h.syncer.disposeAll();
});

