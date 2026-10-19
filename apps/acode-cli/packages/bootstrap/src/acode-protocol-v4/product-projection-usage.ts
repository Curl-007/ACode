// 用量投影的纯函数 leaf（specs/usage-statusbar.md 协议面 1/2/3/5）。
// product-projection.ts 只保留接线：侧表生命周期与 delta 组装仍在大文件内。
// 口径纪律：generationMs/timeToFirstTokenMs 由 core producer 单点计算，这里只透传；
// 事件缺失字段时保留缺席（undefined），绝不造假值。
import { getAutoCompactThreshold } from "@acode/core";
import type {
  ModelCompletePayload,
  ModelStreamingUsageProgress,
  ModelUsage,
} from "@acode/contracts";
import type {
  SessionUsageInFlight,
  SessionUsageLastRequest,
  TurnHeaderStats,
} from "@acode/shared/acode-protocol-v4";

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
  /** 本轮服务过的模型身份（去重、请求序、上限 4）；≥2 = 轮中模型晋升（多模型轮标记）。 */
  servedModels: string[];
  /**
   * 提示缓存未命中：**进程内累计快照**语义（contracts missCauses 注释）——
   * cacheMissLast = 本轮最后一次快照总量，cacheMissBaseline = 轮起点基线
   * （投影会话级 lastTurnCacheMissTotal 种子）。每轮值 = max(0, last − baseline)；
   * 对快照求和会跨请求重复计数（评分自审抓出的真 bug，2026-10-18 修正）。
   */
  cacheMissBaseline: number;
  cacheMissLast: number | undefined;
}

/** servedModels 有界纪律：display 面字段，去重后仍限 4 项（异常轮不撑爆 row）。 */
const MAX_TURN_SERVED_MODELS = 4;

function formatServedModel(
  servedModel: ModelCompletePayload["servedModel"],
): string | undefined {
  if (!servedModel || typeof servedModel.modelId !== "string") return undefined;
  const modelId = servedModel.modelId.trim();
  if (!modelId) return undefined;
  const providerId =
    typeof servedModel.providerId === "string" ? servedModel.providerId.trim() : "";
  return providerId ? `${providerId}/${modelId}` : modelId;
}

function appendServedModel(
  previous: readonly string[],
  servedModel: ModelCompletePayload["servedModel"],
): string[] {
  const formatted = formatServedModel(servedModel);
  if (!formatted || previous.includes(formatted) || previous.length >= MAX_TURN_SERVED_MODELS) {
    return [...previous];
  }
  return [...previous, formatted];
}

function readCacheMissSnapshot(missCauses: unknown): number | undefined {
  // missCauses 缺席（旁路/旧事件）≠ 0：返回 undefined 让 cacheMissLast 保持前值。
  if (!missCauses || typeof missCauses !== "object") return undefined;
  let total = 0;
  for (const value of Object.values(missCauses as Record<string, unknown>)) {
    const count = nonNegativeNumber(value);
    if (count !== undefined) total += Math.floor(count);
  }
  return total;
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
  options?: { cacheMissBaseline?: number },
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
    servedModels: [],
    // 基线只在累加器创建时种子一次（投影传入上一轮末快照总量）。
    cacheMissBaseline: Math.max(0, Math.floor(options?.cacheMissBaseline ?? 0)),
    cacheMissLast: undefined,
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
    servedModels: appendServedModel(base.servedModels, payload.servedModel),
    // 基线随累加器对象透传（返回对象漏字段 = 差值 NaN，探针实证 2026-10-18）。
    cacheMissBaseline: base.cacheMissBaseline,
    // 快照语义：携带 missCauses 的事件覆盖 last（进程内累计，后到者更大更权威）。
    cacheMissLast: readCacheMissSnapshot(payload.cacheHit?.missCauses) ?? base.cacheMissLast,
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
    ...(accumulator.servedModels.length > 0 ? { servedModels: accumulator.servedModels } : {}),
    ...(turnCacheMissDelta(accumulator) > 0 ? { promptCacheMisses: turnCacheMissDelta(accumulator) } : {}),
  };
}

