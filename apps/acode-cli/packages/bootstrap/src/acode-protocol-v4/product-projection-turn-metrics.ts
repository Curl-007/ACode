// 本轮生成指标与会话工具统计的纯函数 leaf
// （apps/acode-cli/specs/usage-statusbar-port.md §3.1/§3.2）。
// product-projection.ts 只保留接线；product-projection-usage.ts 保留 turnHeader.stats 累加。
import type { ModelUsage } from "@acode/contracts";
import { calculateOutputTps } from "@acode/shared";
import type { SessionToolStats, TurnMetrics } from "@acode/shared/acode-protocol-v4";

// ── 本轮生成指标累加器（§3.1）──
// 只统计 main_turn 的 model_request_completed；title/compact/目标校验/subagent 请求不进入。
export interface TurnMetricsAccumulator {
  /** 本轮首个产出内容的主回合请求的首 token 延迟；尚无内容时为 null。 */
  firstTokenMs: number | null;
  /** 本轮全部主回合请求 outputTokens 之和。 */
  outputTokens: number;
  /** 只累计「首内容到请求结束」计时完整的请求的 token 与耗时（tok/s 分子分母）。 */
  tpsOutputTokens: number;
  decodeMs: number;
  /** 本轮全部主回合请求 inputTokens 之和（含缓存读取/写入），以及进入累加的请求段数。 */
  inputTokens: number;
  requestCount: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** 最快一段速率（单次请求解码窗内的速率最大值）；计时不完整不进分子分母，无样本为 null。 */
  peakTokensPerSecond: number | null;
}

export const EMPTY_TURN_METRICS_ACCUMULATOR: TurnMetricsAccumulator = {
  firstTokenMs: null,
  outputTokens: 0,
  tpsOutputTokens: 0,
  decodeMs: 0,
  inputTokens: 0,
  requestCount: 0,
  reasoningTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  peakTokensPerSecond: null,
};

/** 会话工具统计初值；必须与 projection-state 的 sessionToolStats 初值逐字段一致。 */
export const EMPTY_SESSION_TOOL_STATS: SessionToolStats = {
  calls: 0,
  errors: 0,
  turnCount: 0,
  requestCount: 0,
  reasoningTokens: 0,
  linesAdded: 0,
  linesDeleted: 0,
};

export function areTurnMetricsEqual(left: TurnMetrics, right: TurnMetrics): boolean {
  return (
    left.firstTokenMs === right.firstTokenMs &&
    left.outputTokens === right.outputTokens &&
    left.tokensPerSecond === right.tokensPerSecond &&
    left.inputTokens === right.inputTokens &&
    left.requestCount === right.requestCount &&
    left.reasoningTokens === right.reasoningTokens &&
    left.cacheReadTokens === right.cacheReadTokens &&
    left.cacheWriteTokens === right.cacheWriteTokens &&
    left.peakTokensPerSecond === right.peakTokensPerSecond
  );
}

export function areSessionToolStatsEqual(left: SessionToolStats, right: SessionToolStats): boolean {
  return (
    left.calls === right.calls &&
    left.errors === right.errors &&
    left.turnCount === right.turnCount &&
    left.requestCount === right.requestCount &&
    left.reasoningTokens === right.reasoningTokens &&
    left.linesAdded === right.linesAdded &&
    left.linesDeleted === right.linesDeleted &&
    left.fileCount === right.fileCount &&
    left.retryCount === right.retryCount &&
    areSessionToolEntriesEqual(left.tools, right.tools)
  );
}

/** 每工具聚合的等值判定：长度 + 逐项（name/calls/errors/durationMs）比对，顺序敏感。 */
function areSessionToolEntriesEqual(
  left: SessionToolStats["tools"],
  right: SessionToolStats["tools"],
): boolean {
  const leftItems = left ?? [];
  const rightItems = right ?? [];
  if (leftItems.length !== rightItems.length) return false;
  for (let index = 0; index < leftItems.length; index += 1) {
    const a = leftItems[index];
    const b = rightItems[index];
    if (
      a === undefined ||
      b === undefined ||
      a.name !== b.name ||
      a.calls !== b.calls ||
      a.errors !== b.errors ||
      a.durationMs !== b.durationMs
    ) {
      return false;
    }
  }
  return true;
}

/**
 * 每工具聚合加一条终态记录，返回新数组（不改入参）。
 * 顺序固定为「次数降序 → 名称升序」，让等值判定与下发负载稳定。
 */
