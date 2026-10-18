// Ported from oh-my-pi (MIT) — packages/coding-agent/src/web/search/providers/parallel.ts
// Copyright (c) 2025 Mario Zechner & Stencil Labs
// Parallel 搜索（REST Search API，beta）。凭据：PARALLEL_API_KEY（env）。
// omp 的 MCP 备用路径与 ../../parallel 客户端模块降解为最小 REST 路径：
// POST https://api.parallel.ai/v1beta/search + source_policy。

import type { SearchResponse, SearchSource } from "../types.js";
import { SearchProviderError } from "../types.js";
import { markEngineModuleLoaded } from "../loaded-engines.js";
import { parseSearchQuery, type StructuredQuery } from "../query-parse.js";
import { formatQuery } from "../query-format.js";
import { clampNumResults, classifyProviderHttpError, normalizeSearchText, recencyAfterDate, siteHosts, toSearchSources, withHardTimeout } from "../provider-utils.js";
import { resolveEngineApiKey, envKeyNameFor } from "../credentials.js";
import type { SearchParams } from "./base.js";
import { SearchProvider } from "./base.js";

markEngineModuleLoaded("parallel");

const PARALLEL_SEARCH_URL = "https://api.parallel.ai/v1beta/search";
const PARALLEL_BETA_HEADER = "search-api-2025-09-17";
const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 40;

/** Parallel 查询是自然语言目标：无域算子，仅短语/-/OR。 */
const PARALLEL_QUERY_SYNTAX = { phrases: true, negation: true, or: true } as const;

interface ParallelSearchResult {
  title?: string;
  url?: string;
  excerpt?: string;
  publish_date?: string;
}

interface ParallelSearchResponse {
  results?: ParallelSearchResult[];
}

/**
 * site:/-site:/after: 与相对 recency 映射到 source_policy。Parallel 文档说明
 * include_domains 设置时 exclude_domains 被忽略，故仅在没有允许清单时发送排除项
 * （中央宽松后置过滤无论如何都会强制执行）。
 */
function toSourcePolicy(parsed: StructuredQuery, recency?: SearchParams["recency"]): Record<string, unknown> | undefined {
  const policy: Record<string, unknown> = {};
  const include = siteHosts(parsed.sites);
  const exclude = siteHosts(parsed.excludedSites);
  if (include.length) policy.include_domains = include;
  else if (exclude.length) policy.exclude_domains = exclude;
  if (parsed.after) policy.after_date = parsed.after;
  else if (recency) policy.after_date = recencyAfterDate(recency);
  return Object.keys(policy).length > 0 ? policy : undefined;
}

async function callParallelSearch(
  apiKey: string,
  body: Record<string, unknown>,
  params: SearchParams,
): Promise<ParallelSearchResponse> {
  const response = await (params.fetch ?? fetch)(PARALLEL_SEARCH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "parallel-beta": PARALLEL_BETA_HEADER,
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal: withHardTimeout(params.signal, params.timeoutMs),
  });

  if (!response.ok) {
    const errorText = await response.text();
    const classified = classifyProviderHttpError("parallel", response.status, errorText);
    if (classified) throw classified;
    throw new SearchProviderError("parallel", `Parallel API error (${response.status}): ${errorText.slice(0, 500)}`, response.status);
  }
  return (await response.json()) as ParallelSearchResponse;
}

/** 执行 Parallel web 搜索。 */
export async function searchParallel(params: SearchParams, env: NodeJS.ProcessEnv = process.env): Promise<SearchResponse> {
  const apiKey = resolveEngineApiKey("parallel", env);
  if (!apiKey) {
    throw new SearchProviderError("parallel", `Parallel credentials not found. Set ${envKeyNameFor("parallel")}.`, 401);
  }
  const numResults = clampNumResults(params.numSearchResults ?? params.limit, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
  const parsed: StructuredQuery = params.parsedQuery ?? parseSearchQuery(params.query);
  const objective = parsed.hasDirectives ? formatQuery(parsed, PARALLEL_QUERY_SYNTAX) : params.query;

  const body: Record<string, unknown> = {
    objective,
    search_queries: [objective],
    max_results: numResults,
  };
  const policy = toSourcePolicy(parsed, params.recency);
  if (policy) body.source_policy = policy;

  const data = await callParallelSearch(apiKey, body, params);
  const sources: SearchSource[] = toSearchSources(
    (data.results ?? []).map(result => ({
      title: normalizeSearchText(result.title) ?? result.url ?? "",
      url: result.url ?? "",
      snippet: normalizeSearchText(result.excerpt),
      publishedDate: normalizeSearchText(result.publish_date),
    })).filter(source => source.url.length > 0),
    numResults,
  );

  return {
    provider: "parallel",
    sources,
    authMode: "api_key",
  };
}

/** Parallel 搜索引擎（PARALLEL_API_KEY）。 */
export class ParallelProvider extends SearchProvider {
  readonly id = "parallel" as const;
  readonly label = "Parallel";

  isAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
    return !!resolveEngineApiKey("parallel", env);
  }

  search(params: SearchParams): Promise<SearchResponse> {
    return searchParallel(params);
  }
}
