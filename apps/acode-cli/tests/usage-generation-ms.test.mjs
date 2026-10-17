import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * generationMs 口径验收（apps/acode-cli/specs/usage-statusbar.md 数据口径 3 / 验收场景 2）：
 * 含思考（reasoning>0）从请求起算、无首字时间戳从请求起算、常规从首字起算；
 * 段间工具等待不计（口径本身每模型步只算一次，无跨步输入）。
 */

const { computeGenerationMs, computeModelStepTiming } =
  await import("../packages/core/src/runtime/methods/usage-observability.ts");
// 与 usage-observability 同一模块图取枚举，钉住事件 fixture 的 type 词汇。
const { SessionEventType } = await import("../packages/core/src/runtime/deps.ts");

const STARTED_AT = 10_000;
const FIRST_TOKEN_AT = 10_400;
const COMPLETED_AT = 12_000;

test("computeGenerationMs: 含思考请求（reasoningTokens>0）从请求起算", () => {
  assert.equal(
    computeGenerationMs({
      completedAt: COMPLETED_AT,
      firstTokenAt: FIRST_TOKEN_AT,
      reasoningTokens: 512,
      startedAt: STARTED_AT,
    }),
    COMPLETED_AT - STARTED_AT,
  );
});

test("computeGenerationMs: 无首字时间戳回退从请求起算", () => {
  assert.equal(
    computeGenerationMs({
      completedAt: COMPLETED_AT,
      firstTokenAt: undefined,
      reasoningTokens: undefined,
      startedAt: STARTED_AT,
    }),
    COMPLETED_AT - STARTED_AT,
  );
});

test("computeGenerationMs: 常规请求从首字起算（reasoningTokens=0 视同无思考）", () => {
  assert.equal(
    computeGenerationMs({
      completedAt: COMPLETED_AT,
      firstTokenAt: FIRST_TOKEN_AT,
      reasoningTokens: 0,
      startedAt: STARTED_AT,
    }),
    COMPLETED_AT - FIRST_TOKEN_AT,
  );
  assert.equal(
    computeGenerationMs({
      completedAt: COMPLETED_AT,
      firstTokenAt: FIRST_TOKEN_AT,
      reasoningTokens: undefined,
      startedAt: STARTED_AT,
    }),
    COMPLETED_AT - FIRST_TOKEN_AT,
  );
});

test("computeGenerationMs: 时钟回拨负值夹 0（wire schema 约束 ≥0）", () => {
  assert.equal(
    computeGenerationMs({
      completedAt: STARTED_AT - 100,
      firstTokenAt: undefined,
      reasoningTokens: undefined,
      startedAt: STARTED_AT,
    }),
    0,
  );
});

const streamingEvent = (at, payload) => ({
  type: SessionEventType.ModelStreaming,
  timestamp: new Date(at),
  payload,
});

test("computeModelStepTiming: 有首字事件 → TTFT 与从首字起算的 generationMs", () => {
  const timing = computeModelStepTiming({
    completedAt: COMPLETED_AT,
    events: [
      streamingEvent(FIRST_TOKEN_AT, { kind: "text_delta", delta: "hi" }),
      streamingEvent(FIRST_TOKEN_AT + 50, { kind: "text_delta", delta: "there" }),
    ],
    networkEventStartIndex: 0,
    reasoningTokens: undefined,
    startedAt: STARTED_AT,
  });
  assert.equal(timing.timeToFirstTokenMs, FIRST_TOKEN_AT - STARTED_AT);
  assert.equal(timing.generationMs, COMPLETED_AT - FIRST_TOKEN_AT);
});

test("computeModelStepTiming: 含思考 → 即便有首字事件也从请求起算", () => {
  const timing = computeModelStepTiming({
    completedAt: COMPLETED_AT,
    events: [streamingEvent(FIRST_TOKEN_AT, { kind: "reasoning_delta", delta: "think" })],
    networkEventStartIndex: 0,
    reasoningTokens: 128,
    startedAt: STARTED_AT,
  });
  assert.equal(timing.timeToFirstTokenMs, FIRST_TOKEN_AT - STARTED_AT);
  assert.equal(timing.generationMs, COMPLETED_AT - STARTED_AT);
});

test("computeModelStepTiming: 无首字事件 → TTFT 缺席（不造假值），从请求起算", () => {
  const timing = computeModelStepTiming({
    completedAt: COMPLETED_AT,
    events: [streamingEvent(FIRST_TOKEN_AT, { kind: "text_delta", delta: "" })],
    networkEventStartIndex: 0,
    reasoningTokens: undefined,
    startedAt: STARTED_AT,
  });
  assert.equal(timing.timeToFirstTokenMs, undefined);
  assert.equal("timeToFirstTokenMs" in timing, false);
  assert.equal(timing.generationMs, COMPLETED_AT - STARTED_AT);
});

test("computeModelStepTiming: networkEventStartIndex 之前的事件不参与首字判定", () => {
  const timing = computeModelStepTiming({
    completedAt: COMPLETED_AT,
    events: [
      streamingEvent(STARTED_AT + 10, { kind: "text_delta", delta: "previous step" }),
      streamingEvent(FIRST_TOKEN_AT, { kind: "text_delta", delta: "this step" }),
    ],
    networkEventStartIndex: 1,
    reasoningTokens: undefined,
    startedAt: STARTED_AT,
  });
  assert.equal(timing.timeToFirstTokenMs, FIRST_TOKEN_AT - STARTED_AT);
});
