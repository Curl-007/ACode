import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * review §7 盲区 4：两条交付链路的对照测试（AGENTS.md「Desktop 的 desktop-continuous 实时链路
 * 与手机的 web-remote-replayable 恢复链路必须明确区分……修改 stream/snapshot/queue 或重连时，
 * 同时验证两种语义」）。
 *
 * 两个 profile 是 CLI flush 管线的参数表（core.ts:34-59，「客户端代码禁止出现 profile 变量」）：
 *   - continuous（desktop-continuous）：flushWindowMs=30，流式 text/inputText/output.text/summaryText，
 *     streamOutputCapBytes=262144，toolProgress=false，desktopOnlyRows=true；
 *   - replayable（web-remote-replayable）：flushWindowMs=150，只流式 text（inputText/output.text/
 *     summaryText 被抑制），streamOutputCapBytes=0，toolProgress=true，desktopOnlyRows=false。
 *
 * 收口不变量（profiles.ts:5-8 / coalesce.ts:2）：被 profile 过滤的流式 delta 必须最终被某个不可
 * 过滤的结构事件（row.upserted 携带完整字段）收口，于是**同一事实流**经两种 profile 投影后，
 * 终态必须逐字节一致。本文件用 applyConversationDeltas 对同一 delta 序列分别过两个 profile 的
 * filter，断言：(a) 各自语义（哪些字段被抑制、结构事件恒透传）；(b) 终态 byte-identical；
 * (c) 一个 profile 的语义不泄漏到另一个；(d) hello 的 clientMode↔deliveryProfile 绑定。
 *
 * 纯函数，无 IO / 子进程 / sleep。apply reducer 是结构化的（不走 zod 校验），故 row 用最小形状。
 */

const { DELIVERY_PROFILES } = await import(
  "../../../packages/shared/src/acode-protocol-v4/core.ts"
);
const { filterConversationDeltasForProfile } = await import(
  "../../../packages/shared/src/acode-protocol-v4/profiles.ts"
);
const { applyConversationDeltas } = await import(
  "../../../packages/shared/src/acode-protocol-v4/apply.ts"
);
const { helloMessageSchema } = await import(
  "../../../packages/shared/src/acode-protocol-v4/transport.ts"
);
const { V4_WIRE_PROTOCOL_VERSION } = await import(
  "../../../packages/shared/src/acode-protocol-v4/core.ts"
);

const CONTINUOUS = DELIVERY_PROFILES.continuous;
const REPLAYABLE = DELIVERY_PROFILES.replayable;

/** 空快照（apply reducer 只读 rows.window / totalCount / firstRowId）。 */
function emptySnapshot() {
  return { rows: { firstRowId: null, totalCount: 0, window: [] } };
}

function toolCallRow(rowId, { inputText = "", outputText = "" } = {}) {
  return {
    createdAt: 1_700_000_000_000,
    createdAtSeq: rowId,
    inputText,
    kind: "toolCall",
    output: { text: outputText },
    rowId,
    toolCallId: `tc-${rowId}`,
    toolName: "Bash",
    turnId: "turn-1",
  };
}

function assistantTextRow(rowId, text = "") {
  return {
    createdAt: 1_700_000_000_000,
    createdAtSeq: rowId,
    kind: "assistantText",
    rowId,
    text,
    turnId: "turn-1",
  };
}

/**
 * 同一事实流（权威日志序）：工具行的流式 inputText/output.text、文本行的流式 text，
 * 每条流式序列都以一条携带完整字段的 row.upserted 收口。
 */
function factStream() {
  return [
    { op: "row.appended", row: toolCallRow(1) },
    { op: "row.delta", rowId: 1, path: "inputText", append: "ls " },
    { op: "row.delta", rowId: 1, path: "inputText", append: "-la" },
    { op: "row.delta", rowId: 1, path: "output.text", append: "total 0" },
    // 收口：工具输入/输出定稿，携带完整字段（replayable 靠它补回被抑制的流式内容）。
    { op: "row.upserted", row: toolCallRow(1, { inputText: "ls -la", outputText: "total 0" }) },
    { op: "row.appended", row: assistantTextRow(2) },
    { op: "row.delta", rowId: 2, path: "text", append: "he" },
    { op: "row.delta", rowId: 2, path: "text", append: "llo" },
    { op: "row.upserted", row: assistantTextRow(2, "hello") },
  ];
}

