// Ported from oh-my-pi (MIT) — packages/coding-agent/src/web/search/providers/tavily.ts
// Copyright (c) 2025 Mario Zechner & Stencil Labs
// Tavily agent 搜索 API：结构化结果 + 可选合成答案。凭据：TAVILY_API_KEY（env）。

import type { SearchResponse, SearchSource } from "../types.js";
import { SearchProviderError } from "../types.js";
import { markEngineModuleLoaded } from "../loaded-engines.js";
import { parseSearchQuery } from "../query-parse.js";
import { formatQuery } from "../query-format.js";
import { clampNumResults, classifyProviderHttpError, dateToAgeSeconds, siteHosts, withHardTimeout } from "../provider-utils.js";
import { resolveEngineApiKey } from "../credentials.js";
import type { SearchParams } from "./base.js";
import { SearchProvider } from "./base.js";

markEngineModuleLoaded("tavily");

const TAVILY_SEARCH_URL = "https://api.tavily.com/search";
const DEFAULT_NUM_RESULTS = 5;
const MAX_NUM_RESULTS = 20;

interface TavilySearchResponse {
  answer?: unknown;
  results?: unknown;
  request_id?: unknown;
}

interface TavilySearchParamsShape {
  query: string;
  num_results?: number;
  recency?: SearchParams["recency"];
  include_domains?: string[];
  exclude_domains?: string[];
  start_date?: string;
  end_date?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) return null;
  return value as Record<string, unknown>;
}

function getErrorMessage(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  const record = asRecord(value);
  if (!record) return null;
  for (const key of ["detail", "error", "message"]) {
    const message = getErrorMessage(record[key]);
    if (message) return message;
  }
  return null;
}

/** 供测试导出：统一参数构建 Tavily 请求体。 */
export function buildRequestBody(params: TavilySearchParamsShape): Record<string, unknown> {
  const numResults = clampNumResults(params.num_results, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
  // Tavily 的 topic（general/news/finance）与 time_range 是正交维度。recency 只是
  // 时间过滤，不得把索引收窄到 news（会毁掉 release notes/docs/GitHub 类技术查询）。
  // 恒用默认 general topic，仅在设 recency 时发 time_range。
  const body: Record<string, unknown> = {
    query: params.query,
    search_depth: "basic",
    max_results: numResults,
    include_answer: "advanced",
    include_raw_content: false,
  };
  if (params.include_domains?.length) body.include_domains = params.include_domains;
  if (params.exclude_domains?.length) body.exclude_domains = params.exclude_domains;
  if (params.start_date) body.start_date = params.start_date;
  if (params.end_date) body.end_date = params.end_date;
  // 显式 before:/after: 界优先于相对 recency 窗口；两个都发会过度收窄。
  if (params.recency && !params.start_date && !params.end_date) {
    body.time_range = params.recency;
  }
  return body;
}

async function callTavilySearch(apiKey: string, params: TavilySearchParamsShape & { signal?: AbortSignal; timeoutMs?: number; fetch?: typeof fetch }): Promise<TavilySearchResponse> {
  const response = await (params.fetch ?? fetch)(TAVILY_SEARCH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(buildRequestBody(params)),
    signal: withHardTimeout(params.signal, params.timeoutMs),
  });

  if (!response.ok) {
    const errorText = await response.text();
    const classified = classifyProviderHttpError("tavily", response.status, errorText);
    if (classified) throw classified;
    let message = errorText.trim();
    if (message.length === 0) {
      message = response.statusText;
    } else {
      try {
        message = getErrorMessage(JSON.parse(errorText)) ?? message;
      } catch {
        // 保留原始文本回退。
      }
    }
    throw new SearchProviderError("tavily", `Tavily API error (${response.status}): ${message}`, response.status);
  }

  const payload: unknown = await response.json();
  return asRecord(payload) ?? {};
}

function toSearchResponse(response: TavilySearchResponse, numResults: number): SearchResponse {
  const sources: SearchSource[] = [];
  if (Array.isArray(response.results)) {
    for (const value of response.results) {
      const result = asRecord(value);
      if (!result || typeof result.url !== "string" || !result.url) continue;
      const title = typeof result.title === "string" && result.title ? result.title : result.url;
      const snippet = typeof result.content === "string" ? result.content : undefined;
      const publishedDate = typeof result.published_date === "string" ? result.published_date : undefined;
      sources.push({
        title,
        url: result.url,
        snippet,
        publishedDate,
        ageSeconds: dateToAgeSeconds(publishedDate),
      });
    }
  }
  const answer = typeof response.answer === "string" ? response.answer.trim() || undefined : undefined;
  return {
    provider: "tavily",
    answer,
    sources: sources.slice(0, numResults),
    requestId: typeof response.request_id === "string" ? response.request_id : undefined,
    authMode: "api_key",
  };
}

function hasRenderableResponse(response: SearchResponse): boolean {
  return !!response.answer?.trim() || response.sources.length > 0;
}

/** 执行 Tavily web 搜索；时间过滤常见零命中，失败后去过滤重试一次。 */
export async function searchTavily(params: SearchParams, env: NodeJS.ProcessEnv = process.env): Promise<SearchResponse> {
  const apiKey = resolveEngineApiKey("tavily", env);
  if (!apiKey) {
    throw new SearchProviderError("tavily", "Tavily credentials not found. Set TAVILY_API_KEY.", 401);
  }
  const parsed = params.parsedQuery ?? parseSearchQuery(params.query);
  const tavilyParams: TavilySearchParamsShape & { signal?: AbortSignal; timeoutMs?: number; fetch?: typeof fetch } = {
    query: params.query,
    num_results: params.numSearchResults ?? params.limit,
    recency: params.recency,
    signal: params.signal,
    timeoutMs: params.timeoutMs,
    fetch: params.fetch,
  };
  if (parsed.hasDirectives) {
    // Tavily 偏好干净自然文本；只重发引号短语与 - 排除。
    tavilyParams.query = formatQuery(parsed, { phrases: true, negation: true });
    const include = siteHosts(parsed.sites);
    const exclude = siteHosts(parsed.excludedSites);
    if (include.length > 0) tavilyParams.include_domains = include;
    if (exclude.length > 0) tavilyParams.exclude_domains = exclude;
    if (parsed.after) tavilyParams.start_date = parsed.after;
    if (parsed.before) tavilyParams.end_date = parsed.before;
  }

  const numResults = clampNumResults(tavilyParams.num_results, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
  const response = toSearchResponse(await callTavilySearch(apiKey, tavilyParams), numResults);
  const hasTimeFilter = Boolean(tavilyParams.recency || tavilyParams.start_date || tavilyParams.end_date);
  if (!hasTimeFilter || hasRenderableResponse(response)) {
    return response;
  }
  // 时间过滤常见零命中：去掉过滤重试一次。
  return toSearchResponse(
    await callTavilySearch(apiKey, { ...tavilyParams, recency: undefined, start_date: undefined, end_date: undefined }),
    numResults,
  );
}

/** Tavily 搜索引擎（TAVILY_API_KEY）。 */
export class TavilyProvider extends SearchProvider {
  readonly id = "tavily" as const;
  readonly label = "Tavily";

  isAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
    return !!resolveEngineApiKey("tavily", env);
  }

  search(params: SearchParams): Promise<SearchResponse> {
    return searchTavily(params);
  }
}
