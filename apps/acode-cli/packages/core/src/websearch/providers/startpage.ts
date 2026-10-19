// Ported from oh-my-pi (MIT) — packages/coding-agent/src/web/search/providers/startpage.ts
// Copyright (c) 2025 Mario Zechner & Stencil Labs
// Startpage 代理 Google 索引，服务端渲染、happy path 无 JS 挑战。bot 防御卡的是
// 跳过首页握手的请求：搜索表单带会话 token（sc）等隐藏字段，用过期/缺失 token
// POST 会 302 到 CAPTCHA 壳。稳健流程与真实浏览器一致：GET 首页 → 提取表单隐藏
// 字段 → 带字段 POST 查询。omp 的 DOM 解析降解为正则。

import type { SearchResponse, SearchSource } from "../types.js";
import { SearchProviderError } from "../types.js";
import { markEngineModuleLoaded } from "../loaded-engines.js";
import { formatScraperQuery } from "../query-format.js";
import { clampNumResults, classifyProviderHttpError, decodeHtmlText, normalizeSearchText, withHardTimeout } from "../provider-utils.js";
import { browserFetch, type LoadedHtmlPage } from "../html-page.js";
import type { SearchParams } from "./base.js";
import { SearchProvider } from "./base.js";

markEngineModuleLoaded("startpage");

const STARTPAGE_HOME_URL = "https://www.startpage.com/";
const STARTPAGE_SEARCH_URL = "https://www.startpage.com/sp/search";
const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 20;

/** recency → Startpage `with_date` 参数（单字母；缺省不过滤）。 */
const RECENCY_TO_STARTPAGE_WITH_DATE: Record<NonNullable<SearchParams["recency"]>, string> = {
  day: "d",
  week: "w",
  month: "m",
  year: "y",
};

interface ParsedResult {
  title: string;
  url: string;
  snippet?: string;
}

/** Startpage 以 CAPTCHA/错误壳应答被拒请求：302 到 /en/errors/（旧 /sp/captcha），
 * Gatsby SPA 的 chunk map 点名 captcha 页组件。裸 "captcha" 子串刻意不用——
 * captcha 相关查询的摘录会误报。 */
