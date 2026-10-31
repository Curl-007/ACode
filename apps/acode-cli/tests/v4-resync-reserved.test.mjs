// v4/conversation/resync 的 gateway 级直测（M2-3 spec §5D.1 补洞：resyncReserved
// 此前全仓零覆盖）。复用 v4-deferred-live-session-repro.test.mjs 的 host 桩模式。
//
// 钉住：
// 1. resume/snapshot 裁决矩阵：base 有效（logEpoch 匹配且 floor≤seq≤current）→ resume
//    （deltas，fromSeq=base.seq）；forceSnapshot / 陈旧 logEpoch / base=null → snapshot
//    （fromSeq=0）。
// 2. post-response outbox 次序：resync admission 后、调用方「发送」响应线帧（initialWires）
//    前到达的 live 事件必须缓存在订阅缓冲里，在线 flush 帧严格排在响应线帧之后
//    （响应先行 = 客户端恢复基线先于新事实到达）。
// 3. 所有权：subscriptionId/connectionId 不匹配 → fault.subscription.notOwned。
// 每个 clientMode（desktop-continuous / web-remote-replayable）各跑一遍——profile 只影响
// 投递调度与流式过滤，不影響 resume/snapshot 裁决语义。

import assert from "node:assert/strict";
import test from "node:test";

const { ConversationV4Gateway } = await import(
  "../packages/bootstrap/src/acode-protocol-v4/v4-gateway.ts"
);
const { SessionEventType } = await import(
  "../packages/contracts/src/events/session.events.ts"
);

const SESSION_ID = "sess_resync_probe";
const TOPIC = `conversation/${SESSION_ID}`;
const WORKSPACE_ID = "ws-resync";

function makeEvent(sequenceNumber, type, payload) {
  return {
    id: `evt_${sequenceNumber}`,
    sessionId: SESSION_ID,
    turnId: "turn_resync",
    type,
    timestamp: new Date(1700000000000 + sequenceNumber),
    traceId: "trace_resync",
    sequenceNumber,
    payload,
  };
}

function titleUpdated(sequenceNumber, title) {
  return makeEvent(sequenceNumber, SessionEventType.SessionTitleUpdated, { title });
}

function createHost() {
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
    // deferred live 会话：订阅时点无持久行，但内存水位=2（生产 eventStore
    // getLatestSequenceNumber 语义，同 repro 测试）。
    loadPersistedEvents: async () => ({ events: [], synthesized: false, sourceEventSeq: 2 }),
    getSessionWorkspaceId: () => WORKSPACE_ID,
    getSessionIndexMeta: () => ({ createdAt: 1, lastActivityAt: 2 }),
    listWorkspaceSessionIds: () => [],
    isDraftSession: () => false,
    getStoredSessionSummaries: () => [],
    executeCommand: async () => undefined,
  };
  return { host, frames, errors };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 线帧可能是物理分片信封：宽容取内层 frame。 */
function frameOf(wire) {
  return wire.frame ?? wire;
}

function payloadOf(wire) {
  const frame = frameOf(wire);
  return frame.payload ?? undefined;
}

async function runResyncScenario(clientMode) {
  const { host, frames } = createHost();
  const gateway = new ConversationV4Gateway(host, {
    createLogEpoch: () => "epoch-resync",
  });

  const subscribeDispatch = await gateway.subscribe({
    topic: TOPIC,
    connectionId: "conn-resync",
    clientMode,
  });
  const { subscriptionId, logEpoch } = subscribeDispatch.ack;
  assert.equal(logEpoch, "epoch-resync");
  // publisher 日志水位是按提交事件自增的（初始快照 toSeq=0），与 raw sequenceNumber
  // 无关——base 一律从观测到的帧水位派生，不在测试里写死编号。
  const baseWatermark = frameOf(subscribeDispatch.initialWires[0]).toSeq;
  subscribeDispatch.commit();
  await sleep(300);

  // 三个标题事件推进水位（raw seq 1-2 是 v4 sink 不转发的 runtime 内部事件，同 repro）。
  gateway.ingest(SESSION_ID, titleUpdated(3, "t3"));
  gateway.ingest(SESSION_ID, titleUpdated(4, "t4"));
  gateway.ingest(SESSION_ID, titleUpdated(5, "t5"));
  await sleep(300);

  const conversationFrames = frames.filter((wire) => wire.topic === TOPIC);
  const currentWatermark = frameOf(conversationFrames[conversationFrames.length - 1]).toSeq;
  assert.ok(
    currentWatermark > baseWatermark,
    `ingest 必须推进水位（base=${baseWatermark}, current=${currentWatermark}）`,
  );
  return { gateway, frames, subscriptionId, logEpoch, baseWatermark, currentWatermark };
}

