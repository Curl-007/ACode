// Ported from oh-my-pi (MIT) — packages/coding-agent/src/web/search/providers/ollama.ts
// Copyright (c) 2025 Mario Zechner & Stencil Labs
// Ollama 托管 web search REST API。POST https://ollama.com/api/web_search
// 凭据：OLLAMA_CLOUD_API_KEY（env；omp 的 `ollama-cloud` authStorage 通道降解）。

import type { SearchResponse, SearchSource } from "../types.js";
import { SearchProviderError } from "../types.js";
import { markEngineModuleLoaded } from "../loaded-engines.js";
import { parseSearchQuery } from "../query-parse.js";
import { formatQuery } from "../query-format.js";
import { clampNumResults, classifyProviderHttpError, normalizeSearchText, readLimitedText, withHardTimeout, MAX_ERROR_BYTES } from "../provider-utils.js";
import { resolveEngineApiKey } from "../credentials.js";
import type { SearchParams } from "./base.js";
import { SearchProvider } from "./base.js";

markEngineModuleLoaded("ollama");

const OLLAMA_SEARCH_URL = "https://ollama.com/api/web_search";
const DEFAULT_NUM_RESULTS = 5;
const MAX_NUM_RESULTS = 10;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

interface OllamaSearchResponse {
  results?: Array<{ title?: unknown; url?: unknown; content?: unknown }>;
}

async function callOllamaSearch(
  apiKey: string,
  query: string,
  maxResults: number,
  signal: AbortSignal | undefined,
  fetchImpl: typeof fetch,
  timeoutMs?: number,
): Promise<OllamaSearchResponse> {
  const response = await fetchImpl(OLLAMA_SEARCH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ query, max_results: maxResults }),
    signal: withHardTimeout(signal, timeoutMs),
  });

  if (!response.ok) {
    const errorText = await readLimitedText(response, "ollama", MAX_ERROR_BYTES, true);
    const classified = classifyProviderHttpError("ollama", response.status, errorText);
    if (classified) throw classified;
    throw new SearchProviderError("ollama", `Ollama API error (${response.status}): ${errorText}`, response.status);
  }

  const raw = await readLimitedText(response, "ollama", MAX_RESPONSE_BYTES, false);
  try {
    return JSON.parse(raw) as OllamaSearchResponse;
  } catch {
    throw new SearchProviderError("ollama", "Ollama API returned invalid JSON", 500);
  }
}

function toSources(response: OllamaSearchResponse, numResults: number): SearchSource[] {
  const sources: SearchSource[] = [];
  if (!Array.isArray(response.results)) return sources;
  for (const value of response.results) {
    if (typeof value !== "object" || value === null) continue;
    const result = value as { title?: unknown; url?: unknown; content?: unknown };
    const url = normalizeSearchText(result.url);
    if (!url) continue;
    sources.push({
      title: normalizeSearchText(result.title) ?? url,
      url,
      snippet: normalizeSearchText(result.content),
    });
  }
  return sources.slice(0, numResults);
}

/** 执行 Ollama web 搜索。 */
export async function searchOllama(params: SearchParams, env: NodeJS.ProcessEnv = process.env): Promise<SearchResponse> {
  const apiKey = resolveEngineApiKey("ollama", env);
  if (!apiKey) {
    throw new SearchProviderError("ollama", "Ollama Cloud credentials not found. Set OLLAMA_CLOUD_API_KEY.", 401);
  }

  const numResults = Math.floor(clampNumResults(params.numSearchResults ?? params.limit, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS));
  const parsed = params.parsedQuery ?? parseSearchQuery(params.query);
  const query = parsed.hasDirectives ? formatQuery(parsed, { phrases: true, negation: true, site: true }) : params.query;

  const data = await callOllamaSearch(apiKey, query, numResults, params.signal, params.fetch ?? fetch, params.timeoutMs);

  return {
    provider: "ollama",
    sources: toSources(data, numResults),
    authMode: "api_key",
  };
}

/** Ollama 搜索引擎（OLLAMA_CLOUD_API_KEY）。 */
export class OllamaProvider extends SearchProvider {
  readonly id = "ollama" as const;
  readonly label = "Ollama";

  isAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
    return !!resolveEngineApiKey("ollama", env);
  }

  search(params: SearchParams): Promise<SearchResponse> {
    return searchOllama(params);
  }
}
