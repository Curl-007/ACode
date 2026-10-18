// Ported from oh-my-pi (MIT) — packages/coding-agent/src/web/search/providers/jina.ts
// Copyright (c) 2025 Mario Zechner & Stencil Labs
// Jina Reader `s.jina.ai`：搜索并返回净化内容。凭据：JINA_API_KEY（env）。

import type { SearchResponse, SearchSource } from "../types.js";
import { SearchProviderError } from "../types.js";
import { markEngineModuleLoaded } from "../loaded-engines.js";
import { parseSearchQuery } from "../query-parse.js";
import { formatQuery } from "../query-format.js";
import { clampNumResults, classifyProviderHttpError, withHardTimeout } from "../provider-utils.js";
import { resolveEngineApiKey } from "../credentials.js";
import type { SearchParams } from "./base.js";
import { SearchProvider } from "./base.js";

markEngineModuleLoaded("jina");

const JINA_SEARCH_URL = "https://s.jina.ai";
const DEFAULT_NUM_RESULTS = 5;
const MAX_NUM_RESULTS = 20;

interface JinaSearchResult {
  title?: string | null;
  url?: string | null;
  description?: string | null;
  content?: string | null;
}

interface JinaSearchEnvelope {
  code?: unknown;
  data?: unknown;
}

async function callJinaSearch(
  apiKey: string,
  query: string,
  numResults: number,
  site: string | undefined,
  signal: AbortSignal | undefined,
  fetchImpl: typeof fetch,
  timeoutMs?: number,
): Promise<JinaSearchResult[]> {
  const requestUrl = new URL(`${JINA_SEARCH_URL}/${encodeURIComponent(query)}`);
  requestUrl.searchParams.set("count", String(numResults));

  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
  if (site) headers["X-Site"] = site;
  headers["X-Respond-With"] = "no-content";
  headers["X-Retain-Images"] = "none";
  const response = await fetchImpl(requestUrl, {
    headers,
    signal: withHardTimeout(signal, timeoutMs),
  });

  if (!response.ok) {
    const errorText = await response.text();
    const classified = classifyProviderHttpError("jina", response.status, errorText);
    if (classified) throw classified;
    throw new SearchProviderError("jina", `Jina API error (${response.status}): ${errorText}`, response.status);
  }

  const payload = (await response.json()) as JinaSearchEnvelope | JinaSearchResult[] | null;
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") {
    throw new SearchProviderError("jina", "Jina API returned invalid response: expected an object or array");
  }
  if (typeof payload.code === "number" && payload.code !== 200) {
    throw new SearchProviderError("jina", `Jina API response reported failure (${payload.code})`, payload.code);
  }
  if (!Array.isArray(payload.data)) {
    throw new SearchProviderError("jina", "Jina API returned invalid response: expected data array");
  }
  return payload.data as JinaSearchResult[];
}

/** 执行 Jina web 搜索。 */
export async function searchJina(params: SearchParams, env: NodeJS.ProcessEnv = process.env): Promise<SearchResponse> {
  const apiKey = resolveEngineApiKey("jina", env);
  if (!apiKey) {
    throw new SearchProviderError("jina", "Jina credentials not found. Set JINA_API_KEY.", 401);
  }
  const numResults = clampNumResults(params.numSearchResults ?? params.limit, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
  const parsed = params.parsedQuery ?? parseSearchQuery(params.query);
  let query = params.query;
  let site: string | undefined;
  if (parsed.hasDirectives) {
    // X-Site 头只收单个域；恰有一个包含域时发到头里并从查询剥掉 site: 词元。
    // 多域保持内联（Bing 系后端可解析）。
    if (parsed.sites.length === 1) site = parsed.sites[0]?.split("/")[0];
    query = formatQuery(parsed, {
      phrases: true,
      negation: true,
      site: !site,
      inTitle: true,
      inUrl: true,
      filetype: true,
    });
  }

  const response = await callJinaSearch(
    apiKey,
    query,
    numResults,
    site,
    params.signal,
    params.fetch ?? fetch,
    params.timeoutMs,
  );
  const sources: SearchSource[] = [];
  for (const result of response) {
    if (!result?.url) continue;
    sources.push({
      title: result.title ?? result.url,
      url: result.url,
      snippet: result.description?.trim() || result.content?.trim() || undefined,
    });
  }

  return {
    provider: "jina",
    sources: sources.slice(0, numResults),
  };
}

/** Jina Reader 搜索引擎（JINA_API_KEY）。 */
export class JinaProvider extends SearchProvider {
  readonly id = "jina" as const;
  readonly label = "Jina";

  isAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
    return !!resolveEngineApiKey("jina", env);
  }

  search(params: SearchParams): Promise<SearchResponse> {
    return searchJina(params);
  }
}
