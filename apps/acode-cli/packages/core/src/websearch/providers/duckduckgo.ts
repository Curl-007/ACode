// Ported from oh-my-pi (MIT) — packages/coding-agent/src/web/search/providers/duckduckgo.ts
// Copyright (c) 2025 Mario Zechner & Stencil Labs
// DuckDuckGo no-JS HTML 前端：POST q=… 拿静态结果页正则解析。Instant Answer API
// 只覆盖 Wikipedia/Wolfram 类话题，对多数 agent 查询为空（omp #3799），故用 HTML 前端。

import type { SearchResponse, SearchSource } from "../types.js";
import { SearchProviderError } from "../types.js";
import { markEngineModuleLoaded } from "../loaded-engines.js";
import { parseSearchQuery, type QuerySyntax, type StructuredQuery } from "../query-parse.js";
import { formatScraperQuery } from "../query-format.js";
import { clampNumResults, classifyProviderHttpError, dateToAgeSeconds, decodeHtmlText, withHardTimeout } from "../provider-utils.js";
import { browserFetch } from "../html-page.js";
import type { SearchParams } from "./base.js";
import { SearchProvider } from "./base.js";

markEngineModuleLoaded("duckduckgo");

const DUCKDUCKGO_HTML_URL = "https://html.duckduckgo.com/html/";
// ACode 适配：数据中心出口 IP 上 html 前端常被 anomaly 墙拦截，而 lite GET 前端
// （lite.duckduckgo.com）通常仍可用（2026-10 实测）。html POST 失败时自动降级 lite。
const DUCKDUCKGO_LITE_URL = "https://lite.duckduckgo.com/lite/";
const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 20;

/** recency → DDG `df` 表单参数；DDG 接受单字母时间过滤。 */
const RECENCY_TO_DDG_DF: Record<NonNullable<SearchParams["recency"]>, string> = {
  day: "d",
  week: "w",
  month: "m",
  year: "y",
};

interface ParsedResult {
  title: string;
  url: string;
  snippet?: string;
  publishedDate?: string;
}

/**
 * 解析 DDG 结果 href 回真实目标 URL：DDG 经 `//duckduckgo.com/l/?uddg=<encoded>`
 * 记录点击；处理重定向包装、协议相对链接与少见绝对 URL 三种形态。
 */
function unwrapResultUrl(href: string): string | undefined {
  if (!href) return undefined;
  const decoded = href.replace(/&amp;/gi, "&");
  const wrapMatch = decoded.match(/[?&]uddg=([^&]+)/);
  if (wrapMatch) {
    try {
      return decodeURIComponent(wrapMatch[1]);
    } catch {
      return undefined;
    }
  }
  if (decoded.startsWith("//")) return `https:${decoded}`;
  if (decoded.startsWith("http://") || decoded.startsWith("https://")) return decoded;
  return undefined;
}

/**
 * 从结果行提取发布时间戳。近期 DDG HTML 在 result__extras__url 容器里渲染裸
 * `<span>` 日期；只扫描该容器，避免把摘录里的日期形值误认成发布元数据。
 */
function extractPublishedDate(block: string): string | undefined {
  const extrasUrl = /<div\b[^>]*\bclass="[^"]*\bresult__extras__url\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(block)?.[1];
  if (!extrasUrl) return undefined;
  for (const match of extrasUrl.matchAll(/<span\b[^>]*>([\s\S]*?)<\/span>/gi)) {
    const text = decodeHtmlText(match[1]);
    if (/^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}|$)/.test(text)) return text;
  }
  return undefined;
}

