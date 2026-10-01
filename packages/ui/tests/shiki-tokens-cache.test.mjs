import assert from "node:assert/strict";
import { test } from "node:test";
import {
  TOKENS_CACHE_MAX_BYTES,
  TOKENS_CACHE_MAX_ENTRIES,
  clearTokensCacheForTest,
  getShikiTokenCacheStats,
  hasTokensCacheEntryForTest,
  highlightCode,
  insertTokensCacheEntryForTest,
} from "../src/lib/shikiHighlighter.ts";
import { messageCodePlugin } from "../src/lib/streamdownCodePlugin.ts";

const TOKEN_ENTRY_OVERHEAD_BYTES = 64;

const singleTokenResult = (content) => ({
  bg: "transparent",
  fg: "inherit",
  tokens: [[{ content, color: "#000000" }]],
});

// highlightCode 的 tokenize 是异步的；回调送达即代表该次 tokenize 完成。
function highlightAsync(code, language = "json") {
  return new Promise((resolve) => {
    const sync = highlightCode(code, language, undefined, resolve);
    if (sync) {
      resolve(sync);
    }
  });
}

test("streaming deltas keep tokensCache at constant size (second-hit policy)", async () => {
  const before = getShikiTokenCacheStats();
  // 模拟流式渲染：同一逻辑代码块每个 delta 内容变长，缓存键含 code.length，
  // 400 个 delta 就是 400 个互不相同的内容键。
  for (let i = 1; i <= 400; i += 1) {
    const code = `const value = ${"1".repeat(i)};`;
    const sync = highlightCode(code, "json");
    // 首次请求未就绪：返回 null，不返回任何 token。
    assert.equal(sync, null);
  }

  const mid = getShikiTokenCacheStats();
  // 中间态一律不写缓存：条数必须是常数级（≤2，只可能来自重复键的二次命中）。
  assert.ok(
    mid.entries - before.entries <= 2,
    `tokensCache entries grew to ${mid.entries - before.entries} during streaming`,
  );
  // 400 个键全部记入廉价的 seenKeys（键长有界，本身不随 token 体积膨胀）。
  assert.equal(mid.seenKeys - before.seenKeys, 400);

  // 等待全部异步 tokenize 完成后再复查：完成回调也不会把中间态写入缓存。
  await new Promise((resolve) => setTimeout(resolve, 250));
  const after = getShikiTokenCacheStats();
  assert.ok(
    after.entries - before.entries <= 2,
    `tokensCache entries grew to ${after.entries - before.entries} after async completion`,
  );
});

test("second request for the same key writes tokensCache entry", async () => {
  const before = getShikiTokenCacheStats();
  const code = "function add(a, b) {\n  return a + b;\n}\n";

  // 第一次（首次出现）：未就绪返回 null；tokenize 完成后只送达回调、不写缓存。
  let firstResult;
  await new Promise((resolve) => {
    const sync = highlightCode(code, "json", undefined, (result) => {
      firstResult = result;
      resolve();
    });
    if (sync) {
      resolve(sync);
    }
  });
  assert.ok(Array.isArray(firstResult.tokens));
  assert.equal(
    hasTokensCacheEntryForTest(code, "json"),
    false,
    "first occurrence must not populate tokensCache",
  );

  // 第二次（同一内容键，二次命中）：tokenize 完成后写入 tokensCache。
  await highlightAsync(code, "json");
  assert.equal(hasTokensCacheEntryForTest(code, "json"), true);
  const after = getShikiTokenCacheStats();
  assert.equal(after.entries - before.entries, 1);
  assert.equal(after.misses - before.misses, 2);

  // 第三次：缓存命中，同步返回结果。
  const thirdSync = highlightCode(code, "json");
  assert.notEqual(thirdSync, null);
  assert.equal(thirdSync.tokens.length > 0, true);
  const final = getShikiTokenCacheStats();
  assert.equal(final.hits - before.hits, 1);
});

