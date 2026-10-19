// Ported from oh-my-pi (MIT) — packages/coding-agent/src/web/search/providers/kagi.ts
//   + 内联了 omp packages/coding-agent/src/kagi.ts 的最小客户端
// Copyright (c) 2025 Mario Zechner & Stencil Labs
// Kagi 搜索 API（GET /search，kagi.com）。凭据：KAGI_API_KEY（env）。

import type { SearchResponse } from "../types.js";
import { SearchProviderError } from "../types.js";
import { markEngineModuleLoaded } from "../loaded-engines.js";
import { parseSearchQuery } from "../query-parse.js";
import { formatQuery, GOOGLE_QUERY_SYNTAX } from "../query-format.js";
import { clampNumResults, classifyProviderHttpError, toSearchSources, withHardTimeout } from "../provider-utils.js";
import { resolveEngineApiKey } from "../credentials.js";
import type { SearchParams } from "./base.js";
import { SearchProvider } from "./base.js";

markEngineModuleLoaded("kagi");

const KAGI_SEARCH_URL = "https://kagi.com/api/v0/search";
const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 40;

interface KagiApiPayload {
  error?: unknown[];
  meta?: { api_balance?: number };
  data?: Array<{ t: string } & Record<string, unknown>>;
}

interface KagiSearchOutput {
  sources: Array<{ title: string; url: string; snippet?: string; publishedDate?: string }>;
  relatedQuestions: string[];
  answer?: string;
  requestId?: string;
}

/** omp KagiApiError 等价：带 HTTP 状态的最小形态。 */
class KagiApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = "KagiApiError";
  }
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** 解析 Kagi 响应：S=结果、A=答案、R=相关问题。 */
function parseKagiPayload(payload: KagiApiPayload, numResults: number): KagiSearchOutput {
  const sources: KagiSearchOutput["sources"] = [];
  const relatedQuestions: string[] = [];
  let answer: string | undefined;
  for (const entry of payload.data ?? []) {
    if (entry.t === "S") {
      const url = text(entry.url);
      if (!url) continue;
      sources.push({
        title: text(entry.title) ?? url,
        url,
        snippet: text(entry.snippet),
        publishedDate: text(entry.date) ?? text(entry.published),
      });
    } else if (entry.t === "A") {
      answer = text(entry.output);
    } else if (entry.t === "R") {
      const question = text(entry.title);
      if (question) relatedQuestions.push(question);
    }
  }
  return {
    sources: sources.slice(0, numResults),
    relatedQuestions,
    answer,
  };
}

async function searchWithKagi(
  query: string,
  opts: { limit: number; recency?: SearchParams["recency"]; signal?: AbortSignal; timeoutMs?: number; fetch?: typeof fetch; apiKey: string },
): Promise<KagiSearchOutput> {
  const url = new URL(KAGI_SEARCH_URL);
  url.searchParams.set("q", query);
  const response = await (opts.fetch ?? fetch)(url, {
    headers: { Authorization: `Bearer ${opts.apiKey}` },
    signal: withHardTimeout(opts.signal, opts.timeoutMs),
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new KagiApiError(`Kagi API error (${response.status}): ${errorText.slice(0, 500)}`, response.status);
  }
  const payload = (await response.json()) as KagiApiPayload;
  const parsed = parseKagiPayload(payload, opts.limit);
  return { ...parsed, requestId: response.headers.get("x-request-id") ?? undefined };
}

/** 执行 Kagi web 搜索。 */
export async function searchKagi(params: SearchParams, env: NodeJS.ProcessEnv = process.env): Promise<SearchResponse> {
  const apiKey = resolveEngineApiKey("kagi", env);
  if (!apiKey) {
    throw new SearchProviderError("kagi", "Kagi credentials not found. Set KAGI_API_KEY.", 401);
  }
  const numResults = clampNumResults(params.numSearchResults ?? params.limit, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
  // Kagi 索引理解经典 Google 算子集：规范化指令后随查询串透传；无指令查询原样。
  const parsed = params.parsedQuery ?? parseSearchQuery(params.query);
  const query = parsed.hasDirectives ? formatQuery(parsed, GOOGLE_QUERY_SYNTAX) : params.query;

  try {
    const result = await searchWithKagi(query, {
      limit: numResults,
      recency: params.recency,
      signal: params.signal,
      timeoutMs: params.timeoutMs,
      fetch: params.fetch,
      apiKey,
    });
    return {
      provider: "kagi",
      sources: toSearchSources(result.sources, numResults),
      relatedQuestions: result.relatedQuestions.length > 0 ? result.relatedQuestions : undefined,
      requestId: result.requestId,
      answer: result.answer,
    };
  } catch (err) {
    if (err instanceof KagiApiError) {
      if (typeof err.statusCode === "number") {
        const classified = classifyProviderHttpError("kagi", err.statusCode, err.message);
        if (classified) throw classified;
      }
      throw new SearchProviderError("kagi", err.message, err.statusCode);
    }
    throw err;
  }
}

/** Kagi 搜索引擎（KAGI_API_KEY）。 */
export class KagiProvider extends SearchProvider {
  readonly id = "kagi" as const;
  readonly label = "Kagi";

  isAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
    return !!resolveEngineApiKey("kagi", env);
  }

  search(params: SearchParams): Promise<SearchResponse> {
    return searchKagi(params);
  }
}