// ── a. profile 参数表本身的语义分叉 ──────────────────────────────────────────

test("profile(1): 两 profile 参数表分叉——flush 窗口/流式路径/toolProgress/cap/desktopOnly", () => {
  // flush 窗口：continuous 30ms（实时），replayable 150ms（恢复回放，攒批）。
  assert.equal(CONTINUOUS.flushWindowMs, 30);
  assert.equal(REPLAYABLE.flushWindowMs, 150);
  // 流式路径：continuous 全开；replayable 只流 text，抑制 inputText/output.text/summaryText。
  assert.deepEqual(CONTINUOUS.streamPaths, {
    inputText: true,
    "output.text": true,
    summaryText: true,
    text: true,
  });
  assert.deepEqual(REPLAYABLE.streamPaths, {
    inputText: false,
    "output.text": false,
    summaryText: false,
    text: true,
  });
  // toolProgress：continuous 关（走流式增量），replayable 开（进度事件补齐被抑制的流式）。
  assert.equal(CONTINUOUS.toolProgress, false);
  assert.equal(REPLAYABLE.toolProgress, true);
  // 流式输出上限：continuous 有（256KiB），replayable 为 0（不流式输出文本）。
  assert.equal(CONTINUOUS.streamOutputCapBytes, 262144);
  assert.equal(REPLAYABLE.streamOutputCapBytes, 0);
  // desktop-only 行：continuous 允许，replayable 不允许。
  assert.equal(CONTINUOUS.desktopOnlyRows, true);
  assert.equal(REPLAYABLE.desktopOnlyRows, false);
});

// ── b. filter 各自语义：哪些字段被抑制，结构事件恒透传 ────────────────────────

test("profile(2): filter——continuous 保留全部流式路径，replayable 抑制 inputText/output.text", () => {
  const deltas = factStream();
  const continuous = filterConversationDeltasForProfile(deltas, CONTINUOUS);
  const replayable = filterConversationDeltasForProfile(deltas, REPLAYABLE);

  const streamPaths = (list) => list.filter((d) => d.op === "row.delta").map((d) => d.path);
  // continuous：三种流式路径都在。
  assert.deepEqual(streamPaths(continuous), ["inputText", "inputText", "output.text", "text", "text"]);
  // replayable：只剩 text（inputText/output.text 被抑制）。
  assert.deepEqual(streamPaths(replayable), ["text", "text"], "replayable 必须抑制 inputText/output.text 流式");
  // replayable 抑制是纯减法：delta 数更少，且不含被禁路径。
  assert.ok(replayable.length < continuous.length, "replayable 投影的 delta 必须少于 continuous");
  assert.equal(
    replayable.some((d) => d.op === "row.delta" && d.path !== "text"),
    false,
    "replayable 泄漏了非 text 的流式 delta",
  );
});

test("profile(2b): filter——结构性事件（row.appended/row.upserted）两 profile 恒透传", () => {
  const deltas = factStream();
  const structural = (list) => list.filter((d) => d.op === "row.appended" || d.op === "row.upserted");
  assert.deepEqual(structural(filterConversationDeltasForProfile(deltas, CONTINUOUS)), structural(deltas));
  assert.deepEqual(structural(filterConversationDeltasForProfile(deltas, REPLAYABLE)), structural(deltas));
  // filter 是纯函数：不改入参。
  assert.equal(deltas.length, 9, "filter 不得修改入参 delta 序列");
});

// ── c. 收口不变量：同一事实流经两 profile 投影后终态 byte-identical ──────────

