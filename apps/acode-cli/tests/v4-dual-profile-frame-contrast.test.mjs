// 双订阅帧对照（M2-3 spec §5D.2 补洞）：同一 gateway 同一会话挂 desktop-continuous +
// web-remote-replayable 两个 connectionId，ingest 同一事件流，断言：
// 1. 两 profile 帧流各自合规——replayable 抑制 inputText/output.text/summaryText 流式
//    delta（DELIVERY_PROFILES.replayable.streamPaths，core.ts:46-58），continuous 全放行；
//    结构性 delta（row.appended/row.upserted/state.updated）两 profile 恒透传。
// 2. 终态一致——被 profile 过滤的流式内容由收口 row.upserted 携带完整字段补回
//    （profiles.ts 收口不变量），两流最终产品事实逐字节一致。
// delivery-profile-contrast.test.mjs 钉的是 filter 纯函数；本文件钉 gateway 管线
// （subscribe→ingest→flush→emitWireFrame）按 profile 正确分叉。

import assert from "node:assert/strict";
import test from "node:test";

const { ConversationV4Gateway } = await import(
  "../packages/bootstrap/src/acode-protocol-v4/v4-gateway.ts"
);
const { DELIVERY_PROFILES } = await import(
  "../../../packages/shared/src/acode-protocol-v4/core.ts"
);
const { SessionEventType } = await import(
  "../packages/contracts/src/events/session.events.ts"
);

const SESSION_ID = "sess_dual_profile";
const TOPIC = `conversation/${SESSION_ID}`;
const WORKSPACE_ID = "ws-dual";

function makeEvent(sequenceNumber, type, payload) {
  return {
    id: `evt_${sequenceNumber}`,
    sessionId: SESSION_ID,
    turnId: "turn_dual",
    type,
    timestamp: new Date(1700000000000 + sequenceNumber),
    traceId: "trace_dual",
    sequenceNumber,
    payload,
  };
}

