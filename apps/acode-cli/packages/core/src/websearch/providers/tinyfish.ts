// Ported from oh-my-pi (MIT) — packages/coding-agent/src/web/search/providers/tinyfish.ts
// Copyright (c) 2025 Mario Zechner & Stencil Labs
// TinyFish SERP API。凭据：TINYFISH_API_KEY（env）。

import type { SearchResponse, SearchSource } from "../types.js";
import { SearchProviderError } from "../types.js";
import { markEngineModuleLoaded } from "../loaded-engines.js";
import { parseSearchQuery, type QuerySyntax } from "../query-parse.js";
import { formatQuery } from "../query-format.js";
import { clampNumResults, classifyProviderHttpError, siteHosts, withHardTimeout } from "../provider-utils.js";
import { resolveEngineApiKey } from "../credentials.js";
import type { SearchParams } from "./base.js";
import { SearchProvider } from "./base.js";

markEngineModuleLoaded("tinyfish");

const TINYFISH_SEARCH_URL = "https://api.search.tinyfish.ai";
const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 20;

/** TinyFish 是 SERP 系：常见 Google 风格算子透传。 */
const TINYFISH_QUERY_SYNTAX: QuerySyntax = { phrases: true, negation: true, filetype: true };

const RECENCY_MINUTES: Record<NonNullable<SearchParams["recency"]>, number> = {
  day: 1440,
  week: 10080,
  month: 43200,
  year: 525600,
};

interface TinyFishSearchResponse {
  results?: Array<{ title?: string | null; url?: string | null; snippet?: string | null; site_name?: string | null }> | null;
}

async function callTinyFishSearch(
  apiKey: string,
  url: string,
  signal: AbortSignal | undefined,
  fetchImpl: typeof fetch,
  timeoutMs?: number,
): Promise<TinyFishSearchResponse> {
  const response = await fetchImpl(url, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    signal: withHardTimeout(signal, timeoutMs),
  });
  if (!response.ok) {
    const errorText = await response.text();
    const classified = classifyProviderHttpError("tinyfish", response.status, errorText);
    if (classified) throw classified;
    throw new SearchProviderError("tinyfish", `TinyFish API error (${response.status}): ${errorText}`, response.status);
  }
  return (await response.json()) as TinyFishSearchResponse;
}

/** 执行 TinyFish web 搜索。 */
export async function searchTinyFish(params: SearchParams, env: NodeJS.ProcessEnv = process.env): Promise<SearchResponse> {
  const apiKey = resolveEngineApiKey("tinyfish", env);
  if (!apiKey) {
    throw new SearchProviderError("tinyfish", "TinyFish credentials not found. Set TINYFISH_API_KEY.", 401);
  }
  const numResults = clampNumResults(params.numSearchResults ?? params.limit, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
  const parsed = params.parsedQuery ?? parseSearchQuery(params.query);
  const query = parsed.hasDirectives ? formatQuery(parsed, TINYFISH_QUERY_SYNTAX) : params.query;

  const url = new URL(TINYFISH_SEARCH_URL);
  url.searchParams.set("query", query);
  if (params.recency) url.searchParams.set("recency_minutes", String(RECENCY_MINUTES[params.recency]));
  const include = siteHosts(parsed.sites);
  const exclude = siteHosts(parsed.excludedSites);
  if (include.length) url.searchParams.set("include_domains", include.join(","));
  if (exclude.length) url.searchParams.set("exclude_domains", exclude.join(","));

  const data = await callTinyFishSearch(apiKey, url.href, params.signal, params.fetch ?? fetch, params.timeoutMs);
  const sources: SearchSource[] = [];
  for (const result of data.results ?? []) {
    const resultUrl = result.url ?? undefined;
    if (!resultUrl) continue;
    sources.push({
      title: result.title ?? resultUrl,
      url: resultUrl,
      snippet: result.snippet ?? undefined,
      author: result.site_name ?? undefined,
    });
  }

  return {
    provider: "tinyfish",
    sources: sources.slice(0, numResults),
  };
}

/** TinyFish 搜索引擎（TINYFISH_API_KEY）。 */
export class TinyFishProvider extends SearchProvider {
  readonly id = "tinyfish" as const;
  readonly label = "TinyFish";

  isAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
    return !!resolveEngineApiKey("tinyfish", env);
  }

  search(params: SearchParams): Promise<SearchResponse> {
    return searchTinyFish(params);
  }
}
