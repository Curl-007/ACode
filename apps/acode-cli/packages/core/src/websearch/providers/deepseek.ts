// Ported from oh-my-pi (MIT) — packages/coding-agent/src/web/search/providers/deepseek.ts
// Copyright (c) 2025 Mario Zechner & Stencil Labs
// DeepSeek 搜索 API（自研搜索，标准 DeepSeek API key）。
// Endpoint: POST https://api.deepseek.com/v1/tools/search
// 凭据：DEEPSEEK_API_KEY（标准 env key，ACode 既有 env 纪律）。

import type { SearchResponse, SearchSource } from "../types.js";
import { SearchProviderError } from "../types.js";
import { markEngineModuleLoaded } from "../loaded-engines.js";
import type { StructuredQuery } from "../query-parse.js";
import { parseSearchQuery } from "../query-parse.js";
import { formatQuery } from "../query-format.js";
import { clampNumResults, classifyProviderHttpError, dateToAgeSeconds, normalizeSearchText, readLimitedText, recencyAfterDate, siteHosts, withHardTimeout, MAX_ERROR_BYTES } from "../provider-utils.js";
import { resolveEngineApiKey, envKeyNameFor } from "../credentials.js";
import type { SearchParams } from "./base.js";
import { SearchProvider } from "./base.js";

markEngineModuleLoaded("deepseek");

const DEEPSEEK_SEARCH_URL = "https://api.deepseek.com/v1/tools/search";
const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 50;
/** API 拒绝超过 128 Unicode 字符的查询。 */
const MAX_QUERY_CHARACTERS = 128;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

interface DeepSeekSearchResponse {
  results?: Array<{
    title?: unknown;
    url?: unknown;
    snippet?: unknown;
    summary?: unknown;
    date?: unknown;
  }>;
}

/**
 * DeepSeek 方言重建查询：引号短语、-term、OR 连接的 site: 裸域（路径部分由中央
 * 后置过滤强制）、-site:、lang:（主子标签）、after:/before:。相对 recency 在查询
 * 未带日期界时转成 after:。
 */
function buildDeepSeekQuery(parsed: StructuredQuery, recency: SearchParams["recency"]): string {
  const after = parsed.after ?? (recency ? recencyAfterDate(recency) : undefined);
  if (!parsed.hasDirectives && !after) return parsed.raw.trim();

  // 仅词元：指令在下方按方言追加。raw 置空防指令型查询回落原串。
  const text = formatQuery(
    { ...parsed, raw: "", sites: [], excludedSites: [], after: undefined, before: undefined },
    { phrases: true, negation: true },
  );
  const parts: string[] = [];
  if (text) parts.push(text);
  const sites = siteHosts(parsed.sites);
  if (sites.length) parts.push(sites.map(site => `site:${site}`).join(" OR "));
  parts.push(...siteHosts(parsed.excludedSites).map(site => `-site:${site}`));
  const lang = parsed.lang?.split("-", 1)[0];
  if (lang) parts.push(`lang:${lang}`);
  if (after) parts.push(`after:${after}`);
  if (parsed.before) parts.push(`before:${parsed.before}`);
  return parts.join(" ");
}

function normalizeUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

async function callDeepSeekSearch(apiKey: string, query: string, count: number, params: SearchParams): Promise<DeepSeekSearchResponse> {
  const response = await (params.fetch ?? fetch)(DEEPSEEK_SEARCH_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ query, count }),
    signal: withHardTimeout(params.signal, params.timeoutMs),
  });

  if (!response.ok) {
    const errorText = await readLimitedText(response, "deepseek", MAX_ERROR_BYTES, true);
    const classified = classifyProviderHttpError("deepseek", response.status, errorText);
    if (classified) throw classified;
    throw new SearchProviderError("deepseek", `DeepSeek search API error (${response.status}): ${errorText}`, response.status);
  }

  const raw = await readLimitedText(response, "deepseek", MAX_RESPONSE_BYTES);
  try {
    return JSON.parse(raw) as DeepSeekSearchResponse;
  } catch {
    throw new SearchProviderError("deepseek", "DeepSeek search API returned invalid JSON", 500);
  }
}

/** 执行 DeepSeek web 搜索。 */
export async function searchDeepSeek(params: SearchParams, env: NodeJS.ProcessEnv = process.env): Promise<SearchResponse> {
  const apiKey = resolveEngineApiKey("deepseek", env);
  if (!apiKey) {
    throw new SearchProviderError("deepseek", `DeepSeek credentials not found. Set ${envKeyNameFor("deepseek")}.`, 401);
  }
  const count = Math.floor(clampNumResults(params.numSearchResults ?? params.limit, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS));
  const parsed = params.parsedQuery ?? parseSearchQuery(params.query);
  const query = buildDeepSeekQuery(parsed, params.recency);
  if ([...query].length > MAX_QUERY_CHARACTERS) {
    throw new SearchProviderError("deepseek", `DeepSeek search queries cannot exceed ${MAX_QUERY_CHARACTERS} characters`, 400);
  }

  const data = await callDeepSeekSearch(apiKey, query, count, params);

  const sources: SearchSource[] = [];
  for (const result of Array.isArray(data.results) ? data.results : []) {
    const url = normalizeUrl(result.url);
    if (!url) continue;
    const publishedDate = typeof result.date === "string" && result.date ? result.date : undefined;
    sources.push({
      title: normalizeSearchText(result.title) ?? url,
      url,
      // summary 是面向模型的长摘录；snippet 是短 UI 摘录。
      snippet: normalizeSearchText(result.summary) ?? normalizeSearchText(result.snippet),
      publishedDate,
      ageSeconds: dateToAgeSeconds(publishedDate),
    });
  }

  return {
    provider: "deepseek",
    sources: sources.slice(0, count),
    authMode: "api_key",
  };
}

/** DeepSeek 搜索引擎（DEEPSEEK_API_KEY）。 */
export class DeepSeekProvider extends SearchProvider {
  readonly id = "deepseek" as const;
  readonly label = "DeepSeek";

  isAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
    return !!resolveEngineApiKey("deepseek", env);
  }

  search(params: SearchParams): Promise<SearchResponse> {
    return searchDeepSeek(params);
  }
}
