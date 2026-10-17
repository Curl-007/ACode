import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * WebSearch refill 式预算（specs/websearch-refill-budget.md）验收测试：
 * - R1 通用件 quota-refill：假时钟下的连续回补、拒绝判定与 retryAfterMs、
 *   预算关闭（limit<=0）、不回补（refillPerWindow=0 → Infinity）、
 *   桶满不攒信用、速率热调整保守夹取；
 * - R2 WebSearch 消费面：超限拒绝是 in-band 合法 WebSearchOutput（含恢复时间
 *   与反绕过条款），formatModelContent 不渲染来源提醒；预算按 session 隔离。
 */

const { createRefillQuota } = await import("../packages/core/src/tool/quota-refill.ts");

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

function fakeClock(startMs = 0) {
  const state = { nowMs: startMs };
  return {
    now: () => state.nowMs,
    advance(ms) {
      state.nowMs += ms;
    },
  };
}

test("quota-refill：limit=3/窗口60min，第4次拒绝且 retryAfter≈20min，推进后放行", () => {
  const clock = fakeClock();
  const quota = createRefillQuota({
    resolveConfig: () => ({ limitPerWindow: 3, windowMs: HOUR_MS }),
    now: clock.now,
  });
  for (let i = 0; i < 3; i += 1) {
    assert.deepEqual(quota.tryConsume(), { allowed: true });
  }
  const denied = quota.tryConsume();
  assert.equal(denied.allowed, false);
  // 连续回补速率 3 名额/60min = 每 20min 一个名额。
  assert.equal(denied.retryAfterMs, 20 * MINUTE_MS);
  clock.advance(20 * MINUTE_MS);
  assert.deepEqual(quota.tryConsume(), { allowed: true });
  // 刚回补的名额被消费，下一个仍要再等 20min。
  assert.equal(quota.peekRetryAfterMs(), 20 * MINUTE_MS);
});

test("quota-refill：limit=0 恒放行（预算关闭）；refillPerWindow=0 耗尽后 retryAfter=Infinity", () => {
  const clock = fakeClock();
  const disabled = createRefillQuota({
    resolveConfig: () => ({ limitPerWindow: 0, windowMs: HOUR_MS }),
    now: clock.now,
  });
  for (let i = 0; i < 50; i += 1) {
    assert.equal(disabled.tryConsume().allowed, true);
  }
  assert.equal(disabled.peekRetryAfterMs(), 0);

  const oneShot = createRefillQuota({
    resolveConfig: () => ({ limitPerWindow: 2, windowMs: HOUR_MS, refillPerWindow: 0 }),
    now: clock.now,
  });
  assert.equal(oneShot.tryConsume().allowed, true);
  assert.equal(oneShot.tryConsume().allowed, true);
  const denied = oneShot.tryConsume();
  assert.equal(denied.allowed, false);
  assert.equal(denied.retryAfterMs, Number.POSITIVE_INFINITY);
  clock.advance(10 * HOUR_MS);
  assert.equal(oneShot.tryConsume().allowed, false, "不回补：推进时间也不放行");
});

test("quota-refill：桶满不攒信用——空闲 3 个窗口后突发仍只能消费 limit 个", () => {
  const clock = fakeClock();
  const quota = createRefillQuota({
    resolveConfig: () => ({ limitPerWindow: 2, windowMs: HOUR_MS }),
    now: clock.now,
  });
  clock.advance(3 * HOUR_MS);
  assert.equal(quota.tryConsume().allowed, true);
  assert.equal(quota.tryConsume().allowed, true);
  assert.equal(quota.tryConsume().allowed, false, "空闲时间不得兑换成突发额度");
});

