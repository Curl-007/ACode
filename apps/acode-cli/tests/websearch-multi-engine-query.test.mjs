import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * WebSearch 多引擎层 · StructuredQuery 解析与约束过滤（specs/websearch-multi-engine.md
 * 验收 1/4）：全部指令算子解析、方言重建、宽松后置过滤（宁放宽不空结果）。
 * 移植参照：oh-my-pi query.ts（MIT）。
 */

const { parseSearchQuery, parseDateValue } = await import(
  "../packages/core/src/websearch/query-parse.ts"
);
const { formatQuery, formatScraperQuery, GOOGLE_QUERY_SYNTAX } = await import(
  "../packages/core/src/websearch/query-format.ts"
);
const { applyQueryConstraints, matchesSite, matchesQueryConstraints } = await import(
  "../packages/core/src/websearch/query-filter.ts"
);

test("parseSearchQuery：site:/domain:/host: 归一化（小写、去 scheme、去 *.、带路径保留）", () => {
  const q = parseSearchQuery("docs site:https://*.GitHub.com/anthropics domain:example.org host:a.b.com");
  assert.deepEqual(q.sites, ["github.com/anthropics", "example.org", "a.b.com"]);
  assert.equal(q.hasDirectives, true);
  assert.equal(q.hasConstraints, true);
  // sites 从自由文本剥离。
  assert.equal(q.text, "docs");
});

test("parseSearchQuery：inurl:/intitle:/intext:/filetype: 及排除形式", () => {
  const q = parseSearchQuery("rust inurl:docs -inurl:blog intitle:\"budget tips\" -intitle:ad intext:alloc filetype:pdf -filetype:ppt");
  assert.deepEqual(q.inUrl, ["docs"]);
  assert.deepEqual(q.excludedInUrl, ["blog"]);
  assert.deepEqual(q.inTitle, ["budget tips"]);
  assert.deepEqual(q.excludedInTitle, ["ad"]);
  assert.deepEqual(q.inText, ["alloc"]);
  assert.deepEqual(q.filetypes, ["pdf"]);
  assert.deepEqual(q.excludedFiletypes, ["ppt"]);
});

test("parseSearchQuery：allintitle/allinurl 吞掉后续普通词元", () => {
  const q = parseSearchQuery("allintitle:budget tips 2024");
  assert.deepEqual(q.inTitle, ["budget", "tips", "2024"]);
  assert.equal(q.terms.length, 0);
});

test("parseSearchQuery：引号短语、+verbatim、-排除、NOT、OR 组", () => {
  const q = parseSearchQuery('"exact phrase" +verbatim -excluded NOT gone a OR b OR c plain');
  const phrases = q.terms.filter(t => t.phrase).map(t => t.text);
  assert.ok(phrases.includes("exact phrase"));
  assert.ok(phrases.includes("verbatim"));
  assert.deepEqual(q.terms.filter(t => t.negated).map(t => t.text), ["excluded", "gone"]);
  const groups = q.terms.filter(t => t.group !== undefined);
  assert.deepEqual(groups.map(t => t.text), ["a", "b", "c"]);
  assert.equal(new Set(groups.map(t => t.group)).size, 1);
  assert.ok(q.terms.some(t => t.text === "plain" && t.group === undefined));
});

test("parseSearchQuery：before/after 多格式日期 + lang；非法日期降解为普通词", () => {
  const q = parseSearchQuery("webgpu after:2024-03 before:2025 until:2025-06-01 since:2024 lang:zh-CN");
  // 同字段后写覆盖先写（since→after 覆盖、until→before 覆盖，最后出现者生效）。
  assert.equal(q.after, "2024-01-01", "since:2024 覆盖更早的 after:2024-03");
  assert.equal(q.before, "2025-06-01", "until:2025-06-01 覆盖 before:2025");
  assert.equal(q.lang, "zh-cn");
  const single = parseSearchQuery("webgpu after:2024-03");
  assert.equal(single.after, "2024-03-01");
  const bad = parseSearchQuery("query before:someday");
  assert.ok(bad.terms.some(t => t.text === "before:someday"), "不可解析日期保持原文为普通词");
});

test("parseDateValue：YYYY / YYYY-MM / YYYY-MM-DD / 斜杠与点分隔 / 日优先歧义", () => {
  assert.equal(parseDateValue("2024"), "2024-01-01");
  assert.equal(parseDateValue("2024-3"), "2024-03-01");
  assert.equal(parseDateValue("2024.3.5"), "2024-03-05");
  assert.equal(parseDateValue("03/05/2024"), "2024-03-05");
  assert.equal(parseDateValue("13/05/2024"), "2024-05-13", "首字段>12 按日优先");
  assert.equal(parseDateValue("2024-13-01"), undefined);
  assert.equal(parseDateValue("someday"), undefined);
});

