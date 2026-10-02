// J5-L4 等价守卫：token 估算 length-based 投影优化（spec: apps/acode-cli/specs/token-estimate-perf.md）
// 断言优化后的 estimateMessageTokens 与「join 后取 length」的参考实现逐位相同。
// 优化只把 projectMessageContentForTokenEstimate 的 textParts.join("\n\n").length 换成累加长度，
// 其余（媒体平价、toolCall stringify、除数、ceil）不变；本测试独立复刻参考语义做交叉验证。
import assert from "node:assert/strict";
import { test } from "node:test";

const { COMPACT_ESTIMATE_INLINE_MEDIA_TOKENS, estimateMessageTokens } = await import(
  "../packages/core/src/compact/manual.ts"
);
const { modelMessageContentBlockToText } = await import(
  "../packages/contracts/src/model/index.ts"
);
const { ESTIMATED_TOKEN_CHAR_DIVISOR } = await import(
  "../../../packages/shared/src/usage-stats.ts"
);

// ── 参考实现：复刻优化前的 join-based 投影语义（manual.ts:158-183 旧版）──────────
function isInlineMediaBlockForTokenEstimateRef(block) {
  if (block.type === "image" || block.type === "video") return true;
  return (
    block.type === "file" &&
    (block.text === undefined || block.text.length === 0) &&
    (Boolean(block.dataUrl) || Boolean(block.uri))
  );
}

function projectTextRef(content) {
  if (typeof content === "string") return { text: content, inlineMediaTokens: 0 };
  const textParts = [];
  let inlineMediaTokens = 0;
  for (const block of content) {
    if (block.type === "reasoning") {
      if (block.text.length > 0) textParts.push(block.text);
      continue;
    }
    if (isInlineMediaBlockForTokenEstimateRef(block)) {
      inlineMediaTokens += COMPACT_ESTIMATE_INLINE_MEDIA_TOKENS;
      continue;
    }
    const text = modelMessageContentBlockToText(block);
    if (text.length > 0) textParts.push(text);
  }
  return { text: textParts.join("\n\n"), inlineMediaTokens };
}

function stringifyToolCallInputRef(input) {
  try {
    return JSON.stringify(input ?? {}) ?? "{}";
  } catch {
    return "{}";
  }
}

function estimateMessageTokensRef(messages) {
  return messages.reduce((total, message) => {
    const projection = projectTextRef(message.content);
    let estimatedCharacterCount = projection.text.length;
    for (const toolCall of message.toolCalls ?? []) {
      estimatedCharacterCount += (
        toolCall.name + stringifyToolCallInputRef(toolCall.input)
      ).length;
    }
    return (
      total +
      Math.ceil(estimatedCharacterCount / ESTIMATED_TOKEN_CHAR_DIVISOR) +
      projection.inlineMediaTokens
    );
  }, 0);
}

// ── 消息形状样本 ────────────────────────────────────────────────────────────
const text = (t) => ({ type: "text", text: t });
const reasoning = (t) => ({ type: "reasoning", text: t });
const image = () => ({ type: "image", image: "x".repeat(64), mediaType: "image/png" });
const video = () => ({ type: "video", video: "x".repeat(64), mediaType: "video/mp4" });
const fileDataUrl = () => ({ type: "file", dataUrl: "data:application/pdf;base64,AAA", filename: "d.pdf" });
const fileUri = () => ({ type: "file", uri: "https://example.com/a.pdf", filename: "a.pdf" });
const fileWithText = (t) => ({ type: "file", text: t, filename: "f.txt" });