function createHost() {
  const frames = [];
  const host = {
    sessionExists: () => true,
    emitWireFrame: (frame) => {
      frames.push(frame);
    },
    onError: () => {},
    loadPersistedEvents: async () => ({ events: [], synthesized: false, sourceEventSeq: 2 }),
    getSessionWorkspaceId: () => WORKSPACE_ID,
    getSessionIndexMeta: () => ({ createdAt: 1, lastActivityAt: 2 }),
    listWorkspaceSessionIds: () => [],
    isDraftSession: () => false,
    getStoredSessionSummaries: () => [],
    executeCommand: async () => undefined,
  };
  return { host, frames };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 提取某订阅收到的全部 conversation delta（跨帧按到达序展开）。 */
function deltasFor(frames, subscriptionId) {
  return frames
    .filter((wire) => wire.subscriptionId === subscriptionId)
    .flatMap((wire) => {
      const payload = (wire.frame ?? wire).payload;
      return payload?.kind === "deltas" ? payload.deltas : [];
    });
}

/** 终态产品事实：两流各自可见的 row.upserted 收口行（rowId→行内容映射）。 */
function terminalRows(frames, subscriptionId) {
  const rows = new Map();
  for (const wire of frames.filter((w) => w.subscriptionId === subscriptionId)) {
    const payload = (wire.frame ?? wire).payload;
    if (payload?.kind !== "deltas") continue;
    for (const delta of payload.deltas) {
      if (delta.op === "row.upserted") rows.set(delta.row.rowId, delta.row);
    }
  }
  return rows;
}

test("双订阅同流：continuous 放行 inputText 流式，replayable 抑制且终态经收口行一致", async () => {
  const { host, frames } = createHost();
  const gateway = new ConversationV4Gateway(host, { createLogEpoch: () => "epoch-dual" });

  const desktop = await gateway.subscribe({
    topic: TOPIC,
    connectionId: "conn-desktop",
    clientMode: "desktop-continuous",
  });
  desktop.commit();
  const web = await gateway.subscribe({
    topic: TOPIC,
    connectionId: "conn-web",
    clientMode: "web-remote-replayable",
  });
  web.commit();
  await sleep(300);

  // 同一事实流，分窗口推进：publisher 的 flush 合并会把同窗口内的流式 row.delta 折叠进
  // 收口 row.upserted，必须把流式事件放进独立窗口才能观测到 profile 分叉。
  gateway.ingest(
    SESSION_ID,
    makeEvent(3, SessionEventType.TurnStarted, {
      input: "列出目录",
      turnNumber: 1,
      messageId: "msg_user_1",
    }),
  );
  gateway.ingest(
    SESSION_ID,
    makeEvent(4, SessionEventType.ToolCallScheduled, {
      toolCallId: "tc-1",
      toolName: "Bash",
      input: { command: "ls -la" },
    }),
  );
  await sleep(300);
  gateway.ingest(
    SESSION_ID,
    makeEvent(5, SessionEventType.ModelStreaming, {
      kind: "tool_input_delta",
      toolCallId: "tc-1",
      delta: "ls -la",
      done: false,
    }),
  );
  await sleep(300);
  gateway.ingest(
    SESSION_ID,
    makeEvent(6, SessionEventType.ModelStreaming, {
      kind: "text_start",
      delta: "",
      done: false,
    }),
  );
  gateway.ingest(
    SESSION_ID,
    makeEvent(7, SessionEventType.ModelStreaming, {
      kind: "text_delta",
      delta: "目录如下",
      done: false,
    }),
  );
  await sleep(300);
  gateway.ingest(
    SESSION_ID,
    makeEvent(8, SessionEventType.ModelStreaming, {
      kind: "text_end",
      delta: "",
      done: true,
    }),
  );
  gateway.ingest(
    SESSION_ID,
    makeEvent(9, SessionEventType.TurnComplete, { turnId: "turn_dual" }),
  );
  await sleep(400);

  const desktopDeltas = deltasFor(frames, desktop.ack.subscriptionId);
  const webDeltas = deltasFor(frames, web.ack.subscriptionId);
  assert.ok(desktopDeltas.length > 0, "desktop 订阅必须收到事实流");
  assert.ok(webDeltas.length > 0, "web 订阅必须收到事实流");

  // ── 1. 各自合规 ──
  const desktopRowDeltaPaths = new Set(
    desktopDeltas.filter((d) => d.op === "row.delta").map((d) => d.path),
  );
  const webRowDeltaPaths = new Set(
    webDeltas.filter((d) => d.op === "row.delta").map((d) => d.path),
  );
  assert.ok(
    desktopRowDeltaPaths.has("inputText"),
    "continuous profile 必须放行 inputText 流式（streamPaths.inputText=true）",
  );
  assert.ok(
    !webRowDeltaPaths.has("inputText"),
    "replayable profile 必须抑制 inputText 流式（streamPaths.inputText=false）",
  );
  assert.ok(
    webRowDeltaPaths.has("text"),
    "replayable profile 仍放行 text 流式（streamPaths.text=true）",
  );
  // 结构性 delta 两 profile 恒透传（filter 只拦 row.delta）。
  for (const deltas of [desktopDeltas, webDeltas]) {
    assert.ok(
      deltas.some((d) => d.op === "row.appended"),
      "row.appended 结构性事件两 profile 都必须透传",
    );
  }
  // 与参数表交叉核对（防 profile 表改动后测试空转）。
  assert.equal(DELIVERY_PROFILES.continuous.streamPaths.inputText, true);
  assert.equal(DELIVERY_PROFILES.replayable.streamPaths.inputText, false);

  // ── 2. 终态一致 ──
  // 同一权威日志：两流最后一个帧的 toSeq 必须一致（水位与 profile 无关）。
  const lastToSeq = (subscriptionId) => {
    const wires = frames.filter((w) => w.subscriptionId === subscriptionId);
    return (wires[wires.length - 1].frame ?? wires[wires.length - 1]).toSeq;
  };
  assert.equal(
    lastToSeq(desktop.ack.subscriptionId),
    lastToSeq(web.ack.subscriptionId),
    "两 profile 终态水位必须一致",
  );
  // 收口行逐字节一致：被 replayable 抑制的流式输入经 row.upserted 完整字段补回。
  const desktopRows = terminalRows(frames, desktop.ack.subscriptionId);
  const webRows = terminalRows(frames, web.ack.subscriptionId);
  assert.ok(desktopRows.size > 0 && webRows.size > 0, "两流都必须有收口行");
  assert.deepEqual(
    [...webRows.entries()].sort(([a], [b]) => a - b),
    [...desktopRows.entries()].sort(([a], [b]) => a - b),
    "两 profile 终态收口行必须逐字节一致（replayable 靠收口补回被抑制的流式内容）",
  );
});
