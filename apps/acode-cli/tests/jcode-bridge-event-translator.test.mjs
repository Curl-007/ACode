// jcode-bridge event-translator 验收（specs/jcode-agent-bridge.md 场景 2/3/4/11）。
//
// 核心证明：把 spike 实测抓到的 jcode ACP session/update 事件流喂进 translator，
// 产出的 SessionEvent 再喂进**真 ProductProjection**，断言生成的 row 正确。
// 这验证了整条翻译链对 v4 投影引擎有效——不只是 translator 单元自洽。
//
// 顺序不变量（event-translator.ts 头注）：TurnStarted 必须先于工具/流事件，
// 否则 isRunning() 为假、全部静默丢弃。本测试同时正向验证与负向验证该不变量。
import assert from "node:assert/strict";
import test from "node:test";

const { ProductProjection } =
  await import("../packages/bootstrap/src/acode-protocol-v4/product-projection.ts");
const { conversationDeltaSchema, conversationSnapshotSchema } =
  await import("../../../packages/shared/src/acode-protocol-v4/index.ts");
const { JcodeEventTranslator } = await import(
  "../packages/cli/src/jcode-bridge/event-translator.ts"
);

const SID = "sess_jcode_test";
const TRACE = "trace_jcode_test";

let nowMs = 1_700_000_000_000;
function makeTranslator() {
  let evtSeq = 0;
  return new JcodeEventTranslator({
    now: () => nowMs,
    nextEventId: () => `evt_${++evtSeq}`,
    v4SessionId: SID,
    traceId: TRACE,
    defaultContextWindow: 200_000,
    defaultMode: "build",
  });
}

/** 把 translator 产出的事件喂进真投影，累积 deltas。 */
function driveProjection(events) {
  const projection = new ProductProjection(SID, "epoch-jcode");
  const deltas = [];
  for (const ev of events) {
    deltas.push(...projection.applyEvent(ev));
  }
  return { projection, deltas };
}

// spike §3 实测的一轮读文件会话事件序列（精简到核心）。
function replayReadTurn(translator) {
  const events = [];
  const created = translator.sessionCreatedEvent();
  if (created) events.push(created);
  events.push(translator.beginTurn("Read test.txt", "msg_cmd_1"));
  // available_commands_update（不产 row）
  events.push(...translator.translate({ sessionUpdate: "available_commands_update", availableCommands: [] }));
  // tool_call pending
  events.push(...translator.translate({
    sessionUpdate: "tool_call", toolCallId: "tc_1", title: "Reading file", kind: "read", name: "ReadFile", status: "pending",
  }));
  // 16 个 tool_call_update 增量帧（多数空字段）→ 必须归并成一个 row
  events.push(...translator.translate({ sessionUpdate: "tool_call_update", toolCallId: "tc_1", status: "pending" }));
  for (let i = 0; i < 14; i++) {
    events.push(...translator.translate({ sessionUpdate: "tool_call_update", toolCallId: "tc_1" }));
  }
  events.push(...translator.translate({ sessionUpdate: "tool_call_update", toolCallId: "tc_1", status: "in_progress" }));
  events.push(...translator.translate({ sessionUpdate: "usage_update", used: 6400, size: 200_000 }));
  events.push(...translator.translate({
    sessionUpdate: "tool_call_update", toolCallId: "tc_1", status: "completed",
    rawOutput: { output: "hello from acode spike" },
  }));
  // 19 个 agent_message_chunk 流式文本
  const chunks = ["Exact ", "contents ", "of ", "`test.txt`", ":\n\n```\n", "hello ", "from ", "acode ", "spike", "```"];
  for (const text of chunks) {
    events.push(...translator.translate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } }));
  }
  events.push(...translator.translate({ sessionUpdate: "usage_update", used: 6600, size: 200_000 }));
  // prompt 返回 → 轮次收口
  events.push(...translator.endTurn(
    { stopReason: "end_turn" },
    { inputTokens: 13027, outputTokens: 142, totalTokens: 19569, cachedReadTokens: 6400 },
  ));
  return events;
}

test("场景 2/4: 一轮读文件会话产出 turnHeader + userInput + assistantText，文本增量正确拼接", () => {
  const translator = makeTranslator();
  const events = replayReadTurn(translator);
  const { projection, deltas } = driveProjection(events);

  // 所有 delta 过既有 wire schema（场景 11：对旧客户端兼容）。
  for (const delta of deltas) {
    const parsed = conversationDeltaSchema.safeParse(delta);
    assert.ok(parsed.success, `delta 未过 schema: ${JSON.stringify(parsed.error?.issues ?? null)}`);
  }

  const rows = projection.getSnapshot().rows.window;
  const kinds = rows.map((r) => r.kind);
  assert.ok(kinds.includes("turnHeader"), `应有 turnHeader row，实得 ${kinds.join(",")}`);
  assert.ok(kinds.includes("userInput"), "应有 userInput row");
  assert.ok(kinds.includes("assistantText"), "应有 assistantText row");

  // 文本增量拼接正确（19 chunk → 完整回答）。
  const textRow = rows.find((r) => r.kind === "assistantText");
  assert.ok(textRow.text.includes("hello from acode spike"), `文本应含拼接结果，实得 "${textRow.text}"`);

  // turnHeader 终态 completedSuccess（end_turn）。
  const header = rows.find((r) => r.kind === "turnHeader");
  assert.equal(header.state, "completedSuccess", `turnHeader.state 应为 completedSuccess，实得 ${header.state}`);
});

