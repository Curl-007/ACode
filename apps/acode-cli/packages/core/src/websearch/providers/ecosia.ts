// Ported from oh-my-pi (MIT) — packages/coding-agent/src/web/search/providers/ecosia.ts
// Copyright (c) 2025 Mario Zechner & Stencil Labs
// Ecosia 服务端渲染 Vue/Nuxt 结果页（无 __NUXT_DATA__ JSON 岛），Google 支持的
// 结果、data-test-id 稳定标注。站点前置 Cloudflare。omp 的 DOM 解析与隐身浏览器
// 回退降解为正则解析 + 纯 fetch。recency 被忽略：Ecosia web 结果无日期过滤 UI，
// Bing 时代 freshness 参数是服务端 no-op——按 recency 契约不得近似。

import type { SearchResponse, SearchSource } from "../types.js";
import { SearchProviderError } from "../types.js";
import { markEngineModuleLoaded } from "../loaded-engines.js";
import { formatScraperQuery } from "../query-format.js";
import { clampNumResults, classifyProviderHttpError, decodeHtmlText, normalizeSearchText, withHardTimeout } from "../provider-utils.js";
import { browserFetch } from "../html-page.js";
import type { SearchParams } from "./base.js";
import { SearchProvider } from "./base.js";

markEngineModuleLoaded("ecosia");

const ECOSIA_HOME_URL = "https://www.ecosia.org/";
const ECOSIA_SEARCH_URL = "https://www.ecosia.org/search";
const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 20;

interface ParsedResult {
  title: string;
  url: string;
  snippet?: string;
}

/** 有机结果锚直接携带目标 URL；非 http(s) 或指回 ecosia.org（站内导航）的拒绝。 */
function resolveResultUrl(href: string): string | undefined {
  let url: URL;
  try {
    url = new URL(href, ECOSIA_HOME_URL);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (url.hostname === "ecosia.org" || url.hostname === "www.ecosia.org") return undefined;
  return url.href;
}

/**
 * 正则抽取 `<article data-test-id="organic-result">`：标题在
 * `<h2 data-test-id="result-title">` 外包目标链接，摘录在
 * `<p data-test-id="web-result-description">`（优先于 result-description 容器，
 * 容器还装着视频行的读屏缩略图说明）。广告槽与实体卡是别的 test-id，天然不匹配。
 */
function parseHtmlResults(html: string): ParsedResult[] {
  const results: ParsedResult[] = [];
  for (const articleMatch of html.matchAll(
    /<article\b[^>]*\bdata-test-id=["']organic-result["'][^>]*>([\s\S]*?)<\/article>/gi,
  )) {
    const article = articleMatch[1];
    const heading = /<h2\b[^>]*\bdata-test-id=["']result-title["'][^>]*>([\s\S]*?)<\/h2>/i.exec(article);
    if (!heading) continue;
    const anchor = /<a\b[^>]*\bhref="([^"]+)"/i.exec(heading[1]);
    if (!anchor) continue;
    const url = resolveResultUrl(anchor[1].replace(/&amp;/gi, "&"));
    if (!url) continue;
    const title = normalizeSearchText(decodeHtmlText(heading[1]));
    if (!title) continue;
    const description =
      /<p\b[^>]*\bdata-test-id=["']web-result-description["'][^>]*>([\s\S]*?)<\/p>/i.exec(article) ??
      /<p\b[^>]*\bdata-test-id=["']result-description["'][^>]*>([\s\S]*?)<\/p>/i.exec(article);
    const snippet = description ? normalizeSearchText(decodeHtmlText(description[1])) : undefined;
    results.push({ title, url, snippet });
  }
  return results;
}

/** Cloudflare 托管挑战而非结果的判别：403 "Ecosia Firewall" + _cf_chl_opt。 */
function isBlockedPage(status: number, html: string): boolean {
  return (
    status === 403 ||
    status === 429 ||
    html.includes("Ecosia Firewall") ||
    html.includes("_cf_chl_opt") ||
    html.includes("/cdn-cgi/challenge-platform/") ||
    /confirm you.{0,3}re not a robot/i.test(html)
  );
}

async function callEcosiaHtml(params: SearchParams): Promise<string> {
  const signal = withHardTimeout(params.signal, params.timeoutMs);
  const url = new URL(ECOSIA_SEARCH_URL);
  // Ecosia 是 Google 支持的结果，经典算子内联可用；共享抓取格式化器规范化别名并
  // 降级抓取不友好算子。
  url.searchParams.set("q", formatScraperQuery(params.query, params.parsedQuery));

  let html: string;
  let status: number;
  try {
    const page = await browserFetch(url.href, {
      fetch: params.fetch,
      signal,
      timeoutMs: params.timeoutMs,
      referer: ECOSIA_HOME_URL,
    });
    html = page.html;
    status = page.status;
  } catch (error) {
    if (error instanceof SearchProviderError || params.signal?.aborted) throw error;
    if (signal.aborted) {
      throw new SearchProviderError("ecosia", "Ecosia search timed out.", 504);
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new SearchProviderError("ecosia", `Ecosia search failed: ${message}`, 503);
  }

  if (isBlockedPage(status, html)) {
    throw new SearchProviderError(
      "ecosia",
      "Ecosia blocked the request with a Cloudflare bot challenge. Ecosia's firewall throttles automated searches from datacenter/shared-egress IPs; try another engine such as DuckDuckGo, Brave, or Tavily.",
      429,
    );
  }
  if (status < 200 || status >= 300) {
    const classified = classifyProviderHttpError("ecosia", status, html);
    if (classified) throw classified;
    throw new SearchProviderError("ecosia", `Ecosia HTML error (${status})`, status);
  }
  return html;
}

/** 执行 Ecosia 搜索并解析服务端渲染结果页。 */
export async function searchEcosia(params: SearchParams): Promise<SearchResponse> {
  const numResults = clampNumResults(params.numSearchResults ?? params.limit, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
  const html = await callEcosiaHtml(params);

  const sources: SearchSource[] = [];
  const seen = new Set<string>();
  for (const result of parseHtmlResults(html)) {
    if (seen.has(result.url)) continue;
    seen.add(result.url);
    sources.push({ title: result.title, url: result.url, snippet: result.snippet });
    if (sources.length >= numResults) break;
  }

  return { provider: "ecosia", sources };
}

/** Ecosia 搜索引擎（免 key）。 */
export class EcosiaProvider extends SearchProvider {
  readonly id = "ecosia" as const;
  readonly label = "Ecosia";

  isAvailable(): boolean {
    return true;
  }

  override isExplicitlyAvailable(): boolean {
    return true;
  }

  search(params: SearchParams): Promise<SearchResponse> {
    return searchEcosia(params);
  }
}
