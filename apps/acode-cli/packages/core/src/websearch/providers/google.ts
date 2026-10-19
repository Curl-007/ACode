// Ported from oh-my-pi (MIT) — packages/coding-agent/src/web/search/providers/google.ts
// Copyright (c) 2025 Mario Zechner & Stencil Labs
// Google 网页搜索抓取（udm=14 免个性化网页结果）。omp 的 DOM 解析与隐身浏览器
// 回退降解为正则解析 + 纯 fetch；JS 挑战/流量墙识别为 429，由回退链兜底。

import type { SearchResponse, SearchSource } from "../types.js";
import { SearchProviderError } from "../types.js";
import { markEngineModuleLoaded } from "../loaded-engines.js";
import { formatScraperQuery } from "../query-format.js";
import { clampNumResults, decodeHtmlText, normalizeSearchText, withHardTimeout } from "../provider-utils.js";
import { browserFetch } from "../html-page.js";
import type { SearchParams } from "./base.js";
import { SearchProvider } from "./base.js";

markEngineModuleLoaded("google");

const GOOGLE_HOME_URL = "https://www.google.com/";
const GOOGLE_SEARCH_URL = "https://www.google.com/search";
const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 20;

const RECENCY_TO_GOOGLE_TBS: Record<NonNullable<SearchParams["recency"]>, string> = {
  day: "qdr:d",
  week: "qdr:w",
  month: "qdr:m",
  year: "qdr:y",
};

interface ParsedResult {
  title: string;
  url: string;
  snippet?: string;
}

/** 解开 Google `/url?q=` 跳转包装；拒绝非 http(s) 与 Google 站内目标。 */
function unwrapResultUrl(href: string): string | undefined {
  let url: URL;
  try {
    url = new URL(href, GOOGLE_HOME_URL);
  } catch {
    return undefined;
  }

  if ((url.hostname === "google.com" || url.hostname === "www.google.com") && url.pathname === "/url") {
    const target = url.searchParams.get("q") || url.searchParams.get("url");
    if (!target) return undefined;
    try {
      url = new URL(target);
    } catch {
      return undefined;
    }
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (url.hostname === "google.com" || url.hostname === "www.google.com") return undefined;
  return url.href;
}

/**
 * 正则抽取结果：每个有机结果含 `<h3>` 标题、外层 `<a href>` 与
 * `<div class="VwiC3b">` 摘录（Google 多代布局的稳定锚）。按文档顺序去重。
 */
function parseHtmlResults(html: string): ParsedResult[] {
  const results: ParsedResult[] = [];
  const anchorRe = /<a\b[^>]*\bhref="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  for (const anchorMatch of html.matchAll(anchorRe)) {
    const inner = anchorMatch[2];
    const heading = /<h3\b[^>]*>([\s\S]*?)<\/h3>/i.exec(inner);
    if (!heading) continue;
    const url = unwrapResultUrl(anchorMatch[1].replace(/&amp;/gi, "&"));
    if (!url) continue;
    const title = normalizeSearchText(decodeHtmlText(heading[1]));
    if (!title) continue;
    // 摘录：优先 VwiC3b（当前桌面布局），退化取同锚块内的 s3v9rd 文本块。
    const snippet =
      /class="[^"]*\bVwiC3b\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(inner) ??
      /class="[^"]*\bs3v9rd\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(inner);
    const snippetText = snippet ? normalizeSearchText(decodeHtmlText(snippet[1])) : undefined;
    results.push({ title, url, snippet: snippetText || undefined });
  }
  return results;
}

function buildSearchUrl(params: SearchParams, numResults: number): string {
  const url = new URL(GOOGLE_SEARCH_URL);
  url.searchParams.set("q", formatScraperQuery(params.query, params.parsedQuery));
  url.searchParams.set("num", String(numResults));
  url.searchParams.set("hl", "en");
  url.searchParams.set("gl", "us");
  url.searchParams.set("udm", "14");
  url.searchParams.set("pws", "0");
  const tbs = params.recency ? RECENCY_TO_GOOGLE_TBS[params.recency] : undefined;
  if (tbs) url.searchParams.set("tbs", tbs);
  return url.href;
}

function blockReason(status: number, url: string, html: string): "javascript" | "traffic" | undefined {
  if (html.includes("/httpservice/retry/enablejs") && !/<h3\b/i.test(html)) return "javascript";
  if (
    status === 403 ||
    status === 429 ||
    url.includes("/sorry/") ||
    /unusual traffic|detected unusual traffic|g-recaptcha/i.test(html)
  ) {
    return "traffic";
  }
  return undefined;
}

async function callGoogleHtml(params: SearchParams, numResults: number): Promise<string> {
  const signal = withHardTimeout(params.signal, params.timeoutMs);
  const url = buildSearchUrl(params, numResults);
  let html: string;
  let status: number;
  let finalUrl = url;
  try {
    const page = await browserFetch(url, {
      fetch: params.fetch,
      signal,
      timeoutMs: params.timeoutMs,
      referer: GOOGLE_HOME_URL,
    });
    html = page.html;
    status = page.status;
    finalUrl = page.url;
  } catch (error) {
    if (error instanceof SearchProviderError || params.signal?.aborted) throw error;
    if (signal.aborted) {
      throw new SearchProviderError("google", "Google search timed out.", 504);
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new SearchProviderError("google", `Google search failed: ${message}`, 503);
  }

  const blocked = blockReason(status, finalUrl, html);
  if (blocked === "traffic") {
    throw new SearchProviderError(
      "google",
      "Google blocked the search with an automated-traffic challenge. Try another web search engine or retry later.",
      429,
    );
  }
  if (status < 200 || status >= 300) {
    throw new SearchProviderError("google", `Google HTML error (${status})`, status);
  }
  if (blocked === "javascript") {
    throw new SearchProviderError("google", "Google returned its JavaScript challenge instead of rendered search results.", 429);
  }
  return html;
}

/** 抓取 Google 网页结果（免 key）。 */
export async function searchGoogle(params: SearchParams): Promise<SearchResponse> {
  const numResults = clampNumResults(params.numSearchResults ?? params.limit, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
  const html = await callGoogleHtml(params, numResults);

  const sources: SearchSource[] = [];
  const seen = new Set<string>();
  for (const result of parseHtmlResults(html)) {
    if (seen.has(result.url)) continue;
    seen.add(result.url);
    sources.push({ title: result.title, url: result.url, snippet: result.snippet });
    if (sources.length >= numResults) break;
  }

  return { provider: "google", sources };
}

/** Google 抓取搜索引擎（免 key）。 */
export class GoogleProvider extends SearchProvider {
  readonly id = "google" as const;
  readonly label = "Google";

  isAvailable(): boolean {
    return true;
  }

  search(params: SearchParams): Promise<SearchResponse> {
    return searchGoogle(params);
  }
}
