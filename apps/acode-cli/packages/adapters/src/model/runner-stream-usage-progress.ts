import type { ModelStreamEvent } from "@acode/contracts";
import { asRecord, isRecord, numberProperty } from "./runner-record.js";

// In-flight 真实用量事实提取 + 单点节流（specs/usage-statusbar.md
// 「In-flight 真实用量事实面」，producer = adapters raw 通道）：
// - 只消费 provider 原始 SSE 里已存在的 usage 真值（Anthropic message_start /
//   message_delta），严禁按字符数估算 token；
// - 非 Anthropic 形状（OpenAI 系 include_usage 只在末包）自然无中途事实 →
//   不发射事件，链路如实降级为 UI 秒表 + 脉冲点（spec 能力矩阵）；
// - 节流 ≥500ms/请求：首事实立即发；被抑制的事实不补发、请求结束不发尾包
//   （权威值走 finish chunk）。message_delta 的 output_tokens 本身是累计值，
//   下一条过窗事实天然携带最新总量，纯增量语义无信息损失。
// - 本事件面与 compact 重试边界（isRawProviderRetryBoundaryEvent /
//   toProviderStreamBoundaryEvent）完全正交：调用方保证 compact 请求
//   （preserveProviderStreamBoundaries）不进入本提取器。
const USAGE_PROGRESS_MIN_INTERVAL_MS = 500;

export type UsageProgressStreamEvent = Extract<ModelStreamEvent, { type: "usage_progress" }>;

export interface UsageProgressFact {
  announcedInputTokens?: number;
  partialOutputTokens?: number;
}

function nonNegativeToken(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value < 0) return undefined;
  return Math.floor(value);
}

/**
 * 从单条 provider raw SSE 事件提取 in-flight usage 事实；无事实返回 undefined。
 *
 * Anthropic message_start 的 raw usage 把缓存读/写记在独立字段
 * （cache_read_input_tokens / cache_creation_input_tokens），而 AI SDK v6 归一后的
 * inputTokens 是含缓存的 total input（数据口径 1「cache_read 已含于 input」，见
 * contracts getModelUsageInputWindowTokens 注释）。这里求和后发射，保证上下文环
 * live 水位与 ModelComplete 写入的权威 usedTokens 同口径，不出现完成瞬间的回跳。
 */
export function extractUsageProgressFact(rawValue: unknown): UsageProgressFact | undefined {
  if (!isRecord(rawValue)) return undefined;
  if (rawValue.type === "message_start") {
    const usage = asRecord((rawValue as { message?: unknown }).message).usage;
    const inputTokens = nonNegativeToken(numberProperty(asRecord(usage), "input_tokens"));
    if (inputTokens === undefined) return undefined;
    // 缺省 0：Anthropic 无缓存时字段缺席，语义即无缓存 token（求和不造假值）。
    const cacheReadTokens =
      nonNegativeToken(numberProperty(asRecord(usage), "cache_read_input_tokens")) ?? 0;
    const cacheCreationTokens =
      nonNegativeToken(numberProperty(asRecord(usage), "cache_creation_input_tokens")) ?? 0;
    return { announcedInputTokens: inputTokens + cacheReadTokens + cacheCreationTokens };
  }
  if (rawValue.type === "message_delta") {
    // message_delta.usage.output_tokens 是本请求累计输出（含思考），provider 原值。
    const outputTokens = nonNegativeToken(
      numberProperty(asRecord(rawValue.usage), "output_tokens"),
    );
    if (outputTokens === undefined) return undefined;
    return { partialOutputTokens: outputTokens };
  }
  return undefined;
}

/**
 * 节流判定（纯函数，验收场景 8）：首事实（lastEmittedAtMs=null）立即放行；
 * 后续事实要求与上一条**已发射**事实间隔 ≥500ms，被抑制的事实直接丢弃不补发。
 */
export function shouldEmitUsageProgress(
  lastEmittedAtMs: number | null,
  observedAtMs: number,
): boolean {
  if (lastEmittedAtMs === null) return true;
  return observedAtMs - lastEmittedAtMs >= USAGE_PROGRESS_MIN_INTERVAL_MS;
}

export interface UsageProgressThrottle {
  /**
   * 观测一条 provider raw SSE 事件：提取到事实且过节流窗 → 返回 usage_progress
   * 流事件；否则 undefined（无事实 / 被抑制 / 非法值）。同步纯增量，无定时器。
   */
  observe(rawValue: unknown, observedAtMs: number): UsageProgressStreamEvent | undefined;
}

/**
 * per-request（= adapters per-attempt）节流器。requestStartedAtMs 由调用方传入
 * 本次模型请求起点（attempt startedAt）：与 observedAtMs 同进程时钟，进行中
 * tok/s 分母（observedAtMs − startedAtMs，口径 4）自洽。
 */
export function createUsageProgressThrottle(requestStartedAtMs: number): UsageProgressThrottle {
  let lastEmittedAtMs: number | null = null;
  return {
    observe(rawValue, observedAtMs) {
      const fact = extractUsageProgressFact(rawValue);
      if (!fact) return undefined;
      if (!shouldEmitUsageProgress(lastEmittedAtMs, observedAtMs)) return undefined;
      lastEmittedAtMs = observedAtMs;
      return {
        type: "usage_progress",
        requestStartedAtMs,
        observedAtMs,
        ...(fact.announcedInputTokens !== undefined
          ? { announcedInputTokens: fact.announcedInputTokens }
          : {}),
        ...(fact.partialOutputTokens !== undefined
          ? { partialOutputTokens: fact.partialOutputTokens }
          : {}),
      };
    },
  };
}
