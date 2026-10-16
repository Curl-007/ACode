// 用量投影的纯函数 leaf（specs/usage-statusbar.md 协议面 1/2/3/5）。
// product-projection.ts 只保留接线：侧表生命周期与 delta 组装仍在大文件内。
// 口径纪律：generationMs/timeToFirstTokenMs 由 core producer 单点计算，这里只透传；
// 事件缺失字段时保留缺席（undefined），绝不造假值。
import { getAutoCompactThreshold } from "@acode/core";
import type { ModelCompletePayload, ModelUsage } from "@acode/contracts";
import type { SessionUsageLastRequest, TurnHeaderStats } from "@acode/shared/acode-protocol-v4";

/** 每个 product turn 一份；ModelComplete（main_turn）累加，轮收口 flush 进 turnHeader.stats。 */
export interface TurnUsageAccumulator {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  // undefined = 本轮尚无任何请求携带该事实；stats 对应字段保持缺席。
  generationMs: number | undefined;
  timeToFirstTokenMs: number | undefined;
  modelRequestCount: number;
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function flooredOrZero(value: unknown): number {
  return Math.floor(nonNegativeNumber(value) ?? 0);
}

/**
 * 是否携带真实模型事实。冷恢复 hydration 会为每个历史轮合成**零用量、无 timing**的
 * ModelComplete 占位事件（transcript-hydration finishTurn / output-token Continue 恢复）；
 * 把它们计入会让纯问答判定失真（stats 变成全零对象而非 null），并在 lastRequest 上造假值。
 */
export function modelCompleteCarriesUsageFacts(payload: ModelCompletePayload): boolean {
  if (nonNegativeNumber(payload.generationMs) !== undefined) return true;
  if (nonNegativeNumber(payload.timeToFirstTokenMs) !== undefined) return true;
  const usage = payload.usage as ModelUsage | undefined;
  if (!usage) return false;
  return [
    usage.inputTokens,
    usage.outputTokens,
    usage.totalTokens,
    usage.reasoningTokens,
    usage.cacheReadTokens,
    usage.cacheWriteTokens,
  ].some((value) => (nonNegativeNumber(value) ?? 0) > 0);
}

export function accumulateTurnUsage(
  previous: TurnUsageAccumulator | undefined,
  payload: ModelCompletePayload,
): TurnUsageAccumulator {
  const usage = (payload.usage ?? {}) as ModelUsage;
  const base: TurnUsageAccumulator = previous ?? {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    generationMs: undefined,
    timeToFirstTokenMs: undefined,
    modelRequestCount: 0,
  };
  const generationMs = nonNegativeNumber(payload.generationMs);
  const timeToFirstTokenMs = nonNegativeNumber(payload.timeToFirstTokenMs);
  return {
    inputTokens: base.inputTokens + flooredOrZero(usage.inputTokens),
    outputTokens: base.outputTokens + flooredOrZero(usage.outputTokens),
    reasoningTokens: base.reasoningTokens + flooredOrZero(usage.reasoningTokens),
    cacheReadTokens: base.cacheReadTokens + flooredOrZero(usage.cacheReadTokens),
    cacheWriteTokens: base.cacheWriteTokens + flooredOrZero(usage.cacheWriteTokens),
    // ΣgenerationMs 只累计携带该事实的请求（速率行加权分母，spec「回答末尾速率行」）。
    generationMs:
      generationMs === undefined ? base.generationMs : (base.generationMs ?? 0) + generationMs,
    // 用户感知首字 = 本轮首个携带 TTFT 的请求，后续请求不覆盖。
    timeToFirstTokenMs: base.timeToFirstTokenMs ?? timeToFirstTokenMs,
    modelRequestCount: base.modelRequestCount + 1,
  };
}

export function buildTurnHeaderStats(accumulator: TurnUsageAccumulator): TurnHeaderStats {
  return {
    inputTokens: accumulator.inputTokens,
    outputTokens: accumulator.outputTokens,
    reasoningTokens: accumulator.reasoningTokens,
    cacheReadTokens: accumulator.cacheReadTokens,
    cacheWriteTokens: accumulator.cacheWriteTokens,
    ...(accumulator.timeToFirstTokenMs !== undefined
      ? { timeToFirstTokenMs: accumulator.timeToFirstTokenMs }
      : {}),
    ...(accumulator.generationMs !== undefined ? { generationMs: accumulator.generationMs } : {}),
    modelRequestCount: accumulator.modelRequestCount,
  };
}

/**
 * lastRequest = 最近一次模型请求（conflated）。发射点缺 generationMs（sidecar/compact/
 * title 等旁路，或旧事件）时返回 previous——旁路请求不是用户等待的正文生成，不得顶掉
 * 主链路上一次真值，也不得造 0 值。
 */
export function buildUsageLastRequest(
  payload: ModelCompletePayload,
  completedAtMs: number,
  previous: SessionUsageLastRequest | null | undefined,
): SessionUsageLastRequest | null | undefined {
  const generationMs = nonNegativeNumber(payload.generationMs);
  if (generationMs === undefined) return previous;
  const usage = (payload.usage ?? {}) as ModelUsage;
  const timeToFirstTokenMs = nonNegativeNumber(payload.timeToFirstTokenMs);
  return {
    outputTokens: flooredOrZero(usage.outputTokens),
    generationMs,
    ...(timeToFirstTokenMs !== undefined ? { timeToFirstTokenMs } : {}),
    completedAtMs,
  };
}

/**
 * cumulative.reasoningTokens 累加。schema 口径「缺席 ≠ 0」：双方都缺席时保持缺席，
 * 任何一方出现事实后收敛为数值累计。
 */
export function addCumulativeReasoningTokens(
  previous: number | undefined,
  reasoningTokens: number | undefined,
): number | undefined {
  const add = nonNegativeNumber(reasoningTokens);
  if (previous === undefined && add === undefined) return undefined;
  return Math.floor(previous ?? 0) + Math.floor(add ?? 0);
}

/**
 * auto-compact 阈值真值：core compact policy 的纯函数出口（getAutoCompactThreshold），
 * 与 runtime autoCompactIfNeeded 同源。投影只知道 contextWindow，模型输出预留与 buffer
 * 走 policy 默认；窗口未知/非法 → null（未知容量语义，不得造阈值）。
 */
export function computeAutoCompactThresholdTokens(
  maxTokens: number | null | undefined,
): number | null {
  const contextWindow = nonNegativeNumber(maxTokens);
  if (contextWindow === undefined || contextWindow <= 0) return null;
  return getAutoCompactThreshold({ contextWindow: Math.floor(contextWindow) });
}

/** 窗口未变时保留既有阈值（可能是更权威的来源）；窗口变化或缺失时按纯函数重算。 */
export function carryAutoCompactThresholdTokens(
  previous: { maxTokens: number; autoCompactThresholdTokens: number | null } | null | undefined,
  maxTokens: number,
): number | null {
  if (
    previous &&
    previous.maxTokens === maxTokens &&
    previous.autoCompactThresholdTokens !== null
  ) {
    return previous.autoCompactThresholdTokens;
  }
  return computeAutoCompactThresholdTokens(maxTokens);
}

/**
 * SubagentStopped 是唯一携带 child 累计 tokens 的权威事件（core runner 终态发射点）。
 * 缺失/非法 → undefined（缺席时 UI 隐藏该列而非按 0 呈现，snapshot.ts 同口径）。
 */
export function subagentStoppedCumulativeTokens(payload: {
  totalTokens?: unknown;
}): number | undefined {
  const value = nonNegativeNumber(payload.totalTokens);
  return value === undefined ? undefined : Math.floor(value);
}