test("parseSearchQuery：未知 name:value（URL/C:\\path）保持原文不误吞；-site:x 剥负号", () => {
  const q1 = parseSearchQuery("see https://example.com/a?b=1 TS2345: error");
  assert.ok(q1.terms.some(t => t.text.startsWith("https://example.com")));
  assert.ok(q1.terms.some(t => t.text.startsWith("TS2345:")));
  assert.equal(q1.hasDirectives, false);

  const q2 = parseSearchQuery("docs -site:pinterest.com");
  assert.deepEqual(q2.excludedSites, ["pinterest.com"]);
  assert.ok(!q2.terms.some(t => t.text.includes("pinterest")));
});

test("formatQuery：语法门控——不支持的算子剥离、支持的重发；纯指令查询回落约束值", () => {
  const q = parseSearchQuery('rust "async runtime" -tokio site:github.com inurl:release before:2025');
  assert.equal(
    formatQuery(q, GOOGLE_QUERY_SYNTAX),
    'rust "async runtime" -tokio site:github.com inurl:release before:2025-01-01',
  );
  // 无 site/inurl/dateRange 语法：指令剥离，词元保留。
  assert.equal(formatQuery(q, { phrases: true, negation: true }), 'rust "async runtime" -tokio');
  // 零语法 + 纯指令查询：回落约束值作关键词（引擎搜点什么好过空查询）。
  const only = parseSearchQuery("site:github.com filetype:pdf");
  assert.equal(formatQuery(only, {}), "github.com pdf");
  // 永不空：兜底 raw。
  assert.equal(formatQuery(parseSearchQuery("hello"), {}), "hello");
});

test("formatScraperQuery：带路径 site: 与 inurl: 结构性降级为普通词元；否定形式原样", () => {
  const out = formatScraperQuery("docs site:github.com/anthropics inurl:releases -site:pinterest.com");
  assert.ok(out.includes("github.com/anthropics"), "降级后作为普通词元保留");
  assert.ok(!out.includes("site:github.com/anthropics"));
  assert.ok(!out.includes("inurl:"));
  assert.ok(out.includes("-site:pinterest.com"), "否定 site 不降级");
  // 无指令查询逐字节通过。
  assert.equal(formatScraperQuery("plain query"), "plain query");
});

test("matchesSite：精确 host、子域、带路径前缀", () => {
  assert.equal(matchesSite("https://github.com/a", "github.com"), true);
  assert.equal(matchesSite("https://api.github.com/a", "github.com"), true);
  assert.equal(matchesSite("https://notgithub.com/a", "github.com"), false);
  assert.equal(matchesSite("https://github.com/anthropics/x", "github.com/anthropics"), true);
  assert.equal(matchesSite("https://gitlab.com/anthropics/x", "github.com/anthropics"), false);
});

// -----------------------------------------------
// applyQueryConstraints：宽松后置过滤（验收 4）
// -----------------------------------------------

const SRC = (url, title, publishedDate) => ({ url, title: title ?? url, publishedDate });

test("applyQueryConstraints：逐维度过滤保留存活集", () => {
  const sources = [
    SRC("https://github.com/a", "GitHub a"),
    SRC("https://docs.python.org/guide", "Python guide"),
    SRC("https://blog.spam.example/x", "spam"),
  ];
  const q = parseSearchQuery("site:github.com OR site:docs.python.org -site:blog.spam.example intitle:guide");
  const filtered = applyQueryConstraints(sources, q);
  assert.deepEqual(filtered.sources.map(s => s.url), ["https://docs.python.org/guide"]);
  assert.deepEqual(filtered.dropped, []);
});

test("applyQueryConstraints：清空全部结果的维度放宽并上报（宁放宽不空结果）", () => {
  const sources = [SRC("https://github.com/a", "a"), SRC("https://github.com/b", "b")];
  // filetype:pdf 零匹配 → 放宽；-site:github.com 会清空 → 放宽。
  const q = parseSearchQuery("filetype:pdf -site:github.com");
  const filtered = applyQueryConstraints(sources, q);
  assert.equal(filtered.sources.length, 2);
  assert.ok(filtered.dropped.includes("filetype:pdf"));
  assert.ok(filtered.dropped.includes("-site:github.com"));
});

test("applyQueryConstraints：无日期来源通过日期界（缺日期不是违规证据）", () => {
  const sources = [
    SRC("https://a.example/x", "dated", "2024-06-01"),
    SRC("https://b.example/y", "undated"),
  ];
  const q = parseSearchQuery("after:2025-01-01");
  const filtered = applyQueryConstraints(sources, q);
  // dated 被过滤（早于下界），undated 存活。
  assert.deepEqual(filtered.sources.map(s => s.url), ["https://b.example/y"]);
  assert.deepEqual(filtered.dropped, []);
});

test("matchesQueryConstraints：严格模式（全部维度必须通过）", () => {
  const q = parseSearchQuery("site:github.com");
  assert.equal(matchesQueryConstraints(SRC("https://github.com/a", "a"), q), true);
  assert.equal(matchesQueryConstraints(SRC("https://gitlab.com/a", "a"), q), false);
});

test("applyQueryConstraints：空输入直接返回空（不报放宽）", () => {
  const q = parseSearchQuery("site:github.com");
  const filtered = applyQueryConstraints([], q);
  assert.deepEqual(filtered.sources, []);
  assert.deepEqual(filtered.dropped, []);
});
