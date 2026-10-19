// adapters in-flight usage 事实提取 + ≥500ms 单点节流纯函数验收
// （apps/acode-cli/specs/usage-statusbar.md「In-flight 真实用量事实面」/验收场景 8：
// 首事实立即发、间隔 <500ms 抑制、≥500ms 放行、请求结束不补尾包）。
// producer 纪律：只消费 provider raw SSE 里已存在的 usage 真值（Anthropic
// message_start/message_delta），严禁按字符数估算；非 Anthropic 形状自然无事实，
// 链路如实降级（能力矩阵）。
import assert from "node:assert/strict";
import test from "node:test";

const { createUsageProgressThrottle, extractUsageProgressFact, shouldEmitUsageProgress } =
  await import("../packages/adapters/src/model/runner-stream-usage-progress.ts");

const STARTED_AT = 1_700_000_000_000;

const messageStart = (usage) => ({ type: "message_start", message: { usage } });
const messageDelta = (usage) => ({ type: "message_delta", usage });

// ── extractUsageProgressFact：真值提取（含缓存口径求和） ─────────────────────

test("message_start sums cache read/write into announcedInputTokens (AI SDK v6 total-input 口径)", () => {
  assert.deepEqual(
    extractUsageProgressFact(
      messageStart({
        input_tokens: 100,
        cache_read_input_tokens: 50,
        cache_creation_input_tokens: 25,
        output_tokens: 1,
      }),
    ),
    { announcedInputTokens: 175 },
  );
  // 无缓存字段缺席 = 无缓存 token（缺省 0，求和不造假值）。
  assert.deepEqual(extractUsageProgressFact(messageStart({ input_tokens: 42 })), {
    announcedInputTokens: 42,
  });
  // 0 输入也是真值（非缺席）。
  assert.deepEqual(extractUsageProgressFact(messageStart({ input_tokens: 0 })), {
    announcedInputTokens: 0,
  });
});

test("message_delta carries cumulative partialOutputTokens verbatim", () => {
  assert.deepEqual(extractUsageProgressFact(messageDelta({ output_tokens: 321 })), {
    partialOutputTokens: 321,
  });
  assert.deepEqual(extractUsageProgressFact(messageDelta({ output_tokens: 0 })), {
    partialOutputTokens: 0,
  });
});

test("facts without usable provider truth yield undefined (never estimated)", () => {
  // 缺 input_tokens 的 message_start / 缺 usage 或 output_tokens 的 message_delta。
  assert.equal(extractUsageProgressFact(messageStart({ cache_read_input_tokens: 5 })), undefined);
  assert.equal(extractUsageProgressFact(messageStart({})), undefined);
  assert.equal(extractUsageProgressFact({ type: "message_start" }), undefined);
  assert.equal(extractUsageProgressFact({ type: "message_delta" }), undefined);
  assert.equal(extractUsageProgressFact(messageDelta({})), undefined);
  // 非法值不造假：负数 / NaN / Infinity。
  assert.equal(extractUsageProgressFact(messageStart({ input_tokens: -3 })), undefined);
  assert.equal(extractUsageProgressFact(messageDelta({ output_tokens: Number.NaN })), undefined);
  assert.equal(
    extractUsageProgressFact(messageDelta({ output_tokens: Number.POSITIVE_INFINITY })),
    undefined,
  );
  // 缓存字段非法 → 按缺席（0）处理，不污染 input 真值。
  assert.deepEqual(
    extractUsageProgressFact(
      messageStart({
        input_tokens: 10,
        cache_read_input_tokens: -5,
        cache_creation_input_tokens: "x",
      }),
    ),
    { announcedInputTokens: 10 },
  );
  // 非 Anthropic 中途事实形状（OpenAI 系 include_usage 仅末包）→ 自然缺席，如实降级。
  assert.equal(
    extractUsageProgressFact({
      type: "chat.completion.chunk",
      choices: [{ delta: { content: "hello" } }],
    }),
    undefined,
  );
  // 其余 Anthropic 事件（正文/ping/block 边界）不含 usage 事实。
  assert.equal(
    extractUsageProgressFact({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "counting characters is forbidden" },
    }),
    undefined,
  );
  assert.equal(extractUsageProgressFact({ type: "ping" }), undefined);
  assert.equal(extractUsageProgressFact({ type: "content_block_stop", index: 0 }), undefined);
  assert.equal(extractUsageProgressFact({ type: "message_stop" }), undefined);
  // 非 record 输入。
  assert.equal(extractUsageProgressFact(null), undefined);
  assert.equal(extractUsageProgressFact("message_start"), undefined);
  assert.equal(extractUsageProgressFact(42), undefined);
  assert.equal(extractUsageProgressFact(undefined), undefined);
});