/** 按文档顺序抽取结果块（omp 的 DOM 解析降解为正则，标签结构与 omp 版一致）。导出供解析桩测试。 */
export function parseHtmlResults(html: string): ParsedResult[] {
  const results: ParsedResult[] = [];
  const blockRe =
    /<div\b[^>]*\bclass="[^"]*\bresult\b[^"]*"[^>]*>([\s\S]*?)(?=<div\b[^>]*\bclass="[^"]*\bresult\b|<div\b[^>]*\bclass="[^"]*\bnav-link\b|$)/g;
  const titleRe = /<a\b[^>]*\bclass="[^"]*\bresult__a\b[^"]*"[^>]*\bhref="([^"]+)"[^>]*>([\s\S]*?)<\/a>/;
  const snippetRe = /<(?:a|div|span)\b[^>]*\bclass="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|span)>/;
  for (const match of html.matchAll(blockRe)) {
    const block = match[1];
    const title = titleRe.exec(block);
    if (!title) continue;
    const url = unwrapResultUrl(title[1]);
    if (!url) continue;
    const titleText = decodeHtmlText(title[2]);
    if (!titleText) continue;
    const snippet = snippetRe.exec(block);
    const snippetText = snippet ? decodeHtmlText(snippet[1]) : undefined;
    results.push({
      title: titleText,
      url,
      snippet: snippetText || undefined,
      publishedDate: extractPublishedDate(block),
    });
  }
  return results;
}

