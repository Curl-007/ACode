// Ported from oh-my-pi (MIT) — packages/coding-agent/src/web/search/utils.ts + providers/utils.ts
// Copyright (c) 2025 Mario Zechner & Stencil Labs
// Bun 降解 node:*（无 Bun.sleep/$env）；readBodyCapped 降解为内建 text() + 字节上限检查。

import type { SearchProviderId, SearchSource } from "./types.js";
import { SearchProviderError, getSearchProviderLabel } from "./types.js";

/** ISO 日期串转秒龄；非法输入返回 undefined。 */
export function dateToAgeSeconds(dateStr: string | null | undefined): number | undefined {
  if (!dateStr) return undefined;
  try {
    const date = new Date(dateStr);
    if (Number.isNaN(date.getTime())) return undefined;
    return Math.floor((Date.now() - date.getTime()) / 1000);
  } catch {
    return undefined;
  }
}

/** 结果数夹到 [1, maxVal]；缺失或 NaN 时用 defaultVal。 */
export function clampNumResults(value: number | undefined, defaultVal: number, maxVal: number): number {
  if (!value || Number.isNaN(value)) return defaultVal;
  return Math.min(maxVal, Math.max(1, value));
}

const RECENCY_DAYS: Record<"day" | "week" | "month" | "year", number> = {
  day: 1,
  week: 7,
  month: 30,
  year: 365,
};

/** 相对 recency 窗口的 UTC `YYYY-MM-DD` 下界，供只接受绝对 after 日期的引擎。 */
export function recencyAfterDate(recency: "day" | "week" | "month" | "year"): string {
  return new Date(Date.now() - RECENCY_DAYS[recency] * 86_400_000).toISOString().slice(0, 10);
}

/**
 * 60 秒默认容忍合法的慢 LLM 中介响应，同时为 Windows 上 AbortSignal 失效的场景兜底；
 * 调用方可配置更长上限（分发器封顶 5 分钟）；纯搜索 API 通常远快于此。
 */
export const SEARCH_HARD_TIMEOUT_MS = 60_000;

/**
 * 把调用方 AbortSignal 与硬超时合成，保证出站 fetch 在 ms 内必然落定——即使运行时
 * 失败把取消传播到传输层（omp 记录的 Bun/Windows 停滞问题；node 侧同构防御）。
 */
export function withHardTimeout(signal: AbortSignal | undefined, ms: number = SEARCH_HARD_TIMEOUT_MS): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** 引擎原始来源列表 → 统一 SearchSource，夹到请求数并标注秒龄。 */
export function toSearchSources(
  sources: ReadonlyArray<{
    title: string;
    url: string;
    snippet?: string;
    publishedDate?: string;
  }>,
  numResults: number,
): SearchSource[] {
  return sources.slice(0, numResults).map(source => ({
    title: source.title,
    url: source.url,
    snippet: source.snippet,
    publishedDate: source.publishedDate,
    ageSeconds: dateToAgeSeconds(source.publishedDate),
  }));
}

const CREDIT_BODY_PATTERN = /credits?\s*(?:exhausted|exceeded)|quota|insufficient/i;

/**
 * 引擎间共通的配额/鉴权信号：把额度耗尽与 401/402/403 原始 HTTP 报错映射成
 * 简短的 provider 标注消息，回退链得以干净推进、全败汇总保持可读。
 * 未命中已知信号返回 null，由调用方抛自己的引擎专属错误。
 */
export function classifyProviderHttpError(
  provider: SearchProviderId,
  status: number,
  body: string,
): SearchProviderError | null {
  if (CREDIT_BODY_PATTERN.test(body)) {
    return new SearchProviderError(provider, `${provider}: credits exhausted`, status);
  }
  if (status === 402) {
    return new SearchProviderError(provider, `${provider}: 402 credits exhausted`, status);
  }
  if (status === 401) {
    return new SearchProviderError(provider, `${provider}: 401 unauthorized`, status);
  }
  if (status === 403) {
    return new SearchProviderError(provider, `${provider}: 403 forbidden`, status);
  }
  return null;
}

/** 折叠松散类型字段的空白串；缺失/非串/空白返回 undefined。 */
export function normalizeSearchText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > 0 ? text : undefined;
}

/** `site:` 值的裸域去重集（github.com/anthropics → github.com），供引擎域过滤；路径部分由中央宽松后置过滤强制。 */
export function siteHosts(sites: readonly string[]): string[] {
  const hosts = new Set<string>();
  for (const site of sites) {
    const host = site.split("/", 1)[0];
    if (host) hosts.add(host);
  }
  return [...hosts];
}

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_ERROR_BYTES = 8 * 1024;

/**
 * 读取响应体至字节上限：上限用于正常响应（超限抛错），错误响应截断读取。
 * omp 的 readBodyCapped 流式实现降解为 text() 后长度检查——响应已整体落内存，
 * 上限只保证不把超大响应塞进后续处理。
 */
export async function readLimitedText(
  response: Response,
  provider: SearchProviderId,
  maxBytes: number = MAX_RESPONSE_BYTES,
  truncate = false,
): Promise<string> {
  const body = await response.text();
  if (body.length > maxBytes) {
    if (!truncate) {
      throw new SearchProviderError(
        provider,
        `${getSearchProviderLabel(provider)} API response exceeded ${Math.floor(maxBytes / 1024)} KiB`,
        500,
      );
    }
    return body.slice(0, maxBytes);
  }
  return body;
}

export { MAX_RESPONSE_BYTES, MAX_ERROR_BYTES };

/**
 * 抓取类引擎共用的 HTML 文本解码：剥内联标签、解 HTML 实体、归一空白。
 *omp 各抓取引擎内联了近似实现，这里收敛为一份防漂移。
 */
export function decodeHtmlText(value: string): string {
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}
