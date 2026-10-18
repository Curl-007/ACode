// Ported from oh-my-pi (MIT) — packages/coding-agent/src/web/search/providers/searxng.ts
// Copyright (c) 2025 Mario Zechner & Stencil Labs
// 调用 SearXNG 实例的 JSON 搜索 API。配置（ACode 侧仅 env，不写凭据存储）：
//   SEARXNG_ENDPOINT — 实例基址（如 https://searx.example.org），必需
//   SEARXNG_TOKEN    — 可选 bearer token
// omp 的 settings 注册表/Basic 认证/引擎快捷名解析降解掉：最小可用面。
// 查询里的 bang 语法：`!ddg foo` 原样透传（实例侧解析）；外部 bang（!!g）剥除，
// 因为 SearXNG 对 JSON 请求也会用 HTTP 重定向回答它们，破坏响应解析。
// 参考: https://docs.searxng.org/dev/search_api.html

import type { SearchResponse, SearchSource } from "../types.js";
import { SearchProviderError } from "../types.js";
import { markEngineModuleLoaded } from "../loaded-engines.js";
import { parseSearchQuery, type StructuredQuery } from "../query-parse.js";
import { formatScraperQuery } from "../query-format.js";
import {
  clampNumResults,
  classifyProviderHttpError,
  dateToAgeSeconds,
  readLimitedText,
  withHardTimeout,
  MAX_ERROR_BYTES,
} from "../provider-utils.js";
import { resolveSearxngEndpoint, resolveSearxngToken } from "../credentials.js";
import type { SearchParams } from "./base.js";
import { SearchProvider } from "./base.js";

markEngineModuleLoaded("searxng");

const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 20;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/** recency → SearXNG time_range；只支持 day/month/year，week 映射到 month。 */
const RECENCY_MAP: Record<"day" | "week" | "month" | "year", string> = {
  day: "day",
  week: "month",
  month: "month",
  year: "year",
};

interface SearXNGResult {
  title?: string;
  url?: string;
  content?: string;
  snippet?: string;
  publishedDate?: string;
  published_date?: string;
}

interface SearXNGResponse {
  query?: string;
  number_of_results?: number;
  results?: SearXNGResult[];
  suggestions?: string[];
  unresponsive_engines?: Array<[string, string]>;
  answers?: unknown[];
}

/** 剥除外部 bang（!!g、裸 !!）：单 bang 引擎/分类选择器保留。 */
function stripExternalBangs(query: string): string {
  return query
    .split(/\s+/)
    .filter(part => !part.startsWith("!!"))
    .join(" ");
}

/** 从新旧两种 answer 形态提取可展示文本（字符串与结构化插件）。 */
function extractAnswerText(answer: unknown): string | undefined {
  if (typeof answer === "string") return answer.trim() || undefined;
  if (!answer || typeof answer !== "object") return undefined;

  const record = answer as Record<string, unknown>;
  if (typeof record.answer === "string") return record.answer.trim() || undefined;
  if (record.current && typeof record.current === "object") {
    const current = record.current as Record<string, unknown>;
    if (typeof current.summary === "string" && current.summary.trim()) return current.summary.trim();
  }
  return undefined;
}

function formatAnswers(answers: unknown[] | undefined): string | undefined {
  const texts: string[] = [];
  for (const answer of answers ?? []) {
    const text = extractAnswerText(answer);
    if (text) texts.push(text);
    if (texts.length === 3) break;
  }
  return texts.length ? texts.join("\n\n") : undefined;
}

async function callSearXNGSearch(
  endpoint: string,
  params: {
    query: string;
    recency?: "day" | "week" | "month" | "year";
    language?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
    fetch?: typeof fetch;
  },
  token: string | undefined,
): Promise<SearXNGResponse> {
  const base = endpoint.replace(/\/+$/, "");
  const url = new URL(`${base}/search`);
  url.searchParams.set("q", params.query);
  url.searchParams.set("format", "json");
  if (params.recency) url.searchParams.set("time_range", RECENCY_MAP[params.recency]);
  if (params.language) url.searchParams.set("language", params.language);

  const headers: Record<string, string> = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await (params.fetch ?? fetch)(url, {
    headers,
    signal: withHardTimeout(params.signal, params.timeoutMs),
  });

  if (!response.ok) {
    const errorText = await readLimitedText(response, "searxng", MAX_ERROR_BYTES, true);
    const classified = classifyProviderHttpError("searxng", response.status, errorText);
    if (classified) throw classified;
    throw new SearchProviderError("searxng", `SearXNG API error (${response.status}): ${errorText}`, response.status);
  }

  const raw = await readLimitedText(response, "searxng", MAX_RESPONSE_BYTES);
  try {
    return JSON.parse(raw) as SearXNGResponse;
  } catch {
    throw new SearchProviderError("searxng", "SearXNG API returned invalid JSON", 500);
  }
}

/** 执行 SearXNG web 搜索。 */
export async function searchSearXNG(
  params: SearchParams,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SearchResponse> {
  const numResults = clampNumResults(params.numSearchResults ?? params.limit, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
  const endpoint = resolveSearxngEndpoint(env);
  if (!endpoint) {
    throw new SearchProviderError("searxng", "SearXNG endpoint not configured. Set SEARXNG_ENDPOINT.", 400);
  }
  const token = resolveSearxngToken(env);

  // SearXNG 把 q 转发给下游引擎，用共享抓取格式化器构建：算子规范化，
  // 抓取不友好的算子（带路径 site:、inurl:）结构性降为普通词元。
  // `lang:` 映射到原生 language 参数（覆盖默认）。
  const parsed: StructuredQuery = params.parsedQuery ?? parseSearchQuery(params.query);
  const query = formatScraperQuery(params.query, parsed);
  const language = parsed.lang;

  const response = await callSearXNGSearch(
    endpoint,
    { ...params, query: stripExternalBangs(query), language },
    token,
  );

  const sources: SearchSource[] = [];
  for (const result of response.results ?? []) {
    if (!result.url) continue;
    const publishedDate = result.publishedDate ?? result.published_date;
    sources.push({
      title: result.title ?? result.url,
      url: result.url,
      snippet: (result.content ?? result.snippet)?.trim() || undefined,
      publishedDate: publishedDate ?? undefined,
      ageSeconds: dateToAgeSeconds(publishedDate),
    });
  }

  const limitedSources = sources.slice(0, numResults);
  if (limitedSources.length === 0 && response.unresponsive_engines?.length) {
    const upstreamFailures = response.unresponsive_engines.map(([engine, reason]) => `${engine}: ${reason}`).join("; ");
    throw new SearchProviderError(
      "searxng",
      `SearXNG returned no usable results; upstream engines failed: ${upstreamFailures}`,
      503,
    );
  }

  return {
    provider: "searxng",
    answer: formatAnswers(response.answers),
    sources: limitedSources,
    relatedQuestions: response.suggestions?.length ? response.suggestions : undefined,
  };
}

/** SearXNG 搜索引擎（实例自配，无需官方 key）。 */
export class SearXNGProvider extends SearchProvider {
  readonly id = "searxng" as const;
  readonly label = "SearXNG";

  isAvailable(): boolean {
    return !!resolveSearxngEndpoint();
  }

  search(params: SearchParams): Promise<SearchResponse> {
    return searchSearXNG(params);
  }
}
