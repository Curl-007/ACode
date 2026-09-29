import { CoreErrorType, createModelUsageSummary, type ModelUsageSummary } from "@acode/contracts";
import type { TuiCopy } from "@acode/i18n";
import type { CacheStats, ContextUsage } from "./app-model.js";
import { asRecord, booleanField, numberField, stringField } from "./state.js";

type ModelNetworkRequestTarget = {
  model?: string;
  provider?: string;
  url: string;
};

export function validContextUsage(projection: ContextUsage): ContextUsage {
  return {
    ...(validTokenCount(projection.contextUsed) !== undefined
      ? { contextUsed: projection.contextUsed }
      : {}),
    ...(validTokenCount(projection.contextWindow) !== undefined
      ? { contextWindow: projection.contextWindow }
      : {}),
  };
}

export function contextWindowFromPayload(payload: Record<string, unknown>): number | undefined {
  return validTokenCount(numberField(payload, "contextWindow"));
}

export function usageFromPayload(payload: Record<string, unknown>): ModelUsageSummary | undefined {
  const usage = asRecord(payload.usage);
  if (Object.keys(usage).length === 0) return undefined;
  const modelRequestCount = numberField(usage, "modelRequestCount");
  if (modelRequestCount !== undefined) {
    return {
      cacheReadTokens: numberField(usage, "cacheReadTokens") ?? 0,
      cacheWriteTokens: numberField(usage, "cacheWriteTokens") ?? 0,
      inputTokens: numberField(usage, "inputTokens") ?? 0,
      modelRequestCount,
      outputTokens: numberField(usage, "outputTokens") ?? 0,
      reasoningTokens: numberField(usage, "reasoningTokens") ?? 0,
      source: "provider",
      totalTokens: numberField(usage, "totalTokens") ?? 0,
      webFetchRequests: numberField(usage, "webFetchRequests") ?? 0,
      webSearchRequests: numberField(usage, "webSearchRequests") ?? 0,
    };
  }

  const serverToolUse = asRecord(usage.serverToolUse);
  return createModelUsageSummary([
    {
      cacheReadTokens: numberField(usage, "cacheReadTokens"),
      cacheWriteTokens: numberField(usage, "cacheWriteTokens"),
      inputTokens: numberField(usage, "inputTokens"),
      outputTokens: numberField(usage, "outputTokens"),
      reasoningTokens: numberField(usage, "reasoningTokens"),
      serverToolUse: {
        webFetchRequests: numberField(serverToolUse, "webFetchRequests"),
        webSearchRequests: numberField(serverToolUse, "webSearchRequests"),
      },
      totalTokens: numberField(usage, "totalTokens"),
    },
  ]);
}

export function cacheStatsFromPayload(payload: Record<string, unknown>): CacheStats | undefined {
  const stats = asRecord(payload.cacheStats);
  if (Object.keys(stats).length === 0) return undefined;

  const next: CacheStats = {
    cachedMessages: numberField(stats, "cachedMessages"),
    cacheReadTokens: numberField(stats, "cacheReadTokens"),
    lastCacheHit: booleanField(stats, "lastCacheHit"),
    totalMessages: numberField(stats, "totalMessages"),
  };

  return Object.values(next).some((value) => value !== undefined) ? next : undefined;
}

export function formatEventError(
  payload: Record<string, unknown>,
  errors: TuiCopy["errors"],
): string {
  const error = asRecord(payload.error);
  const detail =
    stringField(error, "message") ??
    stringField(payload, "message") ??
    stringField(payload, "reason");
  // 兜底行也走 catalog：它是纯 UI 文本（没有对应的模型面原文），以前是硬编码英文。
  if (detail === undefined) return errors.unknown;
  // 语言策略（specs/prompt-language-policy.md R3）：工具错误的 message 是**双面文本**
  // （同一段英文既进 tool result 给模型，又被这里展示），所以 UI 侧只能按结构化字段
  // 查 catalog，不翻译 message 本身；detail 原样带英文原文。
  // 表外一律回落展示原始英文——错误种类是开放集合，catalog 是封闭集合，回落是必须的。
  if (stringField(error, "type") === CoreErrorType.ToolCancelled) {
    return errors.toolCancelled(detail);
  }
  return detail;
}

export function modelNetworkRequestTargetFromPayload(
  payload: Record<string, unknown>,
): ModelNetworkRequestTarget {
  const model = asRecord(payload.model);
  const providerRecord = asRecord(payload.provider);
  const connection = asRecord(payload.connection);
  const provider =
    stringField(model, "providerId") ??
    stringField(payload, "providerId") ??
    stringField(providerRecord, "providerId") ??
    stringField(providerRecord, "id") ??
    stringField(connection, "providerId");
  const modelId =
    stringField(model, "modelId") ??
    stringField(model, "model") ??
    stringField(model, "id") ??
    stringField(payload, "modelId");
  const url =
    stringUrlField(payload, "baseURL") ??
    stringUrlField(payload, "baseUrl") ??
    stringUrlField(payload, "url") ??
    stringUrlField(providerRecord, "baseURL") ??
    stringUrlField(providerRecord, "baseUrl") ??
    stringUrlField(providerRecord, "url") ??
    stringUrlField(connection, "baseURL") ??
    stringUrlField(connection, "baseUrl") ??
    stringUrlField(connection, "url") ??
    modelNetworkTargetFallback(provider, modelId);

  return {
    model: modelId,
    provider,
    url,
  };
}

function validTokenCount(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function stringUrlField(record: Record<string, unknown>, key: string): string | undefined {
  const value = stringField(record, key);
  return value && value !== "model" ? value : undefined;
}

function modelNetworkTargetFallback(
  provider: string | undefined,
  model: string | undefined,
): string {
  if (provider && model) return `${provider}/${model}`;
  return provider ?? model ?? "model";
}
