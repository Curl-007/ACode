// 「任务对话被吞」事故（2026-10-11）的网关级回归测试。
//
// 生产事实链（~/.acode 日志与 db 取证）：0.0.7 自动更新重启后新建任务（deferred 持久化
// 会话），渲染端先订阅再首发消息；hydrate 的 loadPersistedEvents 曾因 listSessionSubagents
// 对未落盘 live 会话抛 "Session not found" 而整体 reject，gateway 退回空事件 +
// sourceEventSeq=0，runtime 事件从 raw seq≥3 起永久滞留 pendingByRawSeq——会话 pane 全空、
// sessions-index 零增量。修复后 loadPersistedEvents 对 live+deferred 会话返回内存水位
// （specs/v4-deferred-session-hydration.md），本文件锁定修复后的投递契约。

import assert from "node:assert/strict";
import test from "node:test";

const { ConversationV4Gateway } = await import(
  "../packages/bootstrap/src/acode-protocol-v4/v4-gateway.ts"
);
const { SessionEventType } = await import(
  "../packages/contracts/src/events/session.events.ts"
);

const SESSION_ID = "sess_repro_swallow";
const TOPIC = `conversation/${SESSION_ID}`;
const WORKSPACE_ID = "ws-repro";

function makeEvent(sequenceNumber, type, payload) {
  return {
    id: `evt_${sequenceNumber}`,
    sessionId: SESSION_ID,
    turnId: "turn_repro",
    type,
    timestamp: new Date(),
    traceId: "trace_repro",
    sequenceNumber,
    payload,
  };
}

function turnStarted(sequenceNumber) {
  return makeEvent(sequenceNumber, SessionEventType.TurnStarted, {
    input: "新建 dev/0.0.8 分支",
    turnNumber: 1,
    messageId: "msg_user_1",
  });
}

function turnComplete(sequenceNumber) {
  return makeEvent(sequenceNumber, SessionEventType.TurnComplete, {
    turnId: "turn_repro",
  });
}

function titleUpdated(sequenceNumber) {
  return makeEvent(sequenceNumber, SessionEventType.SessionTitleUpdated, {
    title: "新建 dev/0.0.8 分支",
  });
}

/**
 * host 桩模拟修复后的 v4-bridge loadPersistedEvents：
 * - "deferred"：live+未持久化会话——返回内存事件与内存水位（无持久行时不 reject）；
 * - "broken"：存储真故障——reject（gateway 退空基线并经 onError 留痕）。
 */
function createHost({ loadMode }) {
  const frames = [];
  const errors = [];
  const host = {
    sessionExists: () => true,
    emitWireFrame: (frame) => {
      frames.push(frame);
    },
    onError: (scope, error, context) => {
      errors.push({ scope, error, context });
    },
    loadPersistedEvents: async () => {
      if (loadMode === "broken") {
        throw new Error("storage corrupted");
      }
      // deferred 会话：订阅时点内存事件可为空，但水位必须如实返回（生产里
      // eventStore.getLatestSequenceNumber）。
      return { events: [], synthesized: false, sourceEventSeq: 2 };
    },
    getSessionWorkspaceId: () => WORKSPACE_ID,
    getSessionIndexMeta: () => ({ createdAt: 1, lastActivityAt: 2 }),
    listWorkspaceSessionIds: () => [],
    isDraftSession: () => false,
    getStoredSessionSummaries: () => [],
    executeCommand: async () => undefined,
  };
  return { host, frames, errors };
}

function indexFrames(frames) {
  return frames.filter((frame) => frame.topic === `sessions-index/${WORKSPACE_ID}`);
}

async function subscribeConversation(gateway, frames) {
  const dispatch = await gateway.subscribe({
    topic: TOPIC,
    connectionId: "conn-repro",
    clientMode: "desktop-continuous",
  });
  for (const wire of dispatch.initialWires) frames.push(wire);
  dispatch.commit();
  await sleep(120);
}

async function subscribeIndex(gateway, frames) {
  const dispatch = await gateway.subscribeSessionsIndex({
    topic: `sessions-index/${WORKSPACE_ID}`,
    connectionId: "conn-idx",
    clientMode: "desktop-continuous",
  });
  for (const wire of dispatch.initialWires) frames.push(wire);
  dispatch.commit();
  await sleep(120);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("deferred 会话：内存水位基线下，live 事件（raw seq 3+）必须投递且 fan-out 进 sessions-index（事故回归）", async () => {
  const { host, frames } = createHost({ loadMode: "deferred" });
  const gateway = new ConversationV4Gateway(host, {
    createLogEpoch: () => "epoch-repro",
  });

  await subscribeIndex(gateway, frames);
  await subscribeConversation(gateway, frames);
  const conversationFramesAfterSubscribe = frames.filter((f) => f.topic === TOPIC).length;
  const indexFramesAfterSubscribe = indexFrames(frames).length;
  assert.ok(conversationFramesAfterSubscribe >= 1, "conversation 初始帧应当发出");
  assert.ok(indexFramesAfterSubscribe >= 1, "sessions-index 初始帧应当发出");

  // 生产形态：事件从 raw seq 3 起（1-2 是 v4 sink 不转发的 runtime 内部事件）。
  gateway.ingest(SESSION_ID, turnStarted(3));
  gateway.ingest(SESSION_ID, titleUpdated(4));
  gateway.ingest(SESSION_ID, turnComplete(5));
  await sleep(150);

  const conversationTopicFrames = frames.filter((frame) => frame.topic === TOPIC);
  assert.ok(
    conversationTopicFrames.length > conversationFramesAfterSubscribe,
    "live 轮次事件必须产生 conversation 帧（事故形态：0 新帧 = 任务对话被吞）",
  );

  const upserts = indexFrames(frames).flatMap((frame) => {
    const payload = frame.payload ?? frame.frame?.payload;
    return payload?.kind === "deltas" ? (payload.deltas ?? []) : [];
  });
  assert.ok(
    upserts.some((delta) => delta.op === "session.upserted"),
    "live 事件必须 fan-out 出 session.upserted（事故形态：任务索引零增量、重启后侧栏丢任务）",
  );

  gateway.dispose();
});

test("已持久化会话（resume 形态）：水位正确时行为不变", async () => {
  const { host, frames } = createHost({ loadMode: "deferred" });
  const gateway = new ConversationV4Gateway(host, {
    createLogEpoch: () => "epoch-repro-resume",
  });

  await subscribeConversation(gateway, frames);
  const conversationFramesAfterSubscribe = frames.filter((f) => f.topic === TOPIC).length;

  gateway.ingest(SESSION_ID, turnStarted(3));
  gateway.ingest(SESSION_ID, turnComplete(4));
  await sleep(150);

  assert.ok(
    frames.filter((f) => f.topic === TOPIC).length > conversationFramesAfterSubscribe,
    "resume 形态下 live 事件必须继续投递",
  );
  gateway.dispose();
});

test("loadPersistedEvents 真故障时 gateway 必须经 onError 留痕（诊断不静默）", async () => {
  const { host, frames, errors } = createHost({ loadMode: "broken" });
  const gateway = new ConversationV4Gateway(host, {
    createLogEpoch: () => "epoch-repro-broken",
  });

  await subscribeConversation(gateway, frames);
  assert.ok(
    errors.some((entry) => entry.scope === "v4.hydrate"),
    "hydrate 加载失败必须产出 v4.hydrate onError 诊断",
  );
  gateway.dispose();
});