test("fractional token values are floored, not rounded up", () => {
  assert.deepEqual(extractUsageProgressFact(messageStart({ input_tokens: 12.7 })), {
    announcedInputTokens: 12,
  });
  assert.deepEqual(extractUsageProgressFact(messageDelta({ output_tokens: 8.9 })), {
    partialOutputTokens: 8,
  });
});

// ── shouldEmitUsageProgress：节流判定纯函数 ─────────────────────────────────

test("throttle decision: first fact immediate, <500ms suppressed, >=500ms passes", () => {
  // 首事实（lastEmittedAtMs=null）立即放行。
  assert.equal(shouldEmitUsageProgress(null, STARTED_AT), true);
  // <500ms 抑制（含 499ms 边界内侧）。
  assert.equal(shouldEmitUsageProgress(STARTED_AT, STARTED_AT + 0), false);
  assert.equal(shouldEmitUsageProgress(STARTED_AT, STARTED_AT + 100), false);
  assert.equal(shouldEmitUsageProgress(STARTED_AT, STARTED_AT + 499), false);
  // ≥500ms 放行（含恰好 500ms 边界）。
  assert.equal(shouldEmitUsageProgress(STARTED_AT, STARTED_AT + 500), true);
  assert.equal(shouldEmitUsageProgress(STARTED_AT, STARTED_AT + 501), true);
});

// ── createUsageProgressThrottle：per-request 节流器行为 ─────────────────────

test("first fact emits immediately with request identity timestamps", () => {
  const throttle = createUsageProgressThrottle(STARTED_AT);
  const event = throttle.observe(messageStart({ input_tokens: 10 }), STARTED_AT + 200);
  assert.deepEqual(event, {
    type: "usage_progress",
    requestStartedAtMs: STARTED_AT,
    observedAtMs: STARTED_AT + 200,
    announcedInputTokens: 10,
  });
  // 缺席键不造假：message_start 事实不带 partialOutputTokens。
  assert.ok(!("partialOutputTokens" in event));
});

test("facts inside the 500ms window are suppressed and never replayed", () => {
  const throttle = createUsageProgressThrottle(STARTED_AT);
  assert.ok(throttle.observe(messageStart({ input_tokens: 10 }), STARTED_AT));
  // +100ms：窗口内抑制。
  assert.equal(throttle.observe(messageDelta({ output_tokens: 5 }), STARTED_AT + 100), undefined);
  // +300ms：仍抑制（相对上一条**已发射**事实）。
  assert.equal(throttle.observe(messageDelta({ output_tokens: 9 }), STARTED_AT + 300), undefined);
  // +500ms：放行，且携带的是当下最新累计值（被抑制事实不补发——output_tokens
  // 本身累计，纯增量语义无信息损失）。
  const passed = throttle.observe(messageDelta({ output_tokens: 20 }), STARTED_AT + 500);
  assert.deepEqual(passed, {
    type: "usage_progress",
    requestStartedAtMs: STARTED_AT,
    observedAtMs: STARTED_AT + 500,
    partialOutputTokens: 20,
  });
  assert.ok(!("announcedInputTokens" in passed));
});

test("suppressed facts do not push the throttle window forward", () => {
  const throttle = createUsageProgressThrottle(STARTED_AT);
  assert.ok(throttle.observe(messageStart({ input_tokens: 1 }), STARTED_AT));
  // +400ms 抑制不应重置窗口：+500ms（距上次**发射**恰好 500ms）必须放行。
  assert.equal(throttle.observe(messageDelta({ output_tokens: 2 }), STARTED_AT + 400), undefined);
  const passed = throttle.observe(messageDelta({ output_tokens: 3 }), STARTED_AT + 500);
  assert.ok(passed, "window is anchored to the last emitted fact");
  assert.equal(passed.observedAtMs, STARTED_AT + 500);
});

