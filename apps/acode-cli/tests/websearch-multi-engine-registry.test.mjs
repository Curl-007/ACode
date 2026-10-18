import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * WebSearch 多引擎层 · 注册表与回退链（specs/websearch-multi-engine.md 验收 2/3/5/6）：
 * - 注册表懒加载（导入零引擎模块加载，首次 getSearchProvider 才加载）；
 * - 回退链（首选失败→次选成功 + 失败聚合；全败聚合清单；凭据缺失静默跳过；
 *   用户取消立即中止）；
 * - 默认路径不回归（ACODE_WEBSEARCH_ENGINES 未设置 → 仍走 provider-native 分支）。
 */

const registryUrl = "../packages/core/src/websearch/registry.ts";
const { getSearchProvider, isRegisteredSearchEngine, resetSearchProviderInstancesForTest } = await import(registryUrl);
const { runWebSearchChain } = await import("../packages/core/src/websearch/chain.ts");
const { resolveEngineChain } = await import("../packages/core/src/websearch/engine-config.ts");
const { getLoadedEngineIdsForTest, resetLoadedEnginesForTest } = await import(
  "../packages/core/src/websearch/loaded-engines.ts"
);
const { webSearchToolEntry } = await import("../packages/core/src/tool/handlers/websearch.ts");

test("engine-config：env 未设置 → off；=auto → 默认链；显式列表保序去重、未知 id 忽略", () => {
  const env = {};
  assert.deepEqual(resolveEngineChain(env), { mode: "off", ids: [] });
  const auto = resolveEngineChain({ ...env, ACODE_WEBSEARCH_ENGINES: " auto " });
  assert.equal(auto.mode, "default");
  assert.ok(auto.ids.includes("duckduckgo"));
  assert.ok(!auto.ids.includes("public"), "public 聚合不在默认链（显式点名专属）");
  const explicit = resolveEngineChain({
    ACODE_WEBSEARCH_ENGINES: "brave, duckduckgo, not-an-engine, brave",
  });
  assert.deepEqual(explicit.ids, ["brave", "duckduckgo"]);
  assert.equal(explicit.mode, "explicit");
});

test("注册表：isRegisteredSearchEngine 认识 21 引擎并拒绝未知 id", async () => {
  assert.equal(isRegisteredSearchEngine("duckduckgo"), true);
  assert.equal(isRegisteredSearchEngine("public"), true);
  assert.equal(isRegisteredSearchEngine("nope"), false);
  await assert.rejects(() => getSearchProvider("nope"), /Unknown search provider/);
});

test("注册表懒加载：导入后零引擎模块加载；首次 getSearchProvider 只加载对应模块", async () => {
  resetLoadedEnginesForTest();
  resetSearchProviderInstancesForTest();
  assert.deepEqual(getLoadedEngineIdsForTest(), [], "注册表导入不得加载任何引擎模块");

  const provider = await getSearchProvider("duckduckgo");
  assert.equal(provider.id, "duckduckgo");
  assert.deepEqual(getLoadedEngineIdsForTest(), ["duckduckgo"]);

  // memoize：二次解析不再触发新加载；另一引擎加载是增量的。
  await getSearchProvider("duckduckgo");
  const provider2 = await getSearchProvider("brave");
  assert.equal(provider2.id, "brave");
  assert.deepEqual(getLoadedEngineIdsForTest().sort(), ["brave", "duckduckgo"]);
  resetLoadedEnginesForTest();
});

// -----------------------------------------------
// 回退链（注入 provider 解析缝）
// -----------------------------------------------

function fakeProvider(id, { available = true, sources = [], throw: thrown } = {}) {
  let searched = 0;
  return {
    id,
    label: id,
    isAvailable: () => available,
    isExplicitlyAvailable: () => available,
    async search() {
      searched += 1;
      if (thrown) throw thrown;
      return { provider: id, sources };
    },
    get searchCount() {
      return searched;
    },
  };
}

test("回退链：首选失败→次选成功，失败聚合随成功结果透出", async () => {
  const good = fakeProvider("good", { sources: [{ title: "ok", url: "https://ok.example/a" }] });
  const bad = fakeProvider("bad", { throw: new Error("boom") });
  const providers = { bad, good };
  const outcome = await runWebSearchChain({
    query: "test",
    engineIds: ["bad", "good"],
    resolveProvider: async (id) => providers[id],
  });
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.response.sources.map(s => s.url), ["https://ok.example/a"]);
  assert.equal(outcome.attempted.join(","), "bad,good");
  assert.equal(outcome.failures.length, 1);
  assert.equal(outcome.failures[0].provider.id, "bad");
  assert.match(String(outcome.failures[0].error), /boom/);
});

test("回退链：全部失败 → in-band 失败摘要列出每个引擎的原因", async () => {
  const a = fakeProvider("a", { throw: new Error("quota exhausted") });
  const b = fakeProvider("b", { throw: new Error("401 unauthorized") });
  const outcome = await runWebSearchChain({
    query: "test",
    engineIds: ["a", "b"],
    resolveProvider: async (id) => (id === "a" ? a : b),
  });
  assert.equal(outcome.ok, false);
  assert.match(outcome.summary, /All web search engines failed/);
  assert.match(outcome.summary, /a: .*quota exhausted/);
  assert.match(outcome.summary, /b: /);
});

