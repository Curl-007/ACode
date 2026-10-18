// Ported from oh-my-pi (MIT) — packages/coding-agent/src/web/search/providers/firecrawl.ts
// Copyright (c) 2025 Mario Zechner & Stencil Labs
// Firecrawl 搜索 API（POST /search）。凭据：FIRECRAWL_API_KEY（env）；
// FIRECRAWL_URL 可覆盖实例基址（omp 的 resolveFirecrawlUrl 降解为 env 读取）。

import type { SearchResponse, SearchSource } from "../types.js";
import { SearchProviderError } from "../types.js";
import { markEngineModuleLoaded } from "../loaded-engines.js";
import { parseSearchQuery, type StructuredQuery } from "../query-parse.js";
import { formatQuery, GOOGLE_QUERY_SYNTAX } from "../query-format.js";
import { clampNumResults, classifyProviderHttpError, normalizeSearchText, withHardTimeout } from "../provider-utils.js";
import { resolveEngineApiKey } from "../credentials.js";
import type { SearchParams } from "./base.js";
import { SearchProvider } from "./base.js";

markEngineModuleLoaded("firecrawl");

const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 100;
const FIRECRAWL_DEFAULT_URL = "https://api.firecrawl.dev";

const RECENCY_TBS: Record<NonNullable<SearchParams["recency"]>, string> = {
  day: "qdr:d",
  week: "qdr:w",
  month: "qdr:m",
  year: "qdr:y",
};

interface FirecrawlWebResult {
  title?: string | null;
  url?: string | null;
  description?: string | null;
  snippet?: string | null;
  markdown?: string | null;
}

interface FirecrawlSearchResponse {
  success?: boolean;
  error?: string | null;
  data?: FirecrawlWebResult[] | { web?: FirecrawlWebResult[] | null; news?: FirecrawlWebResult[] | null } | null;
}

function resolveFirecrawlUrl(path: string, env: NodeJS.ProcessEnv): string {
  const base = (env.FIRECRAWL_URL?.trim() || FIRECRAWL_DEFAULT_URL).replace(/\/+$/, "");
  return `${base}${path}`;
}

function buildRequestBody(params: { query: string; num_results?: number; recency?: SearchParams["recency"]; tbs?: string }): Record<string, unknown> {
  const body: Record<string, unknown> = {
    query: params.query,
    limit: clampNumResults(params.num_results, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS),
    sources: [{ type: "web" }],
  };
  const tbs = params.tbs ?? (params.recency ? RECENCY_TBS[params.recency] : undefined);
  if (tbs) body.tbs = tbs;
  return body;
}

async function callFirecrawlSearch(apiKey: string, params: SearchParams & { tbs?: string }, env: NodeJS.ProcessEnv): Promise<FirecrawlSearchResponse> {
  const response = await (params.fetch ?? fetch)(resolveFirecrawlUrl("/search", env), {
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
    const classified = classifyProviderHttpError("firecrawl", response.status, errorText);
    if (classified) throw classified;
    throw new SearchProviderError("firecrawl", `Firecrawl API error (${response.status}): ${errorText}`, response.status);
  }

  const data = (await response.json()) as FirecrawlSearchResponse;
  if (data.success === false) {
    throw new SearchProviderError("firecrawl", data.error?.trim() || "Firecrawl request failed");
  }
  return data;
}

/** ISO `YYYY-MM-DD` → Google `MM/DD/YYYY`（tbs=cdr 自定义日期区间）。 */
function toGoogleDate(iso: string): string {
  const [year, month, day] = iso.split("-");
  return `${month}/${day}/${year}`;
}

/** 抽取 web（及 news）结果列表，兼容 data 数组与 { web, news } 两种形态。 */
function extractResults(data: FirecrawlSearchResponse): FirecrawlWebResult[] {
  if (Array.isArray(data.data)) return data.data;
  if (data.data && typeof data.data === "object") {
    return [...(data.data.web ?? []), ...(data.data.news ?? [])];
  }
  return [];
}

/** 执行 Firecrawl web 搜索。 */
export async function searchFirecrawl(params: SearchParams, env: NodeJS.ProcessEnv = process.env): Promise<SearchResponse> {
  const apiKey = resolveEngineApiKey("firecrawl", env);
  if (!apiKey) {
    throw new SearchProviderError("firecrawl", "Firecrawl credentials not found. Set FIRECRAWL_API_KEY.", 401);
  }
  const parsed: StructuredQuery = params.parsedQuery ?? parseSearchQuery(params.query);
  const numResults = clampNumResults(params.numSearchResults ?? params.limit, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
  // Firecrawl 是 Google 支持的 SERP：完整 Google 方言内联透传。
  const query = parsed.hasDirectives ? formatQuery(parsed, GOOGLE_QUERY_SYNTAX) : params.query;

  // recency 走 Google tbs；显式 after/before 转 tbs=cdr 自定义区间（同样式）。
  let tbs: string | undefined;
  if (params.recency) tbs = RECENCY_TBS[params.recency];
  if (parsed.after || parsed.before) {
    const start = parsed.after ? toGoogleDate(parsed.after) : "01/01/1970";
    const end = parsed.before ? toGoogleDate(parsed.before) : toGoogleDate(new Date().toISOString().slice(0, 10));
    tbs = `cdr:1,cd_min:${start},cd_max:${end}`;
  }

  const data = await callFirecrawlSearch(apiKey, { ...params, query, tbs }, env);

  const sources: SearchSource[] = [];
  for (const result of extractResults(data)) {
    const url = normalizeSearchText(result.url);
    if (!url) continue;
    sources.push({
      title: normalizeSearchText(result.title) ?? url,
      url,
      snippet: normalizeSearchText(result.description) ?? normalizeSearchText(result.snippet) ?? undefined,
    });
  }

  return {
    provider: "firecrawl",
    sources: sources.slice(0, numResults),
    authMode: "api_key",
  };
}

/** Firecrawl 搜索引擎（FIRECRAWL_API_KEY）。 */
export class FirecrawlProvider extends SearchProvider {
  readonly id = "firecrawl" as const;
  readonly label = "Firecrawl";

  isAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
    return !!resolveEngineApiKey("firecrawl", env);
  }

  search(params: SearchParams): Promise<SearchResponse> {
    return searchFirecrawl(params);
  }
}