export function accumulateToolEntry(
  entries: SessionToolStats["tools"],
  toolName: string,
  outcome: { failed: boolean; durationMs: number | null },
): SessionToolStats["tools"] {
  const next = [...(entries ?? [])];
  const index = next.findIndex((entry) => entry.name === toolName);
  const previous = index >= 0 ? next[index] : undefined;
  const merged = {
    name: toolName,
    calls: (previous?.calls ?? 0) + 1,
    errors: (previous?.errors ?? 0) + (outcome.failed ? 1 : 0),
    ...(previous?.durationMs !== undefined || outcome.durationMs !== null
      ? { durationMs: (previous?.durationMs ?? 0) + (outcome.durationMs ?? 0) }
      : {}),
  };
  if (index >= 0) next[index] = merged;
  else next.push(merged);
  next.sort((left, right) =>
    right.calls === left.calls ? left.name.localeCompare(right.name) : right.calls - left.calls,
  );
  return next;
}

/**
 * main_turn 的 model_request_completed → 累加本轮指标。
 * 输入口径统一走 getModelUsageInputWindowTokens（AI SDK v6 的 inputTokens 已含 cache
 * read/write，再叠 cacheRead 会把本轮用量放大一截）。decode 窗只用
 * 「首内容 → 请求结束」两端已知的请求；未知值不用请求总耗时替代。
 */
export function accumulateTurnMetrics(
  previous: TurnMetricsAccumulator,
  payload: {
    timeToFirstContentMs?: number;
    durationMs: number;
    usage?: ModelUsage;
    inputWindowTokens: number;
  },
): TurnMetricsAccumulator {
  const contentMs = nonNegativeNumber(payload.timeToFirstContentMs);
  const firstTokenMs = contentMs ?? null;
  const durationMs = flooredOrZero(payload.durationMs);
  const outputTokens = flooredOrZero(payload.usage?.outputTokens);
  const decodeMs =
    firstTokenMs !== null && durationMs > firstTokenMs ? durationMs - firstTokenMs : 0;
  const reasoningTokens = flooredOrZero(payload.usage?.reasoningTokens);
  // 峰值 = 最快一段：与本轮加权值同一 decode 窗口径，只取单段最大值。
  const requestRate = decodeMs > 0 ? (outputTokens * 1000) / decodeMs : null;
  const peakTokensPerSecond =
    requestRate === null
      ? previous.peakTokensPerSecond
      : Math.max(previous.peakTokensPerSecond ?? 0, requestRate);
  return {
    firstTokenMs: previous.firstTokenMs ?? firstTokenMs,
    outputTokens: previous.outputTokens + outputTokens,
    tpsOutputTokens: previous.tpsOutputTokens + (decodeMs > 0 ? outputTokens : 0),
    decodeMs: previous.decodeMs + decodeMs,
    inputTokens: previous.inputTokens + flooredOrZero(payload.inputWindowTokens),
    requestCount: previous.requestCount + 1,
    reasoningTokens: previous.reasoningTokens + reasoningTokens,
    cacheReadTokens: previous.cacheReadTokens + flooredOrZero(payload.usage?.cacheReadTokens),
    cacheWriteTokens: previous.cacheWriteTokens + flooredOrZero(payload.usage?.cacheWriteTokens),
    peakTokensPerSecond,
  };
}

/** 累加器 → wire 形状；输出为 0 且无首 token 时调用方按「无指标」处理。 */
export function buildTurnMetrics(accumulator: TurnMetricsAccumulator): TurnMetrics | undefined {
  if (accumulator.outputTokens <= 0 && accumulator.firstTokenMs === null) return undefined;
  return {
    firstTokenMs: accumulator.firstTokenMs,
    outputTokens: accumulator.outputTokens,
    // 与 Developer Tools TPS 同一函数、同一计时窗（session-debug.ts 的 calculateOutputTps）。
    tokensPerSecond: calculateOutputTps(
      accumulator.tpsOutputTokens,
      accumulator.decodeMs > 0 ? accumulator.decodeMs : null,
    ),
    inputTokens: accumulator.inputTokens,
    requestCount: accumulator.requestCount,
    reasoningTokens: accumulator.reasoningTokens,
    cacheReadTokens: accumulator.cacheReadTokens,
    cacheWriteTokens: accumulator.cacheWriteTokens,
    ...(accumulator.peakTokensPerSecond === null
      ? {}
      : { peakTokensPerSecond: accumulator.peakTokensPerSecond }),
  };
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function flooredOrZero(value: unknown): number {
  return Math.floor(nonNegativeNumber(value) ?? 0);
}
