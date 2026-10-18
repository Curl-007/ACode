// 回退链执行器（specs/websearch-multi-engine.md §3.2）。
// 事件顺序：解析链 → parseSearchQuery 一次 → 依序尝试引擎（不可用静默跳过、失败聚合、
// abort 立即中止）→ applyQueryConstraints 宽松后置过滤 → 域过滤（同宽松语义）。
// 全败时返回失败聚合摘要（in-band），不抛异常——模型可读原因清单继续工作。

import type { StructuredQuery } from "./query-parse.js";
import { parseSearchQuery } from "./query-parse.js";
import { applyQueryConstraints } from "./query-filter.js";
import { matchesSite } from "./query-filter.js";
import type { SearchParams, SearchProvider } from "./providers/base.js";
import { resolveEngineChain } from "./engine-config.js";
import { formatSearchProviderFailures } from "./registry.js";
import type { SearchProviderId, SearchResponse, SearchSource } from "./types.js";
import { SearchProviderError } from "./types.js";

/** 链参数（omp executeSearch 的 role-chain 部分降解为 env 引擎链）。 */
export interface SearchChainParams {
  query: string;
  recency?: SearchParams["recency"];
  numSearchResults?: number;
  /** WebSearchInput.allowed_domains 的链上后置执行（宽松，同 §3.4）。 */
  allowedDomains?: string[];
  blockedDomains?: string[];
  signal?: AbortSignal;
  timeoutMs?: number;
  fetch?: typeof fetch;
  /** 引擎链覆盖（测试/内部用）；缺省走 resolveEngineChain(process.env)。 */
  engineIds?: readonly SearchProviderId[];
  /** provider 解析缝（测试注入）；缺省用 registry.getSearchProvider。 */
  resolveProvider?: (id: SearchProviderId) => Promise<SearchProvider>;
}

export interface SearchChainFailureEntry {
  provider: { id: string; label: string };
  error: unknown;
}

export interface SearchChainSuccess {
  ok: true;
  response: SearchResponse;
  /** 被放宽的约束说明（`no results matched \`site:x\`; the constraint was relaxed`）。 */
  notes: string[];
  /** 引擎 id 列表（成功引擎 + 沿途失败），供上层透出。 */
  attempted: SearchProviderId[];
  failures: SearchChainFailureEntry[];
}

export interface SearchChainFailure {
  ok: false;
  /** 用户可见的失败原因清单。 */
  summary: string;
  attempted: SearchProviderId[];
  failures: SearchChainFailureEntry[];
  /** 链上有引擎可用却全失败时为 true；无引擎可执行时为 false。 */
  enginesFailed: boolean;
}

/** URL 域后缀匹配 allowed/blocked_domains（与 matchesSite 同语义，剥路径）。 */
function matchesDomain(url: string, domain: string): boolean {
  const bare = domain.trim().toLowerCase().split("/", 1)[0];
  if (!bare) return false;
  return matchesSite(url, bare);
}

/** 把 allowed/blocked_domains 叠加为补充约束维度的宽松过滤。 */
function applyDomainFilter(
  sources: readonly SearchSource[],
  allowedDomains: readonly string[] | undefined,
  blockedDomains: readonly string[] | undefined,
  notes: string[],
): SearchSource[] {
  let current = [...sources];
  if (allowedDomains?.length) {
    const kept = current.filter(src => allowedDomains.some(d => matchesDomain(src.url, d)));
    if (kept.length > 0) current = kept;
    else notes.push(`no results matched the allowed_domains filter (${allowedDomains.join(", ")}); it was relaxed`);
  }
  if (blockedDomains?.length) {
    const kept = current.filter(src => !blockedDomains.some(d => matchesDomain(src.url, d)));
    if (kept.length > 0) current = kept;
    else notes.push(`no results exceeded the blocked_domains filter; it was relaxed`);
  }
  return current;
}

/** 单引擎调用：解析参数缺省 → search。空结果视为该引擎失败（链继续）。 */
async function callEngine(provider: SearchProvider, params: SearchChainParams, parsedQuery: StructuredQuery) {
  const searchParams: SearchParams = {
    query: params.query,
    parsedQuery,
    recency: params.recency,
    numSearchResults: params.numSearchResults,
    signal: params.signal,
    timeoutMs: params.timeoutMs,
    fetch: params.fetch,
  };
  const response = await provider.search(searchParams);
  if (response.sources.length === 0 && !response.answer?.trim()) {
    // 空结果视为该引擎失败：链继续尝试下一个（omp hasRenderableSearchContent 语义）。
    throw new SearchProviderError(provider.id, `${provider.label} returned no results.`, 204);
  }
  return response;
}

/**
 * 执行引擎回退链。解析 provider 缺省为 registry（懒加载）；链配置来自
 * engine-config（ACODE_WEBSEARCH_ENGINES）或 params.engineIds 覆盖。
 */
export async function runWebSearchChain(params: SearchChainParams): Promise<SearchChainSuccess | SearchChainFailure> {
  const chain = params.engineIds ? { mode: "explicit" as const, ids: [...params.engineIds] } : resolveEngineChain();
  const resolveProvider = params.resolveProvider ?? (await import("./registry.js")).getSearchProvider;
  const parsedQuery = parseSearchQuery(params.query);
  const failures: SearchChainFailureEntry[] = [];
  const attempted: SearchProviderId[] = [];
  let availableCount = 0;

  for (const id of chain.ids) {
    if (params.signal?.aborted) break;
    let provider: SearchProvider;
    try {
      provider = await resolveProvider(id);
    } catch (error) {
      failures.push({ provider: { id, label: id }, error });
      continue;
    }
    // omp 语义：链是显式点名（env 配置即显式），用 isExplicitlyAvailable 判定；
    // 默认镜像 isAvailable，凭据缺失的引擎因此静默跳过。
    const explicitOk = await provider.isExplicitlyAvailable();
    if (!explicitOk) continue;
    availableCount++;
    attempted.push(id);
    try {
      const response = await callEngine(provider, params, parsedQuery);
      const notes: string[] = [];
      let sources = response.sources;
      if (parsedQuery.hasConstraints && sources.length > 0) {
        const filtered = applyQueryConstraints(sources, parsedQuery);
        if (filtered.sources.length !== sources.length) sources = filtered.sources;
        for (const label of filtered.dropped) {
          notes.push(`no results matched \`${label}\`; the constraint was relaxed`);
        }
      }
      sources = applyDomainFilter(sources, params.allowedDomains, params.blockedDomains, notes);
      const finalResponse: SearchResponse = sources === response.sources ? response : { ...response, sources };
      return { ok: true, response: finalResponse, notes, attempted, failures };
    } catch (error) {
      // 用户取消立即中止整链，不降级为「引擎失败」（omp throwIfAborted 同款）。
      if (params.signal?.aborted) break;
      failures.push({ provider: { id: provider.id, label: provider.label }, error });
    }
  }

  const summary =
    failures.length > 0
      ? `All web search engines failed: ${formatSearchProviderFailures(failures)}`
      : "No web search engine is available (check ACODE_WEBSEARCH_ENGINES and the engines' API key env).";
  return {
    ok: false,
    summary,
    attempted,
    failures,
    enginesFailed: failures.length > 0 || availableCount === 0,
  };
}