test("profile(3): 收口不变量——两 profile 投影同一事实流，终态逐字节一致", () => {
  const deltas = factStream();
  const continuousFinal = applyConversationDeltas(
    emptySnapshot(),
    filterConversationDeltasForProfile(deltas, CONTINUOUS),
  );
  const replayableFinal = applyConversationDeltas(
    emptySnapshot(),
    filterConversationDeltasForProfile(deltas, REPLAYABLE),
  );
  // 未过滤直接 apply 的权威终态（reducer 裁判）。
  const authoritativeFinal = applyConversationDeltas(emptySnapshot(), deltas);

  assert.deepEqual(replayableFinal, continuousFinal, "两 profile 终态必须逐字节一致");
  assert.deepEqual(continuousFinal, authoritativeFinal, "投影终态必须与权威 apply 一致");
  // 终态里工具输入/输出/文本都被 upsert 收口补全（replayable 没丢数据）。
  const toolRow = replayableFinal.rows.window.find((r) => r.kind === "toolCall");
  assert.equal(toolRow.inputText, "ls -la", "replayable 抑制了流式 inputText，但 upsert 收口补回完整值");
  assert.equal(toolRow.output.text, "total 0");
  const textRow = replayableFinal.rows.window.find((r) => r.kind === "assistantText");
  assert.equal(textRow.text, "hello");
});

test("profile(3b): 中间态确实分叉——replayable 在 upsert 前 inputText 为空，收口后补齐", () => {
  const deltas = factStream();
  // 只应用到 upsert 之前（前 4 条：appended + inputText×2 + output.text）。
  const beforeUpsert = deltas.slice(0, 4);
  const continuousMid = applyConversationDeltas(
    emptySnapshot(),
    filterConversationDeltasForProfile(beforeUpsert, CONTINUOUS),
  );
  const replayableMid = applyConversationDeltas(
    emptySnapshot(),
    filterConversationDeltasForProfile(beforeUpsert, REPLAYABLE),
  );
  const continuousTool = continuousMid.rows.window.find((r) => r.kind === "toolCall");
  const replayableTool = replayableMid.rows.window.find((r) => r.kind === "toolCall");
  // 中间态分叉：continuous 已流式拼出 inputText，replayable 还是空（抑制了流式）。
  assert.equal(continuousTool.inputText, "ls -la", "continuous 中途已流式拼接");
  assert.equal(replayableTool.inputText, "", "replayable 中途抑制流式，inputText 仍空");
  assert.equal(continuousTool.output.text, "total 0");
  assert.equal(replayableTool.output.text, "", "replayable 中途抑制 output.text 流式");
});

// ── d. hello：clientMode ↔ deliveryProfile 绑定，一个 profile 不泄漏到另一个 ──

function hello(clientMode, deliveryProfile) {
  return helloMessageSchema.safeParse({
    auth: {},
    capabilities: {
      binaryFrames: true,
      compression: "none",
      localTerminal: true,
      nativeDialogs: true,
    },
    clientMode,
    connectionId: "conn-1",
    deliveryProfile,
    kind: "hello",
    protocolVersion: V4_WIRE_PROTOCOL_VERSION,
    serverTime: 1_700_000_000_000,
  });
}

test("profile(4): hello 强制 clientMode↔deliveryProfile 一致；错配被拒（语义不串线）", () => {
  // 正例：desktop-continuous ↔ continuous。
  assert.equal(hello("desktop-continuous", "continuous").success, true);
  // 正例：web-remote-replayable ↔ replayable。
  assert.equal(hello("web-remote-replayable", "replayable").success, true);
  // 负例：desktop-continuous 却声明 replayable profile（桌面链路泄漏成恢复语义）。
  const leak1 = hello("desktop-continuous", "replayable");
  assert.equal(leak1.success, false, "desktop-continuous 不得绑定 replayable profile");
  assert.match(leak1.error?.issues?.[0]?.message ?? "", /clientMode and deliveryProfile must match/u);
  // 负例：web-remote-replayable 却声明 continuous profile（恢复链路泄漏成实时语义）。
  const leak2 = hello("web-remote-replayable", "continuous");
  assert.equal(leak2.success, false, "web-remote-replayable 不得绑定 continuous profile");
});

test("profile(5): 未知 deliveryProfile / clientMode 被拒（profile 词汇表是闭集）", () => {
  assert.equal(hello("desktop-continuous", "streaming").success, false);
  assert.equal(
    helloMessageSchema.safeParse({
      auth: {},
      capabilities: { binaryFrames: true, compression: "none", localTerminal: true, nativeDialogs: true },
      clientMode: "web-continuous",
      connectionId: "conn-1",
      deliveryProfile: "replayable",
      kind: "hello",
      protocolVersion: V4_WIRE_PROTOCOL_VERSION,
      serverTime: 0,
    }).success,
    false,
  );
});