function isChallengeResponse(page: LoadedHtmlPage): boolean {
  if (/\/(?:errors|captcha)\//.test(page.url) || page.url.includes("/sp/captcha")) return true;
  return page.html.includes("component---src-pages-captcha") || page.html.includes("/sp/captcha");
}

/** 正则提取首页 /sp/search 表单的隐藏字段；找不到 sc token 则返回 undefined，调用方降级为无 token GET。 */
function parseSearchFormInputs(html: string): Record<string, string> | undefined {
  const formMatch = /<form\b[^>]*\baction="\/sp\/search"[^>]*>([\s\S]*?)<\/form>/i.exec(html);
  if (!formMatch) return undefined;
  const inputs: Record<string, string> = {};
  for (const inputMatch of formMatch[1].matchAll(/<input\b[^>]*>/gi)) {
    const input = inputMatch[0];
    if (!/type\s*=\s*["']?hidden/i.test(input)) continue;
    const name = /\bname\s*=\s*(["'])(.*?)\1/i.exec(input)?.[2];
    const value = /\bvalue\s*=\s*(["'])(.*?)\1/i.exec(input)?.[2];
    if (name) inputs[name] = value ?? "";
  }
  return inputs.sc ? inputs : undefined;
}

/** 只接受指向 Startpage 之外的 http(s) 结果目标。 */
function sanitizeResultUrl(href: string): string | undefined {
  if (!href) return undefined;
  let url: URL;
  try {
    url = new URL(href, STARTPAGE_HOME_URL);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (url.hostname === "startpage.com" || url.hostname.endsWith(".startpage.com")) return undefined;
  return url.href;
}

/**
 * 正则按文档顺序走服务端渲染结果页：每个有机结果在 `div.result` 容器里，标题锚
 * `a.result-link`（内含 h2/h3），摘录 `p.description`。href 直链目标。
 */
function parseHtmlResults(html: string): ParsedResult[] {
  const results: ParsedResult[] = [];
  for (const blockMatch of html.matchAll(/<div\b[^>]*\bclass="[^"]*\bresult\b[^"]*"[^>]*>([\s\S]*?)<\/div>/gi)) {
    const block = blockMatch[1];
    const anchor = /<a\b[^>]*\bclass="[^"]*\bresult-link\b[^"]*"[^>]*\bhref="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    if (!anchor) continue;
    const url = sanitizeResultUrl(anchor[1].replace(/&amp;/gi, "&"));
    if (!url) continue;
    const heading = /<h[23]\b[^>]*>([\s\S]*?)<\/h[23]>/i.exec(anchor[2]);
    const title = normalizeSearchText(decodeHtmlText(heading?.[1] ?? anchor[2]));
    if (!title) continue;
    const description = /<p\b[^>]*\bclass="[^"]*\bdescription\b[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(block);
    const snippet = description ? normalizeSearchText(decodeHtmlText(description[1])) : undefined;
    results.push({ title, url, snippet: snippet || undefined });
  }
  return results;
}

/** 取首页并提取表单隐藏字段；尽力而为，任何失败返回 undefined 走直接 GET。 */
async function fetchFormInputs(
  fetchImpl: typeof fetch,
  signal: AbortSignal,
  timeoutMs?: number,
): Promise<Record<string, string> | undefined> {
  let page: LoadedHtmlPage;
  try {
    page = await browserFetch(STARTPAGE_HOME_URL, { fetch: fetchImpl, signal, timeoutMs });
  } catch (error) {
    if (signal.aborted) throw error;
    return undefined;
  }
  if (page.status < 200 || page.status >= 300 || isChallengeResponse(page)) return undefined;
  return parseSearchFormInputs(page.html);
}

async function callStartpageHtml(params: SearchParams): Promise<string> {
  const fetchImpl = params.fetch ?? fetch;
  const signal = withHardTimeout(params.signal, params.timeoutMs);
  const withDate = params.recency ? RECENCY_TO_STARTPAGE_WITH_DATE[params.recency] : undefined;
  // Startpage 代理 Google，算子内联可用；共享抓取格式化器规范化别名并降级
  // 抓取不友好算子。无指令查询逐字节通过。
  const query = formatScraperQuery(params.query, params.parsedQuery);

  const formInputs = await fetchFormInputs(fetchImpl, signal, params.timeoutMs);
  let page: LoadedHtmlPage;
  if (formInputs) {
    const form = new URLSearchParams(formInputs);
    form.set("query", query);
    if (withDate) form.set("with_date", withDate);
    page = await browserFetch(STARTPAGE_SEARCH_URL, {
      fetch: fetchImpl,
      signal,
      timeoutMs: params.timeoutMs,
      referer: STARTPAGE_HOME_URL,
      init: { method: "POST", body: form.toString() },
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
  } else {
    const url = new URL(STARTPAGE_SEARCH_URL);
    url.searchParams.set("query", query);
    if (withDate) url.searchParams.set("with_date", withDate);
    page = await browserFetch(url.href, {
      fetch: fetchImpl,
      signal,
      timeoutMs: params.timeoutMs,
      referer: STARTPAGE_HOME_URL,
    });
  }

  if (isChallengeResponse(page)) {
    throw new SearchProviderError(
      "startpage",
      "Startpage blocked the request with a CAPTCHA challenge. Startpage rate-limits automated searches from datacenter/shared-egress IPs; try another engine such as DuckDuckGo or Mojeek, or retry later.",
      429,
    );
  }
  if (page.status < 200 || page.status >= 300) {
    const classified = classifyProviderHttpError("startpage", page.status, page.html);
    if (classified) throw classified;
    throw new SearchProviderError("startpage", `Startpage HTML error (${page.status})`, page.status);
  }
  return page.html;
}

/** 经首页 token 表单流程执行 Startpage 搜索。 */
export async function searchStartpage(params: SearchParams): Promise<SearchResponse> {
  const numResults = clampNumResults(params.numSearchResults ?? params.limit, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
  const html = await callStartpageHtml(params);

  const sources: SearchSource[] = [];
  const seen = new Set<string>();
  for (const result of parseHtmlResults(html)) {
    if (seen.has(result.url)) continue;
    seen.add(result.url);
    sources.push({ title: result.title, url: result.url, snippet: result.snippet });
    if (sources.length >= numResults) break;
  }

  return { provider: "startpage", sources };
}

/** Startpage 搜索引擎（免 key）。 */
export class StartpageProvider extends SearchProvider {
  readonly id = "startpage" as const;
  readonly label = "Startpage";

  isAvailable(): boolean {
    return true;
  }

  override isExplicitlyAvailable(): boolean {
    return true;
  }

  search(params: SearchParams): Promise<SearchResponse> {
    return searchStartpage(params);
  }
}
