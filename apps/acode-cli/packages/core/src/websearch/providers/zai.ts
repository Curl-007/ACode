// Ported from oh-my-pi (MIT) — packages/coding-agent/src/web/search/providers/zai.ts
// Copyright (c) 2025 Mario Zechner & Stencil Labs
// Z.AI webSearchPrime：远程 MCP 服务器（JSON-RPC over HTTP）。
// 凭据：ZAI_API_KEY（env）。omp 经 authStorage broker 取钥的部分按 spec §7 改接
// env 通道；adapters 账号设施的只读复用为后续共享桶申请，引擎代码届时仅需替换
// resolveEngineApiKey 的实现注入，不再改动。

import type { SearchResponse, SearchSource } from "../types.js";
import { SearchProviderError } from "../types.js";
import { markEngineModuleLoaded } from "../loaded-engines.js";
import { parseSearchQuery, type QuerySyntax } from "../query-parse.js";
import { formatQuery } from "../query-format.js";
import { clampNumResults, classifyProviderHttpError, dateToAgeSeconds, withHardTimeout } from "../provider-utils.js";
import { resolveEngineApiKey, envKeyNameFor } from "../credentials.js";
import type { SearchParams } from "./base.js";
import { SearchProvider } from "./base.js";

markEngineModuleLoaded("zai");

const ZAI_MCP_URL = "https://api.z.ai/api/mcp/web_search_prime/mcp";
const ZAI_TOOL_NAME = "web_search_prime";
const DEFAULT_NUM_RESULTS = 10;

/**
 * webSearchPrime 无原生过滤参数（search_domain_filter/recency_filter 属于
 * search_pro_jina 引擎，非 search-prime），但 Bing 系后端解析常见内联算子。
 * 日期与语言交给中央宽松后置过滤。
 */
const ZAI_QUERY_SYNTAX: QuerySyntax = {
  phrases: true,
  negation: true,
  site: true,
  inTitle: true,
  inUrl: true,
  filetype: true,
};

interface ZaiSearchResult {
  title?: string;
  content?: string;
  link?: string;
  url?: string;
  publish_date?: string;
  publishedDate?: string;
}

interface ZaiWebSearchResponse {
  search_result?: ZaiSearchResult[];
  results?: ZaiSearchResult[];
}

interface JsonRpcPayload {
  result?: unknown;
  error?: { code?: number; message?: string };
}

function unwrapMcpResult(result: unknown): unknown {
  if (result && typeof result === "object" && "content" in (result as Record<string, unknown>)) {
    const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
    const text = Array.isArray(content)
      ? content
          .filter(item => item?.type === "text" && typeof item.text === "string")
          .map(item => item.text)
          .join("\n")
      : undefined;
    const structured = (result as { structuredContent?: unknown }).structuredContent;
    if (structured !== undefined) return structured;
    if (text) {
      try {
        return JSON.parse(text) as unknown;
      } catch {
        return text;
      }
    }
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeResponse(payload: unknown): ZaiWebSearchResponse {
  const unwrapped = unwrapMcpResult(payload);
  if (isRecord(unwrapped) && (Array.isArray(unwrapped.search_result) || Array.isArray(unwrapped.results))) {
    return unwrapped as ZaiWebSearchResponse;
  }
  if (typeof unwrapped === "string") {
    // 无结构化负载时把文本整体当单条结果的摘录，避免丢弃全部信号。
    return { search_result: [{ content: unwrapped }] };
  }
  return {};
}

async function callZaiMcp(apiKey: string, query: string, params: SearchParams): Promise<ZaiWebSearchResponse> {
  const response = await (params.fetch ?? fetch)(ZAI_MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: ZAI_TOOL_NAME,
        arguments: { query },
      },
    }),
    signal: withHardTimeout(params.signal, params.timeoutMs),
  });

  if (!response.ok) {
    const errorText = await response.text();
    const classified = classifyProviderHttpError("zai", response.status, errorText);
    if (classified) throw classified;
    throw new SearchProviderError("zai", `Z.AI web search error (${response.status}): ${errorText.slice(0, 500)}`, response.status);
  }

  // 端点可能回答 JSON-RPC 裸 JSON 或 SSE 帧；两种都按「首个 data: 行或整体 JSON」解析。
  const raw = await response.text();
  const sseDataLine = /^data:\s*(.+)$/m.exec(raw);
  const jsonText = sseDataLine ? sseDataLine[1] : raw;
  let payload: JsonRpcPayload;
  try {
    payload = JSON.parse(jsonText) as JsonRpcPayload;
  } catch {
    throw new SearchProviderError("zai", "Z.AI web search returned invalid JSON-RPC payload", 500);
  }
  if (payload.error) {
    throw new SearchProviderError("zai", `Z.AI web search RPC error: ${payload.error.message ?? "unknown"}`);
  }
  return normalizeResponse(payload.result);
}

/** 执行 Z.AI webSearchPrime 搜索。 */
export async function searchZai(params: SearchParams, env: NodeJS.ProcessEnv = process.env): Promise<SearchResponse> {
  const apiKey = resolveEngineApiKey("zai", env);
  if (!apiKey) {
    throw new SearchProviderError("zai", `Z.AI credentials not found. Set ${envKeyNameFor("zai")}.`, 401);
  }
  const parsed = params.parsedQuery ?? parseSearchQuery(params.query);
  const query = parsed.hasDirectives ? formatQuery(parsed, ZAI_QUERY_SYNTAX) : params.query;
  const data = await callZaiMcp(apiKey, query, params);

  const sources: SearchSource[] = [];
  const seen = new Set<string>();
  for (const result of data.search_result ?? data.results ?? []) {
    const url = result.link ?? result.url;
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const publishedDate = result.publishedDate ?? result.publish_date ?? undefined;
    sources.push({
      title: result.title ?? url,
      url,
      snippet: result.content?.trim() || undefined,
      publishedDate,
      ageSeconds: dateToAgeSeconds(publishedDate),
    });
  }

  return {
    provider: "zai",
    sources: sources.slice(0, clampNumResults(params.numSearchResults ?? params.limit, DEFAULT_NUM_RESULTS, DEFAULT_NUM_RESULTS)),
    authMode: "api_key",
  };
}

/** Z.AI 搜索引擎（ZAI_API_KEY）。 */
export class ZaiProvider extends SearchProvider {
  readonly id = "zai" as const;
  readonly label = "Z.AI";

  isAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
    return !!resolveEngineApiKey("zai", env);
  }

  search(params: SearchParams): Promise<SearchResponse> {
    return searchZai(params);
  }
}
