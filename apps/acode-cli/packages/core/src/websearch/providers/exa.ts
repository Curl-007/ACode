// Ported from oh-my-pi (MIT) — packages/coding-agent/src/web/search/providers/exa.ts
// Copyright (c) 2025 Mario Zechner & Stencil Labs
// Exa 神经搜索 REST API（POST https://api.exa.ai/search）。omp 的 MCP 变体与
// settings 节流降解为纯 REST + env 级可调节流；凭据：EXA_API_KEY（env）。

import type { SearchResponse, SearchSource } from "../types.js";
import { SearchProviderError } from "../types.js";
import { markEngineModuleLoaded } from "../loaded-engines.js";
import { parseSearchQuery, type StructuredQuery } from "../query-parse.js";
import { formatQuery } from "../query-format.js";
import { clampNumResults, classifyProviderHttpError, dateToAgeSeconds, siteHosts, withHardTimeout } from "../provider-utils.js";
import { resolveEngineApiKey } from "../credentials.js";
import type { SearchParams } from "./base.js";
import { SearchProvider } from "./base.js";

markEngineModuleLoaded("exa");

const EXA_API_URL = "https://api.exa.ai/search";
const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 20;
/** 默认请求间隔：Exa 对密集突发限流；env 可调（毫秒）。 */
const DEFAULT_EXA_SEARCH_DELAY_MS = 0;

let nextExaSearchRequestAt = 0;
let exaSearchThrottle = Promise.resolve();

function sleepMs(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error("aborted"));
      },
      { once: true },
    );
  });
}

async function waitForExaSearchSlot(signal: AbortSignal | undefined, delayMs: number): Promise<void> {
  if (delayMs <= 0) return;
  const prior = exaSearchThrottle.catch(() => {});
  const queued = prior.then(async () => {
    const waitMs = Math.max(0, nextExaSearchRequestAt - Date.now());
    if (waitMs > 0) await sleepMs(waitMs, signal);
    nextExaSearchRequestAt = Date.now() + delayMs;
  });
  exaSearchThrottle = queued.catch(() => {});
  await queued;
}

/** 重置 Exa 节流状态（隔离测试用）。 */
export function resetExaSearchThrottleForTest(): void {
  nextExaSearchRequestAt = 0;
  exaSearchThrottle = Promise.resolve();
}

interface ExaSearchResult {
  title?: string | null;
  url?: string | null;
  author?: string | null;
  publishedDate?: string | null;
  summary?: string | null;
  text?: string | null;
}

interface ExaSearchResponse {
  requestId?: string;
  results?: ExaSearchResult[];
}

/** 供测试导出：构建 /search 请求体。 */
export function buildExaRequestBody(params: {
  query: string;
  num_results?: number;
  include_domains?: string[];
  exclude_domains?: string[];
  start_published_date?: string;
  end_published_date?: string;
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    query: params.query,
    numResults: params.num_results ?? 10,
    type: "auto",
    contents: { summary: true },
  };
  if (params.include_domains?.length) body.includeDomains = params.include_domains;
  if (params.exclude_domains?.length) body.excludeDomains = params.exclude_domains;
  if (params.start_published_date) body.startPublishedDate = params.start_published_date;
  if (params.end_published_date) body.endPublishedDate = params.end_published_date;
  return body;
}

async function callExaSearch(apiKey: string, body: Record<string, unknown>, params: SearchParams, delayMs: number): Promise<ExaSearchResponse> {
  await waitForExaSearchSlot(params.signal, delayMs);
  const response = await (params.fetch ?? fetch)(EXA_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify(body),
    signal: withHardTimeout(params.signal, params.timeoutMs),
  });

  if (!response.ok) {
    const errorText = await response.text();
    const classified = classifyProviderHttpError("exa", response.status, errorText);
    if (classified) throw classified;
    throw new SearchProviderError("exa", `Exa API error (${response.status}): ${errorText.slice(0, 500)}`, response.status);
  }
  return (await response.json()) as ExaSearchResponse;
}

/** 摘要合成答案（前 3 条），与 omp synthesizeAnswer 一致。 */
function synthesizeAnswer(results: ExaSearchResult[]): string | undefined {
  const parts: string[] = [];
  for (const r of results) {
    if (parts.length >= 3) break;
    const summary = r.summary?.trim();
    if (!summary) continue;
    const title = r.title?.trim() || r.url || "Untitled";
    parts.push(`**${title}**: ${summary}`);
  }
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

/** 执行 Exa web 搜索。 */
export async function searchExa(params: SearchParams, env: NodeJS.ProcessEnv = process.env): Promise<SearchResponse> {
  const apiKey = resolveEngineApiKey("exa", env);
  if (!apiKey) {
    throw new SearchProviderError("exa", "Exa credentials not found. Set EXA_API_KEY.", 401);
  }
  const numResults = clampNumResults(params.numSearchResults ?? params.limit, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
  const delayMs = Number.parseInt(env.EXA_SEARCH_DELAY_MS ?? "", 10) || DEFAULT_EXA_SEARCH_DELAY_MS;

  const parsed: StructuredQuery = params.parsedQuery ?? parseSearchQuery(params.query);
  let query = params.query;
  let includeDomains: string[] | undefined;
  let excludeDomains: string[] | undefined;
  let startPublishedDate: string | undefined;
  let endPublishedDate: string | undefined;
  if (parsed.hasDirectives) {
    // Exa 偏好自然语言；域/日期映射 API 参数，词元只保留短语与 - 排除。
    query = formatQuery(parsed, { phrases: true, negation: true });
    const include = siteHosts(parsed.sites);
    const exclude = siteHosts(parsed.excludedSites);
    if (include.length > 0) includeDomains = include;
    if (exclude.length > 0) excludeDomains = exclude;
    if (parsed.after) startPublishedDate = parsed.after;
    if (parsed.before) endPublishedDate = parsed.before;
  }

  const body = buildExaRequestBody({
    query,
    num_results: numResults,
    include_domains: includeDomains,
    exclude_domains: excludeDomains,
    start_published_date: startPublishedDate,
    end_published_date: endPublishedDate,
  });
  const data = await callExaSearch(apiKey, body, params, delayMs);

  const sources: SearchSource[] = [];
  for (const result of data.results ?? []) {
    const url = result.url;
    if (!url) continue;
    const publishedDate = result.publishedDate ?? undefined;
    sources.push({
      title: result.title ?? url,
      url,
      snippet: result.summary?.trim() || result.text?.slice(0, 500) || undefined,
      publishedDate,
      ageSeconds: dateToAgeSeconds(publishedDate),
      author: result.author ?? undefined,
    });
  }

  return {
    provider: "exa",
    answer: synthesizeAnswer(data.results ?? []),
    sources: sources.slice(0, numResults),
    requestId: data.requestId,
    authMode: "api_key",
  };
}

/** Exa 搜索引擎（EXA_API_KEY）。 */
export class ExaProvider extends SearchProvider {
  readonly id = "exa" as const;
  readonly label = "Exa";

  isAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
    return !!resolveEngineApiKey("exa", env);
  }

  search(params: SearchParams): Promise<SearchResponse> {
    return searchExa(params);
  }
}
