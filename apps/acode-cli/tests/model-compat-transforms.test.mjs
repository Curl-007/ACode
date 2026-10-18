import assert from "node:assert/strict";
import { test } from "node:test";

// spec: apps/acode-cli/specs/model-compat-flags.md R4 —— 转换器纯函数单测。
// 每个标志必须有「缺省 = 原引用返回 = 字节级零变化」断言（omp 纪律：无测试标志 = 未来散落的 if）。

const {
  transformStringSystemContent,
  transformSingleLeadingSystem,
  transformToolResultName,
  transformToolCallIdProfile,
  applyCompatTransforms,
} = await import("../packages/adapters/src/model/model-compat-transforms.ts");

// ------------------------------------------------------------
// T1 · requiresStringSystemContent
// ------------------------------------------------------------

test("T1: 单 text block 数组的 system content 还原为 string", () => {
  const body = {
    messages: [
      { role: "user", content: "hi" },
      { role: "system", content: [{ type: "text", text: "mid-conversation rule" }] },
    ],
  };
  const out = transformStringSystemContent(body, { requiresStringSystemContent: true });
  assert.equal(out.messages[1].content, "mid-conversation rule");
  assert.equal(out.messages[0].content, "hi");
});

test("T1: 标志缺省 → 原引用返回（零变化）", () => {
  const body = { messages: [{ role: "system", content: [{ type: "text", text: "x" }] }] };
  assert.equal(transformStringSystemContent(body, {}), body);
  assert.equal(transformStringSystemContent(body, { requiresStringSystemContent: null }), body);
});

test("T1: 非单块 / 带额外键（cache_control）/ 非 text block → 不动", () => {
  const flags = { requiresStringSystemContent: true };
  const multi = {
    messages: [{ role: "system", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }],
  };
  assert.equal(transformStringSystemContent(multi, flags), multi);
  const cached = {
    messages: [
      { role: "system", content: [{ type: "text", text: "a", cache_control: { type: "ephemeral" } }] },
    ],
  };
  assert.equal(transformStringSystemContent(cached, flags), cached);
  const image = { messages: [{ role: "system", content: [{ type: "image", source: {} }] }] };
  assert.equal(transformStringSystemContent(image, flags), image);
  const noMessages = { model: "x" };
  assert.equal(transformStringSystemContent(noMessages, flags), noMessages);
  // 顶层 system 字段（非 messages[]）不动。
  const topSystem = { system: [{ type: "text", text: "s" }], messages: [] };
  assert.equal(transformStringSystemContent(topSystem, flags), topSystem);
});

// ------------------------------------------------------------
// T2 · singleLeadingSystem
// ------------------------------------------------------------

test("T2: 多段开头 system 按原顺序 join('') 合并（wire 级等价迁移）", () => {
  const body = {
    messages: [
      { role: "system", content: "A" },
      { role: "system", content: "B" },
      { role: "user", content: "q" },
      { role: "system", content: "mid" }, // 非开头 system 不参与合并
    ],
  };
  const out = transformSingleLeadingSystem(body, { singleLeadingSystem: true });
  assert.equal(out.messages.length, 3);
  assert.deepEqual(out.messages[0], { role: "system", content: "AB" });
  assert.equal(out.messages[1].content, "q");
  assert.equal(out.messages[2].content, "mid");
});

test("T2: 末条 leading system 的额外字段随合并保留", () => {
  const body = {
    messages: [
      { role: "system", content: "A", metadata: 1 },
      { role: "system", content: "B", extra: "keep" },
      { role: "user", content: "q" },
    ],
  };
  const out = transformSingleLeadingSystem(body, { singleLeadingSystem: true });
  assert.deepEqual(out.messages[0], { role: "system", content: "AB", extra: "keep" });
});

