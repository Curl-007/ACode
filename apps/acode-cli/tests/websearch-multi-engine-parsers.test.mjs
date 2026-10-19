import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * WebSearch 多引擎层 · 抓取引擎解析桩（specs/websearch-multi-engine.md §4）：
 * 每引擎独立 fixture——单引擎坏不拖垮注册表。DDG html 前端 + lite 回退前端
 * （html 被 anomaly 墙时的降级路径，2026-10 实测标记）。独立成文件以保持
 * 懒加载观测测试不受模块级 import 干扰。
 */

const { parseLiteHtmlResults, parseHtmlResults, DuckDuckGoProvider } = await import(
  "../packages/core/src/websearch/providers/duckduckgo.ts"
);

const DDG_LITE_FIXTURE = `<table>
  <tr><td>1.&nbsp;</td>
    <td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fgithub.com%2Fa%2Fb&amp;rut=x" class='result-link'>GitHub - a/b: Title &amp; more</a></td>
  </tr>
  <tr><td>&nbsp;</td>
    <td class='result-snippet'>A <b>snippet</b> with markup &amp; entities.</td>
  </tr>
  <tr><td>2.&nbsp;</td>
    <td><a rel="nofollow" href="https://direct.example/page" class='result-link'>Direct link result</a></td>
  </tr>
</table>`;

test("duckduckgo lite 解析桩：uddg 解包、实体解码、直链透传、摘要归属", () => {
  const results = parseLiteHtmlResults(DDG_LITE_FIXTURE);
  assert.equal(results.length, 2);
  assert.equal(results[0].url, "https://github.com/a/b");
  assert.equal(results[0].title, "GitHub - a/b: Title & more");
  assert.equal(results[0].snippet, "A snippet with markup & entities.");
  assert.equal(results[1].url, "https://direct.example/page");
  assert.equal(results[1].snippet, undefined);
});

test("duckduckgo html 前端解析桩：result 块 + result__a + result__snippet + 发布时间", () => {
  const fixture = `<div class="result results_links results_links_deep web-result ">
    <div class="links_main links_deep result__body">
      <h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fx&amp;rut=y">Example <b>result</b></a></h2>
      <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fx&amp;rut=y">Some <b>snippet</b> text</a>
      <div class="result__extras__url"><span>&nbsp; &nbsp; 2026-07-30T20:19:00</span></div>
    </div>
  </div>`;
  const results = parseHtmlResults(fixture);
  assert.equal(results.length, 1);
  assert.equal(results[0].url, "https://example.org/x");
  assert.equal(results[0].title, "Example result");
  assert.equal(results[0].snippet, "Some snippet text");
  assert.equal(results[0].publishedDate, "2026-07-30T20:19:00");
});

test("duckduckgo：html 前端 anomaly 墙自动降级 lite 前端（假 fetch 桩）", async () => {
  const provider = new DuckDuckGoProvider();
  const calls = [];
  const fakeFetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes("html.duckduckgo.com")) {
      return new Response('<html><body><div id="anomaly-modal"></div></body></html>', { status: 200 });
    }
    return new Response(DDG_LITE_FIXTURE, { status: 200 });
  };
  const response = await provider.search({ query: "test", numSearchResults: 5, fetch: fakeFetch });
  assert.equal(calls.length, 2, "html 被墙后应降级 lite 一次");
  assert.ok(calls[0].includes("html.duckduckgo.com"));
  assert.ok(calls[1].includes("lite.duckduckgo.com"));
  assert.equal(response.provider, "duckduckgo");
  assert.equal(response.sources.length, 2);
});
