// Ported from oh-my-pi (MIT) — packages/coding-agent/src/web/search/providers/synthetic.ts
// Copyright (c) 2025 Mario Zechner & Stencil Labs
// Synthetic 零保留 web 搜索 API（编码 agent 用）。POST https://api.synthetic.new/v2/search
// 凭据：SYNTHETIC_API_KEY（env）。

import type { SearchResponse, SearchSource } from "../types.js";
import { SearchProviderError } from "../types.js";
import { markEngineModuleLoaded } from "../loaded-engines.js";
import { parseSearchQuery } from "../query-parse.js";
import { formatQuery } from "../query-format.js";
import { classifyProviderHttpError, withHardTimeout } from "../provider-utils.js";
import { resolveEngineApiKey } from "../credentials.js";
import type { SearchParams } from "./base.js";
import { SearchProvider } from "./base.js";

markEngineModuleLoaded("synthetic");

const SYNTHETIC_SEARCH_URL = "https://api.synthetic.new/v2/search";

interface SyntheticSearchResponse {
  results?: Array<{ url: string; title: string; text?: string; published?: string }>;
}

async function callSyntheticSearch(
  apiKey: string,
  query: string,
  signal: AbortSignal | undefined,
  fetchImpl: typeof fetch,
  timeoutMs?: number,
): Promise<SyntheticSearchResponse> {
  const response = await fetchImpl(SYNTHETIC_SEARCH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ query }),
    signal: withHardTimeout(signal, timeoutMs),
  });

  if (!response.ok) {
    const errorText = await response.text();
    const classified = classifyProviderHttpError("synthetic", response.status, errorText);
    if (classified) throw classified;
    throw new SearchProviderError("synthetic", `Synthetic API error (${response.status}): ${errorText}`, response.status);
  }

  return (await response.json()) as SyntheticSearchResponse;
}

/** 执行 Synthetic web 搜索。 */
export async function searchSynthetic(params: SearchParams, env: NodeJS.ProcessEnv = process.env): Promise<SearchResponse> {
  const apiKey = resolveEngineApiKey("synthetic", env);
  if (!apiKey) {
    throw new SearchProviderError("synthetic", "Synthetic credentials not found. Set SYNTHETIC_API_KEY.", 401);
  }

  const parsed = params.parsedQuery ?? parseSearchQuery(params.query);
  const query = parsed.hasDirectives ? formatQuery(parsed, { phrases: true, negation: true, site: true }) : params.query;

  const data = await callSyntheticSearch(apiKey, query, params.signal, params.fetch ?? fetch, params.timeoutMs);
  const sources: SearchSource[] = [];
  for (const result of data.results ?? []) {
    if (!result.url) continue;
    sources.push({
      title: result.title ?? result.url,
      url: result.url,
      snippet: result.text ?? undefined,
      publishedDate: result.published ?? undefined,
    });
  }

  const numResults = params.numSearchResults ?? params.limit;
  return {
    provider: "synthetic",
    sources: numResults ? sources.slice(0, numResults) : sources,
  };
}

/** Synthetic 搜索引擎（SYNTHETIC_API_KEY）。 */
export class SyntheticProvider extends SearchProvider {
  readonly id = "synthetic" as const;
  readonly label = "Synthetic";

  isAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
    return !!resolveEngineApiKey("synthetic", env);
  }

  search(params: SearchParams): Promise<SearchResponse> {
    return searchSynthetic(params);
  }
}
