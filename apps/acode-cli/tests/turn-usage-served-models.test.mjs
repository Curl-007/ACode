// 多模型轮标记与每轮缓存未命中（specs/usage-statusbar.md D5 增补 6-8）：
// 累加器 servedModels 去重/上限/请求序 + cacheMisses 求和 + stats flush 缺席语义。
import assert from "node:assert/strict";
import { test } from "node:test";

const { accumulateTurnUsage, buildTurnHeaderStats } = await import(
  "../packages/bootstrap/src/acode-protocol-v4/product-projection-usage.ts"
);

function payload(overrides = {}) {
  return {
    content: "x",
    stopReason: "stop",
    querySource: "main_turn",
    usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
    ...overrides,
  };
}

test("servedModels：请求序去重累计，flush 进 stats", () => {
  let acc = accumulateTurnUsage(undefined, payload({ servedModel: { providerId: "p", modelId: "a" } }));
  acc = accumulateTurnUsage(acc, payload({ servedModel: { providerId: "p", modelId: "a" } }));
  acc = accumulateTurnUsage(acc, payload({ servedModel: { providerId: "q", modelId: "b" } }));
  assert.deepEqual(acc.servedModels, ["p/a", "q/b"]);
  const stats = buildTurnHeaderStats(acc);
  assert.deepEqual(stats.servedModels, ["p/a", "q/b"]);
});

test("servedModels：上限 4，超出丢弃；providerId 缺席时只用 modelId", () => {
  let acc;
  for (const modelId of ["m1", "m2", "m3", "m4", "m5"]) {
    acc = accumulateTurnUsage(acc, payload({ servedModel: { providerId: "", modelId } }));
  }
  assert.deepEqual(acc.servedModels, ["m1", "m2", "m3", "m4"]);
});

test("servedModel 缺席/畸形：不产生字段（旁路发射点与旧事件不造假值）", () => {
  let acc = accumulateTurnUsage(undefined, payload());
  acc = accumulateTurnUsage(acc, payload({ servedModel: { providerId: "p", modelId: "  " } }));
  acc = accumulateTurnUsage(acc, payload({ servedModel: { providerId: "p" } }));
  assert.deepEqual(acc.servedModels, []);
  const stats = buildTurnHeaderStats(acc);
  assert.equal(stats.servedModels, undefined);
});

test("cacheMisses：missCauses 各值求和；0/缺席不投影 promptCacheMisses", () => {
  let acc = accumulateTurnUsage(
    undefined,
    payload({ cacheHit: { missCauses: { system_prompt_edit: 1, tool_change: 2 } } }),
  );
  acc = accumulateTurnUsage(acc, payload({ cacheHit: { missCauses: { message_append: 1 } } }));
  assert.equal(acc.cacheMisses, 4);
  assert.equal(buildTurnHeaderStats(acc).promptCacheMisses, 4);

  const clean = accumulateTurnUsage(undefined, payload());
  assert.equal(buildTurnHeaderStats(clean).promptCacheMisses, undefined);
});

test("既有口径零回归：tokens/generationMs/ttft/modelRequestCount 不受新字段影响", () => {
  let acc = accumulateTurnUsage(
    undefined,
    payload({ generationMs: 1000, timeToFirstTokenMs: 100, servedModel: { providerId: "p", modelId: "a" } }),
  );
  acc = accumulateTurnUsage(acc, payload({ generationMs: 2000, timeToFirstTokenMs: 50 }));
  const stats = buildTurnHeaderStats(acc);
  assert.equal(stats.inputTokens, 20);
  assert.equal(stats.outputTokens, 40);
  assert.equal(stats.generationMs, 3000);
  assert.equal(stats.timeToFirstTokenMs, 100);
  assert.equal(stats.modelRequestCount, 2);
});