test("quota-refill：速率热调整保守夹取——调高速率不追溯兑现旧区间", () => {
  const clock = fakeClock();
  let refillPerWindow = 0;
  const quota = createRefillQuota({
    resolveConfig: () => ({ limitPerWindow: 1, windowMs: HOUR_MS, refillPerWindow }),
    now: clock.now,
  });
  assert.equal(quota.tryConsume().allowed, true);
  clock.advance(HOUR_MS);
  // 过去 1 小时按旧速率 0 累积：本区间信用为 0，即便现在把速率调到 60/h，
  // retryAfter 仍是「新速率下再等 1 个名额」而不是立即放行。
  refillPerWindow = 60;
  assert.equal(quota.peekRetryAfterMs(), MINUTE_MS);
  clock.advance(MINUTE_MS);
  assert.equal(quota.tryConsume().allowed, true);
});

// -----------------------------------------------
// WebSearch handler 消费面
// -----------------------------------------------

const { webSearchToolEntry } = await import(
  "../packages/core/src/tool/handlers/websearch.ts"
);

function makeContext(sessionId) {
  return {
    toolCallId: `call-${sessionId}`,
    traceId: `trace-${sessionId}`,
    sessionId,
    abortSignal: new AbortController().signal,
  };
}

test("websearch：超限拒绝是 in-band 合法输出，含恢复时间与反绕过条款", async (t) => {
  t.after(() => {
    delete process.env.ACODE_WEBSEARCH_BUDGET;
    delete process.env.ACODE_WEBSEARCH_BUDGET_WINDOW_MINUTES;
  });
  process.env.ACODE_WEBSEARCH_BUDGET = "1";
  process.env.ACODE_WEBSEARCH_BUDGET_WINDOW_MINUTES = "60";
  const context = makeContext("sess-refusal");

  // 第 1 次消费名额后因缺 model 抛配置错误（消费发生在门禁时点，失败不退名额）。
  await assert.rejects(
    () => webSearchToolEntry.handler({ query: "first" }, context),
    /Model is required for WebSearch/,
  );

  const refusal = await webSearchToolEntry.handler({ query: "second" }, context);
  assert.deepEqual(refusal.results, []);
  assert.deepEqual(refusal.sources, []);
  assert.equal(refusal.webSearchRequests, 0);
  assert.equal(refusal.query, "second");
  assert.match(refusal.summary, /search budget is used up/);
  assert.match(refusal.summary, /limit: 1 searches per hour/);
  assert.match(refusal.summary, /next search becomes available in about 1 hour/);
  assert.match(refusal.summary, /do not retry in a loop/i);
  assert.match(refusal.summary, /curl\/wget/);

  // 渲染面：零结果零来源时不出现「必须附来源链接」提醒。
  const rendered = webSearchToolEntry.formatModelContent(refusal);
  assert.match(rendered, /search budget is used up/);
  assert.doesNotMatch(rendered, /REMINDER/);
});

test("websearch：预算按 session 隔离；ACODE_WEBSEARCH_BUDGET=0 关闭预算", async (t) => {
  t.after(() => {
    delete process.env.ACODE_WEBSEARCH_BUDGET;
  });
  process.env.ACODE_WEBSEARCH_BUDGET = "1";
  const contextA = makeContext("sess-isolation-a");
  const contextB = makeContext("sess-isolation-b");
  await assert.rejects(() => webSearchToolEntry.handler({ query: "a1" }, contextA));
  const refusalA = await webSearchToolEntry.handler({ query: "a2" }, contextA);
  assert.match(refusalA.summary, /search budget is used up/);
  // B 有自己的满桶：第 1 次仍走到 model 检查（抛配置错误而不是预算拒绝）。
  await assert.rejects(
    () => webSearchToolEntry.handler({ query: "b1" }, contextB),
    /Model is required for WebSearch/,
  );

  // 0 = 关闭预算：恒放行（表现为每次都走到 model 检查抛配置错误，而非预算拒绝）。
  process.env.ACODE_WEBSEARCH_BUDGET = "0";
  const contextOff = makeContext("sess-disabled");
  for (let i = 0; i < 5; i += 1) {
    await assert.rejects(
      () => webSearchToolEntry.handler({ query: `off-${i}` }, contextOff),
      /Model is required for WebSearch/,
    );
  }
});