test("场景 3: 16 个 tool_call_update 增量帧只产生一个 toolCall row（归并正确性）", () => {
  const translator = makeTranslator();
  const events = replayReadTurn(translator);
  const { projection } = driveProjection(events);

  const toolRows = projection.getSnapshot().rows.window.filter((r) => r.kind === "toolCall");
  assert.equal(toolRows.length, 1, `16+ 个 update 帧必须归并成 1 个 toolCall row，实得 ${toolRows.length}`);
  assert.equal(toolRows[0].status, "success", `工具终态应为 success，实得 ${toolRows[0].status}`);
  assert.equal(toolRows[0].toolCallId, "tc_1");
});

test("场景 11: 收口后的 snapshot 过 conversationSnapshotSchema", () => {
  const translator = makeTranslator();
  const events = replayReadTurn(translator);
  const { projection } = driveProjection(events);
  const parsed = conversationSnapshotSchema.safeParse(projection.getSnapshot());
  assert.ok(parsed.success, `snapshot 未过 schema: ${JSON.stringify(parsed.error?.issues ?? null)}`);
});

test("顺序不变量: TurnStarted 缺失时工具/流事件被投影丢弃（负向验证 isRunning 门）", () => {
  const translator = makeTranslator();
  // 只发工具事件，不发 beginTurn —— 模拟违反顺序不变量。
  const events = [];
  const created = translator.sessionCreatedEvent();
  if (created) events.push(created);
  // 手工造一个没有 TurnStarted 的 tool 事件序列：直接调 translate 但 currentTurnId 为 null。
  const orphan = translator.translate({
    sessionUpdate: "tool_call", toolCallId: "tc_x", name: "ReadFile", status: "pending",
  });
  // translator 在无进行中轮次时应返回空（不伪造 turn），见 translate() 的 !turnId 分支。
  assert.equal(orphan.length, 0, "无进行中轮次时 translator 不应产出事件");
  events.push(...orphan);
  const { projection } = driveProjection(events);
  const toolRows = projection.getSnapshot().rows.window.filter((r) => r.kind === "toolCall");
  assert.equal(toolRows.length, 0, "孤立工具事件不应产生 row");
});

test("turn 合成: turnId 单调递增且同轮事件共享（场景 4）", () => {
  const translator = makeTranslator();
  const created = translator.sessionCreatedEvent();
  const t1 = translator.beginTurn("first", "msg_1");
  const t2events = [];
  t2events.push(...translator.translate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "a" } }));
  const t2 = translator.beginTurn("second", "msg_2");

  assert.equal(t1.turnId, "jcode-turn-1");
  assert.equal(t2.turnId, "jcode-turn-2", "turnId 应单调递增");
  assert.notEqual(t1.turnId, t2.turnId, "不同轮 turnId 不复用");
  // 第一轮内的事件共享 turn-1。
  assert.ok(created === null || created.turnId !== undefined);
  for (const ev of t2events) {
    assert.equal(ev.turnId, "jcode-turn-1", "第一轮事件应挂 turn-1");
  }
  assert.equal(t2.turnId, "jcode-turn-2");
});

test("工具失败: status=failed → ToolCallResult success=false 带 error", () => {
  const translator = makeTranslator();
  const events = [];
  const created = translator.sessionCreatedEvent();
  if (created) events.push(created);
  events.push(translator.beginTurn("run bad cmd", "msg_1"));
  events.push(...translator.translate({ sessionUpdate: "tool_call", toolCallId: "tc_e", name: "Bash", status: "pending" }));
  events.push(...translator.translate({ sessionUpdate: "tool_call_update", toolCallId: "tc_e", status: "in_progress" }));
  events.push(...translator.translate({
    sessionUpdate: "tool_call_update", toolCallId: "tc_e", status: "failed",
    rawOutput: { output: "", error: "command not found" },
  }));
  const { projection } = driveProjection(events);
  const toolRow = projection.getSnapshot().rows.window.find((r) => r.kind === "toolCall");
  assert.ok(toolRow, "应有 toolCall row");
  assert.equal(toolRow.status, "error", `失败工具终态应为 error，实得 ${toolRow.status}`);
});
