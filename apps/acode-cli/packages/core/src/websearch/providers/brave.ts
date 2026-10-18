// Ported from oh-my-pi (MIT) — packages/coding-agent/src/web/search/providers/brave.ts
// Copyright (c) 2025 Mario Zechner & Stencil Labs
// Brave web search REST API。凭据：BRAVE_API_KEY（env 通道，omp 的 authStorage
// resolver 降解为 env）。

import type { SearchResponse, SearchSource } from "../types.js";
import { SearchProviderError } from "../types.js";
import { markEngineModuleLoaded } from "../loaded-engines.js";
import type { QuerySyntax, StructuredQuery } from "../query-parse.js";
import { parseSearchQuery } from "../query-parse.js";
import { formatQuery } from "../query-format.js";
import { clampNumResults, classifyProviderHttpError, dateToAgeSeconds, normalizeSearchText, readLimitedText, withHardTimeout, MAX_ERROR_BYTES } from "../provider-utils.js";
import { resolveEngineApiKey, envKeyNameFor } from "../credentials.js";
import type { SearchParams } from "./base.js";
import { SearchProvider } from "./base.js";

markEngineModuleLoaded("brave");

const BRAVE_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search";
const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 20;
const MAX_QUERY_CHARACTERS = 500;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

const RECENCY_MAP: Record<"day" | "week" | "month" | "year", "pd" | "pw" | "pm" | "py"> = {
  day: "pd",
  week: "pw",
  month: "pm",
  year: "py",
};

/** Brave 内联解析经典算子（site:、引号、-、OR…）；日期界映射原生 freshness 参数。 */
const BRAVE_QUERY_SYNTAX: QuerySyntax = {
  phrases: true,
  negation: true,
  or: true,
  site: true,
  inUrl: true,
  inTitle: true,
  inText: true,
  filetype: true,
  dateRange: false,
};

/** freshness：显式 after:/before: 优先于 recency，渲染为绝对区间 `YYYY-MM-DDtoYYYY-MM-DD`。 */
function braveFreshness(parsed: StructuredQuery, recency?: keyof typeof RECENCY_MAP): string | undefined {
  if (parsed.after || parsed.before) {
    const start = parsed.after ?? "1970-01-01";
    const end = parsed.before ?? new Date().toISOString().slice(0, 10);
    return `${start}to${end}`;
  }
  return recency ? RECENCY_MAP[recency] : undefined;
}

interface BraveSearchResponse {
  web?: { results?: unknown[] };
}

function normalizeUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2048) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function buildSnippet(result: Record<string, unknown>): string | undefined {
  const snippets = new Set<string>();
  const description = normalizeSearchText(result.description);
  if (description) snippets.add(description);
  const extras = result.extra_snippets;
  if (Array.isArray(extras)) {
    for (const value of extras) {
      const snippet = normalizeSearchText(value);
      if (snippet) snippets.add(snippet);
    }
  }
  const combined = [...snippets].join("\n");
  return combined ? (combined.length <= 8_000 ? combined : `${combined.slice(0, 7_999)}…`) : undefined;
}

async function callBraveSearch(apiKey: string, params: SearchParams, parsed: StructuredQuery): Promise<{ response: BraveSearchResponse; requestId?: string }> {
  const numResults = Math.floor(clampNumResults(params.numSearchResults ?? params.limit, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS));
  const query = parsed.hasDirectives ? formatQuery(parsed, BRAVE_QUERY_SYNTAX) : params.query;
  if (query.length > MAX_QUERY_CHARACTERS) {
    throw new SearchProviderError("brave", `Brave search queries cannot exceed ${MAX_QUERY_CHARACTERS} characters`, 400);
  }
  const url = new URL(BRAVE_SEARCH_URL);
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(numResults));
  url.searchParams.set("extra_snippets", "true");
  url.searchParams.set("text_decorations", "false");
  url.searchParams.set("safesearch", "moderate");
  const freshness = braveFreshness(parsed, params.recency);
  if (freshness) url.searchParams.set("freshness", freshness);

  const response = await (params.fetch ?? fetch)(url, {
    headers: {
      Accept: "application/json",
      "X-Subscription-Token": apiKey,
    },
    signal: withHardTimeout(params.signal, params.timeoutMs),
  });

  if (!response.ok) {
    const errorText = await readLimitedText(response, "brave", MAX_ERROR_BYTES, true);
    const classified = classifyProviderHttpError("brave", response.status, errorText);
    if (classified) throw classified;
    throw new SearchProviderError("brave", `Brave API error (${response.status}): ${errorText}`, response.status);
  }

  const raw = await readLimitedText(response, "brave", MAX_RESPONSE_BYTES);
  let data: BraveSearchResponse;
  try {
    data = JSON.parse(raw) as BraveSearchResponse;
  } catch {
    throw new SearchProviderError("brave", "Brave API returned invalid JSON", 500);
  }
  const requestId = response.headers.get("x-request-id") ?? response.headers.get("request-id") ?? undefined;
  return { response: data, requestId };
}

/** 执行 Brave web 搜索。 */
export async function searchBrave(params: SearchParams, env: NodeJS.ProcessEnv = process.env): Promise<SearchResponse> {
  const apiKey = resolveEngineApiKey("brave", env);
  if (!apiKey) {
    throw new SearchProviderError("brave", `Brave credentials not found. Set ${envKeyNameFor("brave")}.`, 401);
  }
  const numResults = Math.floor(clampNumResults(params.numSearchResults ?? params.limit, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS));
  const parsed = params.parsedQuery ?? parseSearchQuery(params.query);
  const { response, requestId } = await callBraveSearch(apiKey, params, parsed);
  const sources: SearchSource[] = [];

  for (const result of response.web?.results ?? []) {
    if (typeof result !== "object" || result === null) continue;
    const record = result as Record<string, unknown>;
    const url = normalizeUrl(record.url);
    if (!url) continue;
    const publishedDate = normalizeSearchText(record.age);
    sources.push({
      title: normalizeSearchText(record.title) ?? url,
      url,
      snippet: buildSnippet(record),
      publishedDate,
      ageSeconds: dateToAgeSeconds(publishedDate),
    });
  }

  return {
    provider: "brave",
    sources: sources.slice(0, numResults),
    requestId,
    authMode: "api_key",
  };
}

/** Brave 搜索引擎（BRAVE_API_KEY）。 */
export class BraveProvider extends SearchProvider {
  readonly id = "brave" as const;
  readonly label = "Brave";

  isAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
    return !!resolveEngineApiKey("brave", env);
  }

  search(params: SearchParams): Promise<SearchResponse> {
    return searchBrave(params);
  }
}
