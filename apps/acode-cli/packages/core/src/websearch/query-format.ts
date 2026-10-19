// Ported from oh-my-pi (MIT) — packages/coding-agent/src/web/search/query.ts（格式化半部）
// Copyright (c) 2025 Mario Zechner & Stencil Labs
// 各引擎方言的查询重建：引擎缺的语法从查询串剥离，交给 applyQueryConstraints 后置过滤。

import type { QuerySyntax, StructuredQuery } from "./query-parse.js";
import { parseSearchQuery, renderTerms } from "./query-parse.js";

export type { QuerySyntax, StructuredQuery };

/** 完整 Google 语法：解析经典算子集的引擎（Google、Startpage、Ecosia、Brave、Kagi、Mojeek、SearXNG…）。 */
export const GOOGLE_QUERY_SYNTAX: QuerySyntax = {
  phrases: true,
  negation: true,
  or: true,
  site: true,
  inUrl: true,
  inTitle: true,
  inText: true,
  filetype: true,
  dateRange: true,
};

/** 指令值含空白时加引号。 */
function quoteValue(value: string): string {
  return /\s/.test(value) ? `"${value}"` : value;
}

/**
 * 按给定 QuerySyntax 为引擎重建查询串。
 *
 * 引擎缺语法的约束被省略（调用方映射为 API 参数或依赖 applyQueryConstraints）。
 * 非空输入永不返回空串：指令型查询回落为约束值作关键词，再回落 `raw`——
 * 引擎搜点什么好过空查询报错。
 */
export function formatQuery(q: StructuredQuery, syntax: QuerySyntax = {}): string {
  const parts: string[] = [];
  const text = renderTerms(q.terms, syntax);
  if (text) parts.push(text);

  if (syntax.site) {
    if (q.sites.length > 1 && syntax.or) parts.push(`(${q.sites.map(s => `site:${s}`).join(" OR ")})`);
    else parts.push(...q.sites.map(s => `site:${s}`));
    parts.push(...q.excludedSites.map(s => `-site:${s}`));
  }
  if (syntax.inUrl) {
    parts.push(...q.inUrl.map(v => `inurl:${quoteValue(v)}`));
    parts.push(...q.excludedInUrl.map(v => `-inurl:${quoteValue(v)}`));
  }
  if (syntax.inTitle) {
    parts.push(...q.inTitle.map(v => `intitle:${quoteValue(v)}`));
    parts.push(...q.excludedInTitle.map(v => `-intitle:${quoteValue(v)}`));
  }
  if (syntax.inText) {
    parts.push(...q.inText.map(v => `intext:${quoteValue(v)}`));
    parts.push(...q.excludedInText.map(v => `-intext:${quoteValue(v)}`));
  }
  if (syntax.filetype) {
    if (q.filetypes.length > 1 && syntax.or) parts.push(`(${q.filetypes.map(f => `filetype:${f}`).join(" OR ")})`);
    else parts.push(...q.filetypes.map(f => `filetype:${f}`));
    parts.push(...q.excludedFiletypes.map(f => `-filetype:${f}`));
  }
  if (syntax.dateRange) {
    if (q.after) parts.push(`after:${q.after}`);
    if (q.before) parts.push(`before:${q.before}`);
  }

  let result = parts.join(" ").trim();
  if (!result) {
    // 纯指令查询且引擎不支持指令语法：把约束值当普通关键词搜，引擎仍拿到有意义的查询。
    const fallback = [...q.sites, ...q.inTitle, ...q.inUrl, ...q.inText, ...q.filetypes];
    result = fallback.join(" ").trim();
  }
  return result || q.raw.trim();
}

/**
 * 为免凭据 HTML 引擎（Google、Startpage、DuckDuckGo、Ecosia、Mojeek、SearXNG
 * 及其上的 Public Web 扇出）构建引擎查询。
 *
 * 先经 formatQuery 按引擎语法规范化指令，再把在抓取引擎集合上零匹配的算子降级：
 * 引擎只拿裸域匹配 `site:`（带路径的处处零结果），DuckDuckGo 完全忽略 `inurl:`——
 * 任一算子都会悄悄清空结果集。裸 URL 作为普通词元匹配没问题，所以裸域 `site:`
 * 过滤保留，带路径 `site:` 与全部 `inurl:` 值降为普通关键词；降级发生在格式化前的
 * 结构层（OR 组与引号指令一并覆盖）。否定形式（-site:、-inurl:）原样通过——降级会把
 * 排除反成搜索词；链上后置过滤强制执行每条被降级或不支持的约束。无指令查询逐字节通过。
 */
export function formatScraperQuery(
  query: string,
  parsedQuery?: StructuredQuery,
  syntax: QuerySyntax = GOOGLE_QUERY_SYNTAX,
): string {
  const parsed = parsedQuery ?? parseSearchQuery(query);
  if (!parsed.hasDirectives) return query;
  const demoted = [...parsed.sites.filter(site => site.includes("/")), ...parsed.inUrl];
  const downgraded: StructuredQuery = {
    ...parsed,
    sites: parsed.sites.filter(site => !site.includes("/")),
    inUrl: [],
    terms: [...parsed.terms, ...demoted.map(text => ({ text }))],
  };
  return formatQuery(downgraded, syntax);
}