test("回退链：凭据缺失（isExplicitlyAvailable=false）静默跳过——不尝试、不进失败清单", async () => {
  const noKey = fakeProvider("nokey", { available: false });
  const ok = fakeProvider("ok", { sources: [{ title: "t", url: "https://x.example/" }] });
  const outcome = await runWebSearchChain({
    query: "test",
    engineIds: ["nokey", "ok"],
    resolveProvider: async (id) => (id === "nokey" ? noKey : ok),
  });
  assert.equal(outcome.ok, true);
  assert.equal(noKey.searchCount, 0, "不可用引擎不得发起搜索");
  assert.equal(outcome.failures.length, 0, "静默跳过不是失败");
  assert.equal(outcome.attempted.join(","), "ok");
});

test("回退链：空结果视为引擎失败（链继续）；约束后置过滤在链上生效", async () => {
  const empty = fakeProvider("empty", { sources: [] });
  const fine = fakeProvider("fine", {
    sources: [
      { title: "gh", url: "https://github.com/x" },
      { title: "other", url: "https://other.example/y" },
    ],
  });
  const outcome = await runWebSearchChain({
    query: "test site:github.com",
    engineIds: ["empty", "fine"],
    resolveProvider: async (id) => (id === "empty" ? empty : fine),
  });
  assert.equal(outcome.ok, true);
  assert.equal(empty.searchCount, 1);
  // site:github.com 后置过滤掉了 other.example。
  assert.deepEqual(outcome.response.sources.map(s => s.url), ["https://github.com/x"]);
});

test("回退链：allowed/blocked_domains 后置过滤；全清空时放宽并出注记", async () => {
  const ok = fakeProvider("ok", {
    sources: [
      { title: "a", url: "https://keep.example/a" },
      { title: "b", url: "https://drop.example/b" },
    ],
  });
  const filtered = await runWebSearchChain({
    query: "test",
    engineIds: ["ok"],
    resolveProvider: async () => ok,
    allowedDomains: ["keep.example"],
  });
  assert.equal(filtered.ok, true);
  assert.deepEqual(filtered.response.sources.map(s => s.url), ["https://keep.example/a"]);

  const relaxed = await runWebSearchChain({
    query: "test",
    engineIds: ["ok"],
    resolveProvider: async () => ok,
    allowedDomains: ["nowhere.example"],
  });
  assert.equal(relaxed.ok, true);
  assert.equal(relaxed.response.sources.length, 2, "allowed_domains 清空全部时放宽");
  assert.ok(relaxed.notes.some(n => /allowed_domains/.test(n)));
});

test("回退链：用户取消立即中止（不降级为引擎失败）", async () => {
  const controller = new AbortController();
  const slow = {
    id: "slow",
    label: "slow",
    isAvailable: () => true,
    isExplicitlyAvailable: () => true,
    search: async () => {
      controller.abort();
      throw new Error("should be treated as cancellation");
    },
  };
  const next = fakeProvider("next", { sources: [{ title: "t", url: "https://n.example/" }] });
  const outcome = await runWebSearchChain({
    query: "test",
    engineIds: ["slow", "next"],
    resolveProvider: async (id) => (id === "slow" ? slow : next),
    signal: controller.signal,
  });
  assert.equal(outcome.ok, false);
  assert.equal(next.searchCount, 0, "取消后不得继续尝试下一个引擎");
});

// -----------------------------------------------
// 默认路径不回归（验收 6）
// -----------------------------------------------

function makeContext(sessionId) {
  return {
    toolCallId: `call-${sessionId}`,
    traceId: `trace-${sessionId}`,
    sessionId,
    abortSignal: new AbortController().signal,
  };
}

test("websearch：ACODE_WEBSEARCH_ENGINES 未设置 → 仍走 provider-native 分支（缺 model 报既有错误）", async (t) => {
  const priorEngines = process.env.ACODE_WEBSEARCH_ENGINES;
  t.after(() => {
    if (priorEngines === undefined) delete process.env.ACODE_WEBSEARCH_ENGINES;
    else process.env.ACODE_WEBSEARCH_ENGINES = priorEngines;
  });
  delete process.env.ACODE_WEBSEARCH_ENGINES;
  const context = makeContext("sess-multi-off");
  await assert.rejects(
    () => webSearchToolEntry.handler({ query: "hello world" }, context),
    /Model is required for WebSearch/,
  );
});

test("websearch：ACODE_WEBSEARCH_ENGINES 设置 → 不再要求 model；无引擎可用返回聚合摘要", async (t) => {
  const priorEngines = process.env.ACODE_WEBSEARCH_ENGINES;
  const priorKey = process.env.BRAVE_API_KEY;
  t.after(() => {
    if (priorEngines === undefined) delete process.env.ACODE_WEBSEARCH_ENGINES;
    else process.env.ACODE_WEBSEARCH_ENGINES = priorEngines;
    if (priorKey === undefined) delete process.env.BRAVE_API_KEY;
    else process.env.BRAVE_API_KEY = priorKey;
  });
  // 指向一个有凭据门禁的引擎但凭据缺失：全部静默跳过 → 无引擎可用摘要。
  process.env.ACODE_WEBSEARCH_ENGINES = "brave";
  delete process.env.BRAVE_API_KEY;
  const context = makeContext("sess-multi-on");
  const output = await webSearchToolEntry.handler({ query: "hello world" }, context);
  assert.equal(output.results.length, 0);
  assert.equal(output.sources.length, 0);
  assert.match(output.summary, /No web search engine is available/);
  // 零结果零来源渲染走预算包装（无 REMINDER 噪声）。
  const rendered = webSearchToolEntry.formatModelContent(output);
  assert.doesNotMatch(rendered, /REMINDER/);
});