test("LRU evicts oldest entries beyond MAX_ENTRIES", () => {
  clearTokensCacheForTest();
  const before = getShikiTokenCacheStats();

  const total = TOKENS_CACHE_MAX_ENTRIES + 5;
  for (let i = 0; i < total; i += 1) {
    insertTokensCacheEntryForTest(`lru-entry-${i}`, "json", singleTokenResult("x"));
  }

  const after = getShikiTokenCacheStats();
  assert.equal(after.entries, TOKENS_CACHE_MAX_ENTRIES, "entries must cap at MAX_ENTRIES");
  assert.equal(after.evictions - before.evictions, 5, "oldest entries must be evicted");
  assert.equal(
    hasTokensCacheEntryForTest("lru-entry-0", "json"),
    false,
    "oldest entry must be evicted first",
  );
  assert.equal(
    hasTokensCacheEntryForTest(`lru-entry-${total - 1}`, "json"),
    true,
    "newest entry must survive",
  );
  assert.ok(
    after.bytes <= before.bytes + total * (1 + TOKEN_ENTRY_OVERHEAD_BYTES),
    "byte accounting must stay within inserted payload sizes",
  );
});

test("LRU evicts oldest entry when byte budget is exceeded", () => {
  clearTokensCacheForTest();
  const before = getShikiTokenCacheStats();

  const entryBytes = 25 * 1024 * 1024;
  const codeA = `a`.repeat(entryBytes);
  const codeB = `b`.repeat(entryBytes);

  insertTokensCacheEntryForTest(codeA, "json", singleTokenResult(codeA));
  const afterA = getShikiTokenCacheStats();
  assert.equal(afterA.entries, 1);
  assert.equal(afterA.bytes, entryBytes + TOKEN_ENTRY_OVERHEAD_BYTES);
  assert.equal(afterA.evictions, before.evictions);

  // 第二条 25MB 使总字节超过 40MB 预算：最旧的 A 被淘汰，bytes 回落到预算内。
  insertTokensCacheEntryForTest(codeB, "json", singleTokenResult(codeB));
  const afterB = getShikiTokenCacheStats();
  assert.equal(afterB.evictions - before.evictions, 1, "exceeding budget must evict");
  assert.equal(
    hasTokensCacheEntryForTest(codeA, "json"),
    false,
    "oldest oversized entry must be evicted",
  );
  assert.equal(hasTokensCacheEntryForTest(codeB, "json"), true);
  assert.equal(afterB.entries, 1, "byte budget must keep entry count bounded");
  assert.equal(afterB.bytes, entryBytes + TOKEN_ENTRY_OVERHEAD_BYTES, "bytes must fall back");
  assert.ok(afterB.bytes <= TOKENS_CACHE_MAX_BYTES);
});

test("messageCodePlugin mirrors @streamdown/code sync/callback semantics", async () => {
  assert.equal(messageCodePlugin.name, "shiki");
  assert.equal(messageCodePlugin.type, "code-highlighter");
  assert.equal(messageCodePlugin.supportsLanguage("json"), true);
  assert.equal(messageCodePlugin.supportsLanguage("text"), false);
  assert.ok(messageCodePlugin.getSupportedLanguages().includes("json"));
  // 单主题插件：getThemes 返回 [t, t]。
  const [light, dark] = messageCodePlugin.getThemes();
  assert.equal(light, dark);

  const code = "const pluginSemantics = 1;";
  const options = {
    code,
    language: "json",
    themes: ["github-light", "github-dark"],
  };

  // 首次请求：未就绪返回 null，tokenize 完成后经 callback 异步送达。
  const delivered = [];
  const deliveredPromise = new Promise((resolve) => {
    delivered.push(resolve);
  });
  const firstSync = messageCodePlugin.highlight(options, delivered[0]);
  assert.equal(firstSync, null, "not-ready highlight must return null");
  const callbackResult = await deliveredPromise;
  assert.ok(callbackResult && Array.isArray(callbackResult.tokens));
  assert.equal(typeof callbackResult.fg, "string");
  assert.equal(hasTokensCacheEntryForTest(code, "json"), false);

  // 第二次（二次命中）：仍未就绪返回 null，但完成后写入缓存。
  const secondDelivered = new Promise((resolve) => {
    delivered.push(resolve);
  });
  const secondSync = messageCodePlugin.highlight(options, delivered[1]);
  assert.equal(secondSync, null);
  await secondDelivered;
  assert.equal(hasTokensCacheEntryForTest(code, "json"), true);

  // 第三次：缓存命中，同步返回完整 token 结果（与原插件行为一致）。
  const thirdSync = messageCodePlugin.highlight(options);
  assert.ok(thirdSync);
  assert.deepEqual(Object.keys(thirdSync).sort(), ["bg", "fg", "tokens"]);
});