/** 从 DDG 翻页表单提取隐藏字段（属性顺序不定，逐 input 解析）。 */
function parseContinuationForm(html: string): URLSearchParams | undefined {
  for (const formMatch of html.matchAll(/<form\b[^>]*>([\s\S]*?)<\/form>/gi)) {
    const form = new URLSearchParams();
    for (const inputMatch of formMatch[1].matchAll(/<input\b[^>]*>/gi)) {
      const input = inputMatch[0];
      const name = /\bname\s*=\s*(["'])(.*?)\1/i.exec(input)?.[2];
      const value = /\bvalue\s*=\s*(["'])(.*?)\1/i.exec(input)?.[2];
      if (name && value !== undefined) form.append(decodeHtmlText(name), decodeHtmlText(value));
    }
    if (form.has("s") && form.has("vqd")) return form;
  }
  return undefined;
}

/** DDG 返回的是 bot 挑战弹窗而非结果（状态码 200/202 混用，以 body 为准）。 */
function isAnomalyResponse(html: string): boolean {
  return html.includes("anomaly-modal") || html.includes("anomaly.js");
}

/** DDG HTML 前端解析的查询语法；日期界 DDG 不解析，剥离后交给链上后置过滤。 */
const DDG_QUERY_SYNTAX: QuerySyntax = {
  phrases: true,
  negation: true,
  or: true,
  site: true,
  inUrl: true,
  inTitle: true,
  inText: true,
  filetype: true,
};

/** DDG 文档化的 `kl` 值（region-language 序，含 provider 专有码）。 */
const DDG_KL_CODES = new Set([
  "xa-ar", "xa-en", "ar-es", "au-en", "at-de", "be-fr", "be-nl", "br-pt", "bg-bg", "ca-en",
  "ca-fr", "ct-ca", "cl-es", "cn-zh", "co-es", "hr-hr", "cz-cs", "dk-da", "ee-et", "fi-fi",
  "fr-fr", "de-de", "gr-el", "hk-tzh", "hu-hu", "in-en", "id-id", "id-en", "ie-en", "il-he",
  "it-it", "jp-jp", "kr-kr", "lv-lv", "lt-lt", "xl-es", "my-ms", "my-en", "mx-es", "nl-nl",
  "nz-en", "no-no", "pe-es", "ph-en", "ph-tl", "pl-pl", "pt-pt", "ro-ro", "ru-ru", "sg-en",
  "sk-sk", "sl-sl", "za-en", "es-es", "se-sv", "ch-de", "ch-fr", "ch-it", "tw-tzh", "th-th",
  "tr-tr", "ua-uk", "uk-en", "us-en", "ue-es", "ve-es", "vn-vi", "wt-wt",
]);

/** DDG 码不遵循简单分量互换的 BCP 47 locale。 */
const DDG_LOCALE_ALIASES: Record<string, string> = {
  "ca-es": "ct-ca",
  "en-gb": "uk-en",
  "es-419": "xl-es",
  "es-us": "ue-es",
  "ja-jp": "jp-jp",
  "ko-kr": "kr-kr",
  "zh-hk": "hk-tzh",
  "zh-tw": "tw-tzh",
};

/** 把 `lang:` locale 映射到 DDG 的 `kl` 值；不在白名单则保持默认区域。 */
export function localeToKl(lang: string | undefined): string | undefined {
  if (!lang) return undefined;
  const locale = lang.toLowerCase().replaceAll("_", "-");
  const alias = DDG_LOCALE_ALIASES[locale];
  if (alias) return alias;
  const match = /^([a-z]{2})-([a-z]{2})$/.exec(locale);
  if (!match) return undefined;
  const candidate = `${match[2]}-${match[1]}`;
  return DDG_KL_CODES.has(candidate) ? candidate : undefined;
}

function createDuckDuckGoForm(params: SearchParams, parsed: StructuredQuery): URLSearchParams {
  const form = new URLSearchParams({
    q: formatScraperQuery(params.query, parsed, DDG_QUERY_SYNTAX),
    kl: localeToKl(parsed.lang) ?? "us-en",
  });
  const df = params.recency ? RECENCY_TO_DDG_DF[params.recency] : undefined;
  if (df) form.set("df", df);
  // b: "" 对齐真实浏览器表单提交模板。
  form.set("b", "");
  return form;
}

async function callDuckDuckGoHtml(
  params: SearchParams,
  form: URLSearchParams,
  signal: AbortSignal,
): Promise<string> {
  const page = await browserFetch(DUCKDUCKGO_HTML_URL, {
    fetch: params.fetch,
    signal,
    timeoutMs: params.timeoutMs,
    referer: "https://html.duckduckgo.com/",
    init: {
      method: "POST",
      body: form.toString(),
    },
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });

  if (page.status < 200 || page.status >= 300) {
    const classified = classifyProviderHttpError("duckduckgo", page.status, page.html);
    if (classified) throw classified;
    throw new SearchProviderError("duckduckgo", `DuckDuckGo HTML error (${page.status})`, page.status);
  }

  if (isAnomalyResponse(page.html)) {
    throw new SearchProviderError(
      "duckduckgo",
      "DuckDuckGo blocked the request with a bot-detection challenge. DuckDuckGo throttles automated HTML searches from datacenter/shared-egress IPs; configure a credentialed engine such as Brave, Tavily, Exa, or Kagi for reliable web search.",
      429,
    );
  }

  return page.html;
}

/** 经 DuckDuckGo no-JS HTML 前端执行搜索；被墙时降级 lite 前端（ACode 适配）。 */
export async function searchDuckDuckGo(params: SearchParams): Promise<SearchResponse> {
  const numResults = clampNumResults(params.numSearchResults ?? params.limit, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
  const parsed = params.parsedQuery ?? parseSearchQuery(params.query);
  try {
    return await searchDuckDuckGoHtmlFrontend(params, parsed, numResults);
  } catch (error) {
    // 用户取消不降级；bot 墙/网络错误降级 lite 前端再试一次。
    if (params.signal?.aborted) throw error;
    return searchDuckDuckGoLite(params, parsed, numResults);
  }
}

async function searchDuckDuckGoHtmlFrontend(
  params: SearchParams,
  parsed: StructuredQuery,
  numResults: number,
): Promise<SearchResponse> {
  const signal = withHardTimeout(params.signal, params.timeoutMs);
  const sources: SearchSource[] = [];
  const seen = new Set<string>();
  let form: URLSearchParams | undefined = createDuckDuckGoForm(params, parsed);

  while (form && sources.length < numResults) {
    const html = await callDuckDuckGoHtml(params, form, signal);
    const sourceCount = sources.length;
    for (const result of parseHtmlResults(html)) {
      if (seen.has(result.url)) continue;
      seen.add(result.url);
      sources.push({
        title: result.title,
        url: result.url,
        snippet: result.snippet,
        publishedDate: result.publishedDate,
        ageSeconds: dateToAgeSeconds(result.publishedDate),
      });
      if (sources.length >= numResults) break;
    }

    if (sources.length === sourceCount) break;
    form = parseContinuationForm(html);
  }

  return { provider: "duckduckgo", sources };
}

/** DuckDuckGo 搜索引擎（免 API key）。 */
export class DuckDuckGoProvider extends SearchProvider {
  readonly id = "duckduckgo" as const;
  readonly label = "DuckDuckGo";

  isAvailable(): boolean {
    return true;
  }

  override isExplicitlyAvailable(): boolean {
    return true;
  }

  search(params: SearchParams): Promise<SearchResponse> {
    return searchDuckDuckGo(params);
  }
}

/**
 * lite 前端的结果解析：`<a … class='result-link'>标题</a>`（href 为 uddg 包装）+
 * `<td class='result-snippet'>摘录</td>`。属性顺序不定（实测 href 在 class 前），
 * 先整标签匹配再提取 href。
 */
export function parseLiteHtmlResults(html: string): ParsedResult[] {
  const results: ParsedResult[] = [];
  for (const tagMatch of html.matchAll(/<a\b[^>]*\bclass=['"]result-link['"][^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = /\bhref=["']([^"']+)["']/i.exec(tagMatch[0])?.[1];
    if (!href) continue;
    const url = unwrapResultUrl(href);
    if (!url) continue;
    const titleText = decodeHtmlText(tagMatch[1]);
    if (!titleText) continue;
    // 摘录在紧随其后的 result-snippet 单元格；找不到就留空。
    const rest = html.slice((tagMatch.index ?? 0) + tagMatch[0].length);
    const snippetMatch = /<td\b[^>]*\bclass=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/i.exec(rest);
    const snippetText = snippetMatch ? decodeHtmlText(snippetMatch[1]) : undefined;
    results.push({ title: titleText, url, snippet: snippetText || undefined });
  }
  return results;
}

/** 构造 lite GET 查询参数（q/kl/df 与 html 前端同语义）。 */
function createLiteSearchUrl(parsed: StructuredQuery, params: SearchParams): string {
  const url = new URL(DUCKDUCKGO_LITE_URL);
  url.searchParams.set("q", formatScraperQuery(params.query, parsed, DDG_QUERY_SYNTAX));
  url.searchParams.set("kl", localeToKl(parsed.lang) ?? "us-en");
  const df = params.recency ? RECENCY_TO_DDG_DF[params.recency] : undefined;
  if (df) url.searchParams.set("df", df);
  return url.href;
}

/** html 前端被墙/失败时的 lite 降级路径：GET 拿静态结果表。 */
async function searchDuckDuckGoLite(params: SearchParams, parsed: StructuredQuery, numResults: number): Promise<SearchResponse> {
  const signal = withHardTimeout(params.signal, params.timeoutMs);
  const page = await browserFetch(createLiteSearchUrl(parsed, params), {
    fetch: params.fetch,
    signal,
    timeoutMs: params.timeoutMs,
    referer: "https://lite.duckduckgo.com/",
  });
  if (page.status < 200 || page.status >= 300) {
    const classified = classifyProviderHttpError("duckduckgo", page.status, page.html);
    if (classified) throw classified;
    throw new SearchProviderError("duckduckgo", `DuckDuckGo lite error (${page.status})`, page.status);
  }
  if (isAnomalyResponse(page.html)) {
    throw new SearchProviderError("duckduckgo", "DuckDuckGo lite also returned a bot-detection challenge.", 429);
  }
  const sources: SearchSource[] = [];
  const seen = new Set<string>();
  for (const result of parseLiteHtmlResults(page.html)) {
    if (seen.has(result.url)) continue;
    seen.add(result.url);
    sources.push({
      title: result.title,
      url: result.url,
      snippet: result.snippet,
      publishedDate: result.publishedDate,
      ageSeconds: dateToAgeSeconds(result.publishedDate),
    });
    if (sources.length >= numResults) break;
  }
  return { provider: "duckduckgo", sources };
}