for (const clientMode of ["desktop-continuous", "web-remote-replayable"]) {
  test(`resync(${clientMode}): base 有效 → resume 裁决（deltas，fromSeq=base.seq，toSeq=currentSeq）`, async () => {
    const { gateway, frames, subscriptionId, logEpoch, baseWatermark, currentWatermark } =
      await runResyncScenario(clientMode);
    const framesBeforeResync = frames.length;

    const dispatch = gateway.resyncReserved({
      topic: TOPIC,
      subscriptionId,
      connectionId: "conn-resync",
      base: { logEpoch, seq: baseWatermark },
    });
    assert.equal(dispatch.ack.mode, "resume", "base 有效必须裁 resume");
    assert.equal(dispatch.ack.subscriptionId, subscriptionId, "same-sub 恢复保持 subId 不变");
    // 裁决期不得有在线帧逸出（恢复线帧由调用方随响应发出，不经 emitWireFrame）。
    assert.equal(frames.length, framesBeforeResync, "resync admission 不得直接 emit");

    const recoveryWire = dispatch.initialWires[0];
    assert.ok(recoveryWire, "resume 裁决必须携带增量线帧");
    const recoveryFrame = frameOf(recoveryWire);
    assert.equal(recoveryFrame.fromSeq, baseWatermark, "resume 帧从 base.seq 起");
    assert.equal(recoveryFrame.toSeq, currentWatermark, "resume 帧到当前水位");
    const payload = payloadOf(recoveryWire);
    assert.equal(payload.kind, "deltas", "resume 载荷必须是 deltas");
    assert.ok(payload.deltas.length > 0, "base 之后的事实必须重放");

    dispatch.commit();
  });

  test(`resync(${clientMode}): forceSnapshot / 陈旧 logEpoch / base=null → snapshot 裁决（fromSeq=0）`, async () => {
    const { gateway, subscriptionId, logEpoch, currentWatermark } =
      await runResyncScenario(clientMode);

    const forced = gateway.resyncReserved({
      topic: TOPIC,
      subscriptionId,
      connectionId: "conn-resync",
      base: { logEpoch, seq: currentWatermark },
      forceSnapshot: true,
    });
    assert.equal(forced.ack.mode, "snapshot", "forceSnapshot 必须压倒有效 base");
    assert.equal(frameOf(forced.initialWires[0]).fromSeq, 0);
    assert.equal(payloadOf(forced.initialWires[0]).kind, "snapshot");
    forced.commit();

    const stale = gateway.resyncReserved({
      topic: TOPIC,
      subscriptionId,
      connectionId: "conn-resync",
      base: { logEpoch: "epoch-old", seq: 3 },
    });
    assert.equal(stale.ack.mode, "snapshot", "logEpoch 不匹配必须裁 snapshot");
    stale.commit();

    const noBase = gateway.resyncReserved({
      topic: TOPIC,
      subscriptionId,
      connectionId: "conn-resync",
      base: null,
    });
    assert.equal(noBase.ack.mode, "snapshot", "base=null 必须裁 snapshot");
    noBase.commit();
  });

  test(`resync(${clientMode}): post-response outbox 次序——响应线帧先于其后到达的 live flush`, async () => {
    const { gateway, frames, subscriptionId, logEpoch, baseWatermark } =
      await runResyncScenario(clientMode);

    const dispatch = gateway.resyncReserved({
      topic: TOPIC,
      subscriptionId,
      connectionId: "conn-resync",
      base: { logEpoch, seq: baseWatermark },
    });
    assert.equal(dispatch.ack.mode, "resume");

    // admission 后、响应线帧发出前，新 live 事件到达：必须进订阅缓冲，不得抢先逸出。
    gateway.ingest(SESSION_ID, titleUpdated(6, "t6-post-resync"));
    await sleep(300);
    assert.ok(
      !frames.some((wire) => JSON.stringify(wire).includes("t6-post-resync")),
      "响应线帧发出前，新事实不得出现在在线 flush（outbox 次序）",
    );

    // 调用方随响应发出恢复线帧，随后 commit 释放缓冲。
    const responseOutboxIndex = frames.length;
    for (const wire of dispatch.initialWires) frames.push(wire);
    dispatch.commit();
    await sleep(300);

    // 恢复线帧不得包含 admission 之后才到达的事实（admission 时刻的重放内容已编码定稿）。
    assert.ok(
      !dispatch.initialWires.some((wire) => JSON.stringify(wire).includes("t6-post-resync")),
      "恢复线帧不得夹带 admission 后到达的事实",
    );
    const liveIndex = frames.findIndex(
      (wire, index) =>
        index > responseOutboxIndex && JSON.stringify(wire).includes("t6-post-resync"),
    );
    assert.ok(liveIndex > responseOutboxIndex, "新事实 flush 必须排在响应线帧之后");
  });

  test(`resync(${clientMode}): subscriptionId/connectionId 不属本连接 → fault.subscription.notOwned`, async () => {
    const { gateway, subscriptionId, logEpoch } = await runResyncScenario(clientMode);
    assert.throws(
      () =>
        gateway.resyncReserved({
          topic: TOPIC,
          subscriptionId,
          connectionId: "conn-intruder",
          base: { logEpoch, seq: 3 },
        }),
      /fault\.subscription\.notOwned/,
    );
  });
}
