// 多引擎层 handler 支面（specs/websearch-multi-engine.md §3.1/§3.5）。
// 从 websearch.ts 拆出（400 行上限，架构 ratchet）：ACODE_WEBSEARCH_ENGINES 设置后
// WebSearch 走 core/src/websearch 的引擎回退链替代该请求的 provider-native 路径——
// 该分支不要求 model/supportsNativeWebSearch（引擎是直连 HTTP，不经过模型）。

import {
  type WebSearchInput,
  type WebSearchOutput,
  type WebSearchSource,
} from "@acode/contracts";
import { runWebSearchChain, type SearchChainFailure, type SearchChainSuccess } from "../../websearch/chain.js";
import { getSearchProviderLabel, type SearchProviderId } from "../../websearch/types.js";

/** 成功摘要：引擎标签 + 可选答案 + 放宽说明 + 沿途失败清单（用户可见）。 */
function buildMultiEngineSummary(chain: SearchChainSuccess): string {
  const engineLabel = getSearchProviderLabel(
    chain.response.provider === "none" ? "public" : (chain.response.provider as SearchProviderId),
  );
  const parts: string[] = [];
  if (chain.response.answer?.trim()) {
    parts.push(chain.response.answer.trim(), "");
  }
  for (const note of chain.notes) {
    parts.push(`Note: ${note}`);
  }
  if (chain.failures.length > 0) {
    // 首选引擎失败由后续引擎兜底成功：失败原因清单随成功结果透出（spec §3.2 第 5 步）。
    parts.push(
      `Note: earlier engines failed before ${engineLabel} succeeded: ${chain.failures
        .map(f => `${f.provider.id}: ${f.error instanceof Error ? f.error.message : String(f.error)}`)
        .join("; ")}`,
    );
  }
  parts.push(`Searched via ${engineLabel}.`);
  return parts.join("\n").trim();
}

/** SearchChain 结果 → WebSearchOutput（契约面：results/sources/summary/durationMs）。 */
export function buildMultiEngineOutput(
  input: WebSearchInput,
  startedAt: number,
  outcome: SearchChainSuccess | SearchChainFailure,
): WebSearchOutput {
  if (!outcome.ok) {
    return {
      query: input.query,
      results: [],
      sources: [],
      summary: outcome.summary,
      durationMs: Date.now() - startedAt,
      webSearchRequests: 0,
    };
  }
  const results = outcome.response.sources.map(source => ({
    url: source.url,
    title: source.title || undefined,
    pageAge: source.publishedDate || undefined,
  }));
  const sources: WebSearchSource[] = outcome.response.sources.map(source => ({
    url: source.url,
    title: source.title || undefined,
  }));
  return {
    query: input.query,
    results,
    sources,
    summary: buildMultiEngineSummary(outcome),
    durationMs: Date.now() - startedAt,
    webSearchRequests: 0,
  };
}

/** 执行多引擎路径：allowed/blocked_domains 与 abort/超时直通回退链。 */
export async function runMultiEnginePath(
  input: WebSearchInput,
  startedAt: number,
  abortSignal: AbortSignal,
  timeoutMs: number,
): Promise<WebSearchOutput> {
  const outcome = await runWebSearchChain({
    query: input.query,
    allowedDomains: input.allowed_domains,
    blockedDomains: input.blocked_domains,
    signal: abortSignal,
    timeoutMs,
  });
  return buildMultiEngineOutput(input, startedAt, outcome);
}