test("no tail packet: fact-less events never emit and the throttle exposes no flush surface", () => {
  const throttle = createUsageProgressThrottle(STARTED_AT);
  assert.ok(throttle.observe(messageStart({ input_tokens: 7 }), STARTED_AT + 50));
  // 窗口内被抑制的最后一条事实。
  assert.equal(throttle.observe(messageDelta({ output_tokens: 4 }), STARTED_AT + 200), undefined);
  // 「请求结束」= 后续只有无事实事件（content_block_stop/message_stop 等）：
  // 不补尾包——权威值走 finish chunk，节流器也没有任何 flush/close API 可补发。
  assert.deepEqual(Object.keys(throttle), ["observe"]);
  assert.equal(
    throttle.observe({ type: "content_block_stop", index: 0 }, STARTED_AT + 5_000),
    undefined,
  );
  assert.equal(throttle.observe({ type: "message_stop" }, STARTED_AT + 5_100), undefined);
  assert.equal(throttle.observe({ type: "finish" }, STARTED_AT + 5_200), undefined);
});

test("fact-less raw events do not consume the first-fact immediacy", () => {
  const throttle = createUsageProgressThrottle(STARTED_AT);
  // 正文/ping 等无事实事件先流过：窗口不启动。
  assert.equal(
    throttle.observe(
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
      STARTED_AT + 100,
    ),
    undefined,
  );
  assert.equal(throttle.observe({ type: "ping" }, STARTED_AT + 200), undefined);
  // 首条真实事实仍立即发射（哪怕距请求起点已过窗口）。
  const first = throttle.observe(messageDelta({ output_tokens: 11 }), STARTED_AT + 2_000);
  assert.ok(first);
  assert.equal(first.observedAtMs, STARTED_AT + 2_000);
});

test("invalid facts do not open or consume the throttle window", () => {
  const throttle = createUsageProgressThrottle(STARTED_AT);
  assert.equal(throttle.observe(messageStart({ input_tokens: -1 }), STARTED_AT + 100), undefined);
  // 紧随其后的合法事实仍是「首事实」→ 立即放行。
  const first = throttle.observe(messageStart({ input_tokens: 5 }), STARTED_AT + 150);
  assert.ok(first);
  assert.equal(first.announcedInputTokens, 5);
});

test("per-request instances throttle independently and carry their own requestStartedAtMs", () => {
  // 节流器是 per-attempt（= per 物理请求）：多模型步/重试各自新建，互不共享窗口。
  const first = createUsageProgressThrottle(STARTED_AT);
  const second = createUsageProgressThrottle(STARTED_AT + 10_000);
  const e1 = first.observe(messageStart({ input_tokens: 1 }), STARTED_AT + 100);
  const e2 = second.observe(messageStart({ input_tokens: 2 }), STARTED_AT + 200);
  assert.ok(e1 && e2, "each request's first fact emits immediately");
  assert.equal(e1.requestStartedAtMs, STARTED_AT);
  assert.equal(e2.requestStartedAtMs, STARTED_AT + 10_000);
  // 同一实例继续按自己的窗口节流。
  assert.equal(first.observe(messageDelta({ output_tokens: 3 }), STARTED_AT + 300), undefined);
  assert.equal(second.observe(messageDelta({ output_tokens: 4 }), STARTED_AT + 300), undefined);
});

test("realistic Anthropic SSE sequence: start truth, throttled deltas, cumulative values", () => {
  const throttle = createUsageProgressThrottle(STARTED_AT);
  const emitted = [];
  const observe = (raw, at) => {
    const event = throttle.observe(raw, at);
    if (event) emitted.push(event);
  };
  // message_start：请求开始即有输入真值（上下文环 live 水位的来源）。
  observe(messageStart({ input_tokens: 3, cache_read_input_tokens: 900 }), STARTED_AT + 80);
  // 正文 delta 不含事实。
  observe(
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "a".repeat(500) } },
    STARTED_AT + 200,
  );
  // 高频 message_delta：+300ms 抑制、+600ms 放行（累计值天然最新）。
  observe(messageDelta({ output_tokens: 40 }), STARTED_AT + 300);
  observe(messageDelta({ output_tokens: 95 }), STARTED_AT + 600);
  observe(messageDelta({ output_tokens: 150 }), STARTED_AT + 900);
  observe(messageDelta({ output_tokens: 210 }), STARTED_AT + 1_150);
  assert.deepEqual(
    emitted.map((event) => [
      event.observedAtMs - STARTED_AT,
      event.announcedInputTokens,
      event.partialOutputTokens,
    ]),
    [
      [80, 903, undefined],
      [600, undefined, 95],
      [1_150, undefined, 210],
    ],
  );
  // 全程只有真值：没有任何按字符数估算的数字（500 字符正文 delta 零发射）。
  assert.ok(emitted.every((event) => event.type === "usage_progress"));
});
