import assert from "node:assert/strict";
import test from "node:test";
import {
  CONTEXT_AUTO_COMPACT_NEAR_RATIO,
  resolveContextAutoCompactState,
} from "../src/chat-input-toolbar/contextUsageAutoCompact.js";

// 上下文环 auto-compact 分档（specs/usage-statusbar.md「上下文容量」行）：
// 阈值缺席不分档；接近档变色 + 建议；达阈值升 critical。

const THRESHOLD = 160_000;

test("阈值缺席/非法或用值非法 → normal（旧投影恒 null，环保持既有中性色）", () => {
  for (const autoCompactThresholdTokens of [null, undefined, 0, -1, Number.NaN]) {
    assert.equal(
      resolveContextAutoCompactState({ usedTokens: 1000, autoCompactThresholdTokens }).tone,
      "normal",
    );
  }
  assert.equal(
    resolveContextAutoCompactState({ usedTokens: 0, autoCompactThresholdTokens: THRESHOLD }).tone,
    "normal",
  );
  assert.equal(
    resolveContextAutoCompactState({
      usedTokens: Number.NaN,
      autoCompactThresholdTokens: THRESHOLD,
    }).adviceMessageId,
    null,
  );
  const normal = resolveContextAutoCompactState({
    usedTokens: 1000,
    autoCompactThresholdTokens: null,
  });
  assert.equal(normal.triggerClassName, null);
  assert.equal(normal.thresholdTokens, null);
});

test("低于接近档 → normal；达到 0.85 比值 → near + compact/新会话建议", () => {
  const below = resolveContextAutoCompactState({
    usedTokens: THRESHOLD * CONTEXT_AUTO_COMPACT_NEAR_RATIO - 1,
    autoCompactThresholdTokens: THRESHOLD,
  });
  assert.equal(below.tone, "normal");
  assert.equal(below.adviceMessageId, null);

  const near = resolveContextAutoCompactState({
    usedTokens: THRESHOLD * CONTEXT_AUTO_COMPACT_NEAR_RATIO,
    autoCompactThresholdTokens: THRESHOLD,
  });
  assert.equal(near.tone, "near");
  assert.equal(near.triggerClassName, "text-warning");
  assert.equal(near.adviceMessageId, "chat.contextUsage.autoCompactNear");
  assert.equal(near.thresholdTokens, THRESHOLD);
});

test("达到/超过阈值 → critical", () => {
  const reached = resolveContextAutoCompactState({
    usedTokens: THRESHOLD,
    autoCompactThresholdTokens: THRESHOLD,
  });
  assert.equal(reached.tone, "critical");
  assert.equal(reached.triggerClassName, "text-destructive");
  assert.equal(reached.adviceMessageId, "chat.contextUsage.autoCompactReached");

  const over = resolveContextAutoCompactState({
    usedTokens: THRESHOLD * 1.2,
    autoCompactThresholdTokens: THRESHOLD,
  });
  assert.equal(over.tone, "critical");
});