/** 每轮缓存未命中 = 轮末快照 − 轮起基线（钳 0）；无快照 → 0（缺席不投影由调用处判 >0）。 */
export function turnCacheMissDelta(accumulator: TurnUsageAccumulator): number {
  if (accumulator.cacheMissLast === undefined) return 0;
  return Math.max(0, accumulator.cacheMissLast - accumulator.cacheMissBaseline);
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

/**
 * In-flight 真实用量事实组装（specs/usage-statusbar.md「In-flight 真实用量事实面」/
 * 协议面 10-11，验收场景 8）。纯函数：投影侧唯一写入方 product-projection 只接线。
 *
 * 合并语义：inFlight 是 conflated 状态，而 adapters 每条 usage_progress 只携带自己
 * 那次 raw 事实（message_start 带 announced、message_delta 带 partial）。同一请求
 * （startedAtMs 相同）内新事实必须与上一条 inFlight 合并，否则首条 announced 会被
 * 后到的 partial 事实整键冲掉；startedAtMs 变化 = 新请求（多模型步/流恢复重试），
 * 整条替换。返回 undefined = 值未变（conflated 不重复下发）或事实非法（不造假值）。
 *
 * turnToDate 口径：累加器只在 ModelComplete 时入账已完成请求的权威 usage，进行中
 * 请求的输入尚未入账，因此 announcedInputTokens（message_start 真值，Anthropic 口径
 * 含缓存读/写）直接相加不会与累加器重复计数；ModelComplete 到达即清 inFlight，
 * 不存在「累加器已含本请求 + announced 再加一次」的窗口。输出同理：message_delta
 * 的 partialOutputTokens 是本请求累计值，加在累加器（已完成请求）之上。
 */
export function buildUsageInFlight(input: {
  /** 投影观测到的本请求首个非空 text/reasoning delta 时刻（缺席 = 尚未观测到）。 */
  firstTokenAtMs: number | undefined;
  previous: SessionUsageInFlight | null | undefined;
  turnAccumulator: TurnUsageAccumulator | undefined;
  usageProgress: ModelStreamingUsageProgress;
}): SessionUsageInFlight | undefined {
  const startedAtMs = nonNegativeNumber(input.usageProgress.requestStartedAtMs);
  const observedAtMs = nonNegativeNumber(input.usageProgress.observedAtMs);
  if (startedAtMs === undefined || observedAtMs === undefined) return undefined;
  const previous = input.previous ?? undefined;
  const sameRequest = previous !== undefined && previous.startedAtMs === startedAtMs;
  const announcedInputTokens =
    nonNegativeNumber(input.usageProgress.announcedInputTokens) ??
    (sameRequest ? previous?.announcedInputTokens : undefined);
  const partialOutputTokens =
    nonNegativeNumber(input.usageProgress.partialOutputTokens) ??
    (sameRequest ? previous?.partialOutputTokens : undefined);
  const firstTokenAtMs =
    nonNegativeNumber(input.firstTokenAtMs) ?? (sameRequest ? previous?.firstTokenAtMs : undefined);
  const accumulator = input.turnAccumulator;
  const turnToDateInputTokens =
    accumulator === undefined && announcedInputTokens === undefined
      ? undefined
      : (accumulator?.inputTokens ?? 0) + (announcedInputTokens ?? 0);
  const turnToDateOutputTokens =
    accumulator === undefined && partialOutputTokens === undefined
      ? undefined
      : (accumulator?.outputTokens ?? 0) + (partialOutputTokens ?? 0);
  const next: SessionUsageInFlight = {
    startedAtMs: Math.floor(startedAtMs),
    observedAtMs: Math.floor(observedAtMs),
    ...(announcedInputTokens !== undefined
      ? { announcedInputTokens: Math.floor(announcedInputTokens) }
      : {}),
    ...(partialOutputTokens !== undefined
      ? { partialOutputTokens: Math.floor(partialOutputTokens) }
      : {}),
    ...(firstTokenAtMs !== undefined ? { firstTokenAtMs: Math.floor(firstTokenAtMs) } : {}),
    ...(turnToDateInputTokens !== undefined
      ? { turnToDateInputTokens: Math.floor(turnToDateInputTokens) }
      : {}),
    ...(turnToDateOutputTokens !== undefined
      ? { turnToDateOutputTokens: Math.floor(turnToDateOutputTokens) }
      : {}),
  };
  if (previous !== undefined && sameUsageInFlight(previous, next)) return undefined;
  return next;
}

/** conflated 判等：全部字段一致 = 值未变，不重复下发 patch。 */
export function sameUsageInFlight(
  left: SessionUsageInFlight,
  right: SessionUsageInFlight,
): boolean {
  return (
    left.startedAtMs === right.startedAtMs &&
    left.observedAtMs === right.observedAtMs &&
    left.announcedInputTokens === right.announcedInputTokens &&
    left.partialOutputTokens === right.partialOutputTokens &&
    left.firstTokenAtMs === right.firstTokenAtMs &&
    left.turnToDateInputTokens === right.turnToDateInputTokens &&
    left.turnToDateOutputTokens === right.turnToDateOutputTokens
  );
}
