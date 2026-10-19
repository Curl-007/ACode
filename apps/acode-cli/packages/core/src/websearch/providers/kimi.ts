// Ported from oh-my-pi (MIT) — packages/coding-agent/src/web/search/providers/kimi.ts
// Copyright (c) 2025 Mario Zechner & Stencil Labs
// Kimi Code 搜索 API（会员服务，区别于 Moonshot 开放平台）。
// Endpoint: POST https://api.kimi.com/coding/v1/search
// 凭据：KIMI_SEARCH_API_KEY / MOONSHOT_SEARCH_API_KEY（Kimi Code Console key）；
// MOONSHOT_API_KEY 不适用（对 api.kimi.com 会 401，omp issue #5762 同源结论）。
// omp 的 authStorage `kimi-code` 凭据路径降解为 env 通道。

import type { SearchResponse, SearchSource } from "../types.js";
import { SearchProviderError } from "../types.js";
import { markEngineModuleLoaded } from "../loaded-engines.js";
import { parseSearchQuery, type QuerySyntax } from "../query-parse.js";
import { formatQuery } from "../query-format.js";
import { clampNumResults, classifyProviderHttpError, dateToAgeSeconds, withHardTimeout } from "../provider-utils.js";
import { resolveEngineApiKey } from "../credentials.js";
import type { SearchParams } from "./base.js";
import { SearchProvider } from "./base.js";

markEngineModuleLoaded("kimi");

const KIMI_SEARCH_URL = "https://api.kimi.com/coding/v1/search";
const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 20;
const DEFAULT_TIMEOUT_SECONDS = 30;

/** Kimi Code 搜索是 Bing 系：输出 Bing 解析的算子；日期/语言交给中央过滤。 */
const KIMI_QUERY_SYNTAX: QuerySyntax = {
  phrases: true,
  negation: true,
  site: true,
  inTitle: true,
  inUrl: true,
  filetype: true,
};

interface KimiSearchResult {
  site_name?: string;
  title?: string;
  url?: string;
  snippet?: string;
  content?: string;
  date?: string;
}

interface KimiSearchResponse {
  search_results?: KimiSearchResult[];
}

async function callKimiSearch(
  apiKey: string,
  params: {
    query: string;
    limit: number;
    signal?: AbortSignal;
    timeoutMs?: number;
    fetch?: typeof fetch;
  },
  baseUrl: string,
): Promise<{ response: KimiSearchResponse; requestId?: string }> {
  const response = await (params.fetch ?? fetch)(baseUrl, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      text_query: params.query,
      limit: params.limit,
      enable_page_crawling: false,
      timeout_seconds: DEFAULT_TIMEOUT_SECONDS,
    }),
    signal: withHardTimeout(params.signal, params.timeoutMs),
  });

  if (!response.ok) {
    const errorText = await response.text();
    const classified = classifyProviderHttpError("kimi", response.status, errorText);
    if (classified) throw classified;
    throw new SearchProviderError("kimi", `Kimi search API error (${response.status}): ${errorText}`, response.status);
  }

  const data = (await response.json()) as KimiSearchResponse;
  const requestId = response.headers.get("x-request-id") ?? response.headers.get("x-msh-request-id") ?? undefined;
  return { response: data, requestId };
}

/** 执行 Kimi Code web 搜索。 */
export async function searchKimi(params: SearchParams, env: NodeJS.ProcessEnv = process.env): Promise<SearchResponse> {
  const apiKey = resolveEngineApiKey("kimi", env);
  if (!apiKey) {
    throw new SearchProviderError(
      "kimi",
      "Kimi search credentials not found. Kimi web search uses the Kimi Code service (api.kimi.com); set KIMI_SEARCH_API_KEY / MOONSHOT_SEARCH_API_KEY to a Kimi Code Console key. A Moonshot Open Platform key (MOONSHOT_API_KEY) is not accepted here.",
      401,
    );
  }

  const baseUrl = env.MOONSHOT_SEARCH_BASE_URL?.trim() || env.KIMI_SEARCH_BASE_URL?.trim() || KIMI_SEARCH_URL;
  const parsed = params.parsedQuery ?? parseSearchQuery(params.query);
  const query = parsed.hasDirectives ? formatQuery(parsed, KIMI_QUERY_SYNTAX) : params.query;
  const limit = clampNumResults(params.numSearchResults ?? params.limit, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
  const { response, requestId } = await callKimiSearch(
    apiKey,
    { query, limit, signal: params.signal, timeoutMs: params.timeoutMs, fetch: params.fetch },
    baseUrl,
  );
  const sources: SearchSource[] = [];

  for (const result of response.search_results ?? []) {
    if (!result.url) continue;
    const publishedDate = result.date?.trim() || undefined;
    const snippet = result.snippet?.trim() || result.content?.trim() || undefined;
    sources.push({
      title: result.title?.trim() || result.url,
      url: result.url,
      snippet,
      publishedDate,
      ageSeconds: dateToAgeSeconds(publishedDate),
      author: result.site_name?.trim() || undefined,
    });
  }

  return {
    provider: "kimi",
    sources: sources.slice(0, limit),
    requestId,
  };
}

/** Kimi 搜索引擎（KIMI_SEARCH_API_KEY / MOONSHOT_SEARCH_API_KEY）。 */
export class KimiProvider extends SearchProvider {
  readonly id = "kimi" as const;
  readonly label = "Kimi";

  isAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
    return !!resolveEngineApiKey("kimi", env);
  }

  search(params: SearchParams): Promise<SearchResponse> {
    return searchKimi(params);
  }
}