test("T2: 标志缺省 / 单条或零条 leading system / 未知 content 形状 → 原引用（零变化）", () => {
  const multi = { messages: [{ role: "system", content: "A" }, { role: "system", content: "B" }] };
  assert.equal(transformSingleLeadingSystem(multi, {}), multi);
  const single = { messages: [{ role: "system", content: "A" }, { role: "user", content: "q" }] };
  assert.equal(transformSingleLeadingSystem(single, { singleLeadingSystem: true }), single);
  const none = { messages: [{ role: "user", content: "q" }] };
  assert.equal(transformSingleLeadingSystem(none, { singleLeadingSystem: true }), none);
  // fail-safe：wire 上 system content 应为 string；数组形状放弃合并直通。
  const weird = {
    messages: [{ role: "system", content: [{ text: "A" }] }, { role: "system", content: "B" }],
  };
  assert.equal(transformSingleLeadingSystem(weird, { singleLeadingSystem: true }), weird);
});

// ------------------------------------------------------------
// T3 · requiresToolResultName
// ------------------------------------------------------------

function chatBodyWithToolCall() {
  return {
    messages: [
      { role: "user", content: "q" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_abc", type: "function", function: { name: "read_file", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "call_abc", content: "file body" },
    ],
  };
}

test("T3: tool 消息缺 name → 从配对 assistant tool_call 回填", () => {
  const out = transformToolResultName(chatBodyWithToolCall(), { requiresToolResultName: true });
  assert.equal(out.messages[2].name, "read_file");
  assert.equal(out.messages[2].content, "file body");
});

test("T3: 标志缺省 → 原引用（零变化）", () => {
  const body = chatBodyWithToolCall();
  assert.equal(transformToolResultName(body, {}), body);
});

test("T3: 已有 name 不覆盖；无配对不发明；空 function name 不回填", () => {
  const flags = { requiresToolResultName: true };
  const named = chatBodyWithToolCall();
  named.messages[2].name = "existing";
  assert.equal(transformToolResultName(named, flags), named);

  const unpaired = chatBodyWithToolCall();
  unpaired.messages[2].tool_call_id = "call_unknown";
  assert.equal(transformToolResultName(unpaired, flags), unpaired);

  const emptyName = chatBodyWithToolCall();
  emptyName.messages[1].tool_calls[0].function.name = "";
  assert.equal(transformToolResultName(emptyName, flags), emptyName);

  const noCalls = { messages: [{ role: "tool", tool_call_id: "c1", content: "x" }] };
  assert.equal(transformToolResultName(noCalls, flags), noCalls);
});

// ------------------------------------------------------------
// T4 · toolCallIdProfile "openai-40"
// ------------------------------------------------------------

const OPENAI_40 = /^[A-Za-z0-9_-]{1,40}$/;

test("T4: 合规 id 一律不动（provider 原生 id 零变化，原引用返回）", () => {
  const body = {
    messages: [
      { role: "assistant", tool_calls: [{ id: "call_abc123", type: "function", function: { name: "t", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_abc123", content: "ok" },
    ],
  };
  assert.equal(transformToolCallIdProfile(body, { toolCallIdProfile: "openai-40" }), body);
  assert.equal(transformToolCallIdProfile(body, {}), body);
});

test("T4: 超长合成 id（settings-<uuid> 45 字符）一致性重写，assistant 与 tool 保持配对", () => {
  const longId = `settings-${"01234567-89ab-cdef-0123-456789abcdef"}`;
  assert.equal(longId.length, 45);
  const body = {
    messages: [
      { role: "assistant", tool_calls: [{ id: longId, type: "function", function: { name: "t", arguments: "{}" } }] },
      { role: "tool", tool_call_id: longId, content: "ok" },
    ],
  };
  const out = transformToolCallIdProfile(body, { toolCallIdProfile: "openai-40" });
  const rewritten = out.messages[0].tool_calls[0].id;
  assert.equal(out.messages[1].tool_call_id, rewritten);
  assert.match(rewritten, OPENAI_40);
  assert.match(rewritten, /^ac-[0-9a-f]{32}$/);
  // 原 body 不被就地修改（纯函数）。
  assert.equal(body.messages[0].tool_calls[0].id, longId);
});

test("T4: 确定性（跨调用稳定）与单射（不同原 id 不同映射）", () => {
  const flags = { toolCallIdProfile: "openai-40" };
  const idA = `launch-${"a".repeat(40)}`;
  const idB = `launch-${"b".repeat(40)}`;
  const mk = (id) => ({
    messages: [
      { role: "assistant", tool_calls: [{ id, type: "function", function: { name: "t", arguments: "{}" } }] },
      { role: "tool", tool_call_id: id, content: "ok" },
    ],
  });
  const first = transformToolCallIdProfile(mk(idA), flags).messages[0].tool_calls[0].id;
  const second = transformToolCallIdProfile(mk(idA), flags).messages[0].tool_calls[0].id;
  const other = transformToolCallIdProfile(mk(idB), flags).messages[0].tool_calls[0].id;
  assert.equal(first, second);
  assert.notEqual(first, other);
  assert.match(first, OPENAI_40);
  assert.match(other, OPENAI_40);
});

test("T4: 40/41 字符与非法字符边界", () => {
  const flags = { toolCallIdProfile: "openai-40" };
  const mk = (id) => ({ messages: [{ role: "tool", tool_call_id: id, content: "x" }] });
  const at40 = "a".repeat(40);
  const body40 = mk(at40);
  // 合规不动：返回原引用（字节级零变化）。
  assert.equal(transformToolCallIdProfile(body40, flags), body40);
  const at41 = "a".repeat(41);
  const out41 = transformToolCallIdProfile(mk(at41), flags);
  assert.notEqual(out41.messages[0].tool_call_id, at41);
  assert.match(out41.messages[0].tool_call_id, OPENAI_40);
  const badCharset = "toolu:01ABC.def";
  const outBad = transformToolCallIdProfile(mk(badCharset), flags);
  assert.match(outBad.messages[0].tool_call_id, OPENAI_40);
});

test("T4: Responses wire 形状（input[] 的 call_id）一致性重写", () => {
  const longId = `settings-${"01234567-89ab-cdef-0123-456789abcdef"}`;
  const body = {
    input: [
      { type: "function_call", call_id: longId, name: "t", arguments: "{}" },
      { type: "function_call_output", call_id: longId, output: "ok" },
      { type: "message", role: "user", content: "q" },
    ],
  };
  const out = transformToolCallIdProfile(body, { toolCallIdProfile: "openai-40" });
  assert.equal(out.input[0].call_id, out.input[1].call_id);
  assert.match(out.input[0].call_id, OPENAI_40);
  assert.deepEqual(out.input[2], body.input[2]);
});

// ------------------------------------------------------------
// 管道顺序
// ------------------------------------------------------------

test("applyCompatTransforms: 空标志 → 原引用（管道级零变化锚点）", () => {
  const body = { messages: [{ role: "system", content: [{ type: "text", text: "x" }] }] };
  assert.equal(applyCompatTransforms(body, {}), body);
});

test("applyCompatTransforms: 顺序 —— name 回填先于 id 重写（配对用原始 id）", () => {
  const longId = `launch-${"01234567-89ab-cdef-0123-456789abcdef"}`;
  const body = {
    messages: [
      { role: "assistant", tool_calls: [{ id: longId, type: "function", function: { name: "read_file", arguments: "{}" } }] },
      { role: "tool", tool_call_id: longId, content: "ok" },
    ],
  };
  const out = applyCompatTransforms(body, {
    requiresToolResultName: true,
    toolCallIdProfile: "openai-40",
  });
  // name 已回填，且 assistant/tool 的 id 被同一映射重写。
  assert.equal(out.messages[1].name, "read_file");
  assert.equal(out.messages[0].tool_calls[0].id, out.messages[1].tool_call_id);
  assert.match(out.messages[1].tool_call_id, OPENAI_40);
});

test("applyCompatTransforms: 未启用标志的转换器不执行（T2 未启用则多 system 保留）", () => {
  const body = {
    messages: [
      { role: "system", content: [{ type: "text", text: "A" }] },
      { role: "system", content: "B" },
    ],
  };
  const out = applyCompatTransforms(body, { requiresStringSystemContent: true });
  // T1 把第一条还原为 string；T2 未启用 → 不合并。
  assert.equal(out.messages[0].content, "A");
  assert.equal(out.messages.length, 2);
});
