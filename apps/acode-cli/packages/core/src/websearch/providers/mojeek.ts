// Ported from oh-my-pi (MIT) — packages/coding-agent/src/web/search/providers/mojeek.ts
// Copyright (c) 2025 Mario Zechner & Stencil Labs
// Mojeek 独立索引，免 key。omp 的 DOM 解析（parseHTML）与 ALTCHA 隐身浏览器回退
// 降解：ACode core 用正则解析标准 HTML 结果页；ALTCHA 墙识别为 429 错误，由回退链
// 换引擎兜底。

import type { SearchResponse, SearchSource } from "../types.js";
import { SearchProviderError } from "../types.js";
import { markEngineModuleLoaded } from "../loaded-engines.js";
import type { QuerySyntax } from "../query-parse.js";
import { formatScraperQuery } from "../query-format.js";
import { clampNumResults, classifyProviderHttpError, decodeHtmlText, normalizeSearchText, withHardTimeout } from "../provider-utils.js";
import { browserFetch } from "../html-page.js";
import type { SearchParams } from "./base.js";
import { SearchProvider } from "./base.js";

markEngineModuleLoaded("mojeek");

const MOJEEK_HOME_URL = "https://www.mojeek.com/";
const MOJEEK_SEARCH_URL = "https://www.mojeek.com/search";
const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 20;

interface ParsedResult {
  title: string;
  url: string;
  snippet?: string;
}

/** Mojeek 直链目标站（无重定向包装）；过滤非 http(s) 与站内导航行。 */
function normalizeResultUrl(href: string): string | undefined {
  let url: URL;
  try {
    url = new URL(href, MOJEEK_HOME_URL);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (url.hostname === "mojeek.com" || url.hostname.endsWith(".mojeek.com")) return undefined;
  return url.href;
}

/**
 * 正则抽取有机结果：omp 版遍历 `ul.results-standard > li`，标题在 `h2 a.title`
 * （href 直链），摘录在 `p.s`。这里按同结构用正则匹配（属性顺序不定，宽松匹配）。
 */
function parseHtmlResults(html: string): ParsedResult[] {
  const results: ParsedResult[] = [];
  const liRe = /<li\b[^>]*>([\s\S]*?)<\/li>/gi;
  for (const liMatch of html.matchAll(liRe)) {
    const li = liMatch[1];
    if (!/class="[^"]*\btitle\b/.test(li)) continue;
    const anchor = /<a\b[^>]*\bclass="[^"]*\btitle\b[^"]*"[^>]*\bhref="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(li);
    if (!anchor) continue;
    const url = normalizeResultUrl(anchor[1].replace(/&amp;/gi, "&"));
    if (!url) continue;
    const title = normalizeSearchText(decodeHtmlText(anchor[2]));
    if (!title) continue;
    const p = /<p\b[^>]*\bclass="[^"]*\bs\b[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(li);
    const snippet = p ? normalizeSearchText(decodeHtmlText(p[1])) : undefined;
    results.push({ title, url, snippet });
  }
  return results;
}

/**
 * 发给 Mojeek 的指令语法：官方支持 site:，社区文档确认引号短语与 - 排除。
 * 日期界与 in* 算子保守交给链上后置过滤。
 */
const MOJEEK_QUERY_SYNTAX: QuerySyntax = { phrases: true, negation: true, site: true };

function buildSearchUrl(params: SearchParams, numResults: number): string {
  const url = new URL(MOJEEK_SEARCH_URL);
  url.searchParams.set("q", formatScraperQuery(params.query, params.parsedQuery, MOJEEK_QUERY_SYNTAX));
  url.searchParams.set("t", String(numResults));
  url.searchParams.set("arc", "none");
  url.searchParams.set("lang", "en");
  url.searchParams.set("lb", "en");
  url.searchParams.set("theme", "dark");
  // Mojeek 的 `since` 过滤接受 day/week/month/year 相对词——与 recency 同词汇。
  if (params.recency) url.searchParams.set("since", params.recency);
  return url.href;
}

function isRobotPage(html: string): boolean {
  return (
    (html.includes("altcha-widget") || html.includes("captcha-wrap") || /sending automated queries/i.test(html)) &&
    !html.includes("results-standard")
  );
}

async function callMojeekHtml(params: SearchParams, numResults: number): Promise<string> {
  const signal = withHardTimeout(params.signal, params.timeoutMs);
  const url = buildSearchUrl(params, numResults);
  let html: string;
  let status: number;
  try {
    const page = await browserFetch(url, {
      fetch: params.fetch,
      signal,
      timeoutMs: params.timeoutMs,
      referer: MOJEEK_HOME_URL,
    });
    html = page.html;
    status = page.status;
  } catch (error) {
    if (error instanceof SearchProviderError || params.signal?.aborted) throw error;
    if (signal.aborted) {
      throw new SearchProviderError("mojeek", "Mojeek search timed out.", 504);
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new SearchProviderError("mojeek", `Mojeek search failed: ${message}`, 503);
  }

  // 机器人墙：ALTCHA 挑战页 HTTP 200、自动化查询拒绝 HTTP 403；body 比状态码更可操作。
  if (isRobotPage(html)) {
    throw new SearchProviderError(
      "mojeek",
      "Mojeek blocked the request with its automated-queries wall. Mojeek rate-limits scripted searches from datacenter/shared-egress IPs; retry later or configure another engine such as Brave, Tavily, Exa, or Kagi.",
      429,
    );
  }
  if (status < 200 || status >= 300) {
    const classified = classifyProviderHttpError("mojeek", status, html);
    if (classified) throw classified;
    throw new SearchProviderError("mojeek", `Mojeek HTML error (${status})`, status);
  }
  return html;
}

/** 对 Mojeek 标准 HTML 结果页执行搜索。 */
export async function searchMojeek(params: SearchParams): Promise<SearchResponse> {
  const numResults = clampNumResults(params.numSearchResults ?? params.limit, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
  const html = await callMojeekHtml(params, numResults);

  const sources: SearchSource[] = [];
  const seen = new Set<string>();
  for (const result of parseHtmlResults(html)) {
    if (seen.has(result.url)) continue;
    seen.add(result.url);
    sources.push({ title: result.title, url: result.url, snippet: result.snippet });
    if (sources.length >= numResults) break;
  }

  return { provider: "mojeek", sources };
}

/** Mojeek 搜索引擎（独立索引，免 key）。 */
export class MojeekProvider extends SearchProvider {
  readonly id = "mojeek" as const;
  readonly label = "Mojeek";

  isAvailable(): boolean {
    return true;
  }

  override isExplicitlyAvailable(): boolean {
    return true;
  }

  search(params: SearchParams): Promise<SearchResponse> {
    return searchMojeek(params);
  }
}