const SAMPLE_MESSAGES = [
  { role: "user", content: "plain string content" },
  { role: "user", content: "" },
  { role: "user", content: [] },
  { role: "user", content: [text("single text block")] },
  { role: "user", content: [text("first"), text("second"), text("third")] },
  { role: "assistant", content: [reasoning("thinking hard"), text("answer")] },
  { role: "assistant", content: [reasoning(""), text("after empty reasoning")] },
  { role: "assistant", content: [reasoning("r1"), reasoning("r2"), text("t1")] },
  { role: "user", content: [text(""), text(""), text("only non-empty")] },
  { role: "user", content: [image()] },
  { role: "user", content: [video()] },
  { role: "user", content: [fileDataUrl()] },
  { role: "user", content: [fileUri()] },
  { role: "user", content: [fileWithText("file body counts as text")] },
  { role: "user", content: [text("before"), image(), text("after")] },
  { role: "user", content: [image(), video(), fileDataUrl(), fileUri()] },
  {
    role: "assistant",
    content: [reasoning("plan"), text("step")],
    toolCalls: [{ name: "bash", input: { command: "ls -la" } }],
  },
  {
    role: "assistant",
    content: [text("multi tool")],
    toolCalls: [
      { name: "write", input: { file_path: "/a/b.ts", content: "x".repeat(500) } },
      { name: "read", input: {} },
      { name: "weird", input: undefined },
    ],
  },
  {
    role: "assistant",
    content: [reasoning("r"), image(), text("t"), fileWithText("ft")],
    toolCalls: [{ name: "bash", input: { command: "echo hi", description: "d".repeat(200) } }],
  },
  { role: "user", content: [text("x".repeat(5000))] },
  {
    role: "assistant",
    content: Array.from({ length: 40 }, (_, i) => (i % 2 ? text(`t${i}`) : reasoning(`r${i}`))),
  },
];

test("L4 等价：优化后 estimateMessageTokens 与 join-based 参考逐位相同（逐消息）", () => {
  for (const message of SAMPLE_MESSAGES) {
    const optimized = estimateMessageTokens([message]);
    const reference = estimateMessageTokensRef([message]);
    assert.equal(
      optimized,
      reference,
      `mismatch for ${JSON.stringify(message).slice(0, 120)}: opt=${optimized} ref=${reference}`,
    );
  }
});

test("L4 等价：整段 transcript（多消息混合）估算相同", () => {
  const optimized = estimateMessageTokens(SAMPLE_MESSAGES);
  const reference = estimateMessageTokensRef(SAMPLE_MESSAGES);
  assert.equal(optimized, reference);
});

test("L4 等价：大文本多块消息（join 分配最敏感的形状）估算相同", () => {
  const big = {
    role: "assistant",
    content: [
      reasoning("r".repeat(2000)),
      text("a".repeat(3000)),
      reasoning("s".repeat(1500)),
      text("b".repeat(2500)),
    ],
    toolCalls: [{ name: "write", input: { content: "c".repeat(4000) } }],
  };
  assert.equal(estimateMessageTokens([big]), estimateMessageTokensRef([big]));
});

test("L4 不变量：图片平价计费仍按块计 1600（compact-invariants I1 语义未破）", () => {
  // 单图无文本：估算应恰为 COMPACT_ESTIMATE_INLINE_MEDIA_TOKENS（charCount=0 → ceil(0)=0）
  const single = estimateMessageTokens([{ role: "user", content: [image()] }]);
  assert.equal(single, COMPACT_ESTIMATE_INLINE_MEDIA_TOKENS);
  // 多图：按块累加
  const triple = estimateMessageTokens([{ role: "user", content: [image(), image(), image()] }]);
  assert.equal(triple, COMPACT_ESTIMATE_INLINE_MEDIA_TOKENS * 3);
  // 图 + 文本：文本走 char/divisor，图走平价，分轨
  const mixed = estimateMessageTokens([{ role: "user", content: [text("abc"), image()] }]);
  assert.equal(
    mixed,
    Math.ceil(3 / ESTIMATED_TOKEN_CHAR_DIVISOR) + COMPACT_ESTIMATE_INLINE_MEDIA_TOKENS,
  );
});

test("L4 边界：空内容/空数组/纯媒体不产生文本长度", () => {
  assert.equal(estimateMessageTokens([{ role: "user", content: [] }]), 0);
  assert.equal(estimateMessageTokens([{ role: "user", content: "" }]), 0);
  assert.equal(
    estimateMessageTokens([{ role: "user", content: [text(""), reasoning("")] }]),
    0,
  );
});
