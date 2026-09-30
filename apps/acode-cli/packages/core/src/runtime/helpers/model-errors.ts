import { CoreErrorType, ModelErrorCode, createCoreError, isCoreError } from "../deps.js";
import type { ModelUsage } from "../deps.js";
import { isPlainRecord, stringProperty } from "./data.js";
import {
  createCoreErrorFromProviderBusinessLike,
  findProviderBusinessFailureInMetadata,
} from "./provider-business-error.js";

export function readRawFinishReason(
  providerMetadata: Record<string, unknown> | undefined,
): string | undefined {
  if (!providerMetadata) return undefined;
  const direct = providerMetadata.rawFinishReason;
  return typeof direct === "string" ? direct : undefined;
}

export function isContextExceededFinishReason(
  finishReason: string | undefined,
  rawFinishReason: string | undefined,
): boolean {
  return (
    isModelContextExceededMarker(finishReason) || isModelContextExceededMarker(rawFinishReason)
  );
}

export function createModelContextExceededFinishError(input: {
  finishReason: string | undefined;
  rawFinishReason: string | undefined;
}) {
  return createCoreError(
    CoreErrorType.ModelContextExceeded,
    "Model request exceeded the provider context window.",
    {
      context: {
        finishReason: input.finishReason,
        rawFinishReason: input.rawFinishReason,
      },
      recoverable: true,
      retryable: true,
    },
  );
}

export function createCompactRapidRefillError(input: {
  consecutiveRapidRefills: number;
  maxConsecutiveRapidRefills: number;
  toolTurnThreshold: number;
  toolTurnsSinceCompact: number;
}) {
  return createCoreError(
    CoreErrorType.ModelContextExceeded,
    `Autocompact stopped because the context refilled within fewer than ${input.toolTurnThreshold} tool turns after compaction ${input.maxConsecutiveRapidRefills} times in a row. A file or tool output may be too large. Read it in smaller chunks, or start a new session.`,
    {
      context: {
        consecutiveRapidRefills: input.consecutiveRapidRefills,
        maxConsecutiveRapidRefills: input.maxConsecutiveRapidRefills,
        reason: "compact_rapid_refill_breaker",
        toolTurnsSinceCompact: input.toolTurnsSinceCompact,
        toolTurnThreshold: input.toolTurnThreshold,
      },
      recoverable: true,
      retryable: true,
    },
  );
}

export function isSuspiciousEmptyModelResult(
  finishReason: string | undefined,
  responseLength: number,
  toolCallCount: number,
  usage?: ModelUsage,
): boolean {
  return (
    responseLength === 0 &&
    toolCallCount === 0 &&
    isNonStopFinish(finishReason) &&
    isZeroUsage(usage)
  );
}

const SUSPICIOUS_EMPTY_MODEL_RESULT_MESSAGE =
  "Model returned no text, no tool calls, and no usage before completing the turn.";

function createSuspiciousEmptyModelResultError(
  finishReason: string | undefined,
  rawFinishReason: string | undefined,
  model?: { modelId: string; providerId: string },
) {
  return createCoreError(CoreErrorType.ModelError, SUSPICIOUS_EMPTY_MODEL_RESULT_MESSAGE, {
    context: {
      finishReason,
      ...(model ? { modelId: model.modelId, providerId: model.providerId } : {}),
      rawFinishReason,
      // UI/turn-errors 需识别空 completion，才能展示中文文案与 Coding Plan 恢复动作。
      // 空响应不能只有展示标记，否则监控无法与 provider/SSE 类故障做结构化聚合。
      reason: "empty_model_response",
      source: "provider",
      suspiciousEmpty: true,
    },
    recoverable: true,
    retryable: true,
  });
}

/** 空流终态诊断：供 core/adapters 日志与 UI 错误归因对照。 */
export function buildSuspiciousEmptyDiagnostics(input: {
  finishReason: string | undefined;
  providerMetadata: Record<string, unknown> | undefined;
  rawFinishReason: string | undefined;
  outboundHeaderKeys?: string[];
}): Record<string, unknown> {
  const businessFailure = findProviderBusinessFailureInMetadata(input.providerMetadata);
  return {
    finishReason: input.finishReason ?? null,
    rawFinishReason: input.rawFinishReason ?? null,
    outboundHeaderKeys: input.outboundHeaderKeys ?? [],
    providerMetadataKeys: input.providerMetadata
      ? Object.keys(input.providerMetadata).slice(0, 20)
      : [],
    providerBusinessCodeFromMetadata: businessFailure?.providerCode ?? null,
    providerBusinessMessageFromMetadata: businessFailure?.message ?? null,
    responseBodySummaryFromMetadata: businessFailure?.responseBodySummary ?? null,
  };
}

export function finalizeSuspiciousEmptyModelResult(input: {
  finishReason: string | undefined;
  model: { modelId: string; providerId: string };
  providerMetadata: Record<string, unknown> | undefined;
  rawFinishReason: string | undefined;
}): void {
  const providerBusinessError = tryCreateProviderBusinessModelErrorFromMetadata(
    input.providerMetadata,
    input.model,
  );
  if (providerBusinessError) {
    throw providerBusinessError;
  }

  throw createSuspiciousEmptyModelResultError(
    input.finishReason,
    input.rawFinishReason,
    input.model,
  );
}

function tryCreateProviderBusinessModelErrorFromMetadata(
  providerMetadata: Record<string, unknown> | undefined,
  model?: { modelId: string; providerId: string },
): ReturnType<typeof createCoreError> | undefined {
  const failure = findProviderBusinessFailureInMetadata(providerMetadata);
  if (!failure) {
    return undefined;
  }

  // adapter 偶发把 zcode-plan 业务错误落成空 finish + 零 usage，core 会先抛 suspicious empty。
  // 在 anomaly guard 前先从 providerMetadata 恢复 providerCode（如 3007），让 UI 能命中业务错误文案。
  return createCoreError(CoreErrorType.ModelError, failure.message, {
    context: {
      ...(model ? { modelId: model.modelId, providerId: model.providerId } : {}),
      ...(failure.providerCode ? { providerCode: failure.providerCode } : {}),
      source: "provider",
      ...(failure.responseBodySummary ? { responseBodySummary: failure.responseBodySummary } : {}),
    },
    recoverable: true,
    retryable: false,
  });
}

function isNonStopFinish(finishReason?: string): boolean {
  const normalized = finishReason?.trim().toLowerCase();
  return normalized !== "stop" && normalized !== "tool-calls" && normalized !== "tool_calls";
}

function isZeroUsage(usage?: ModelUsage): boolean {
  if (!usage) return true;
  const total =
    usage.totalTokens ??
    (usage.inputTokens ?? 0) +
      (usage.outputTokens ?? 0) +
      (usage.cacheReadTokens ?? 0) +
      (usage.cacheWriteTokens ?? 0) +
      (usage.reasoningTokens ?? 0);
  return total === 0;
}

export function normalizeStreamError(error: unknown): Error {
  const providerBusinessError = createCoreErrorFromProviderBusinessLike(error);
  if (providerBusinessError) {
    return providerBusinessError;
  }

  if (error instanceof Error) {
    return error;
  }

  return new Error(
    typeof error === "string" ? error : (JSON.stringify(error) ?? "Model stream failed"),
  );
}

const MODEL_CONTEXT_EXCEEDED_MARKERS = new Set<string>([
  CoreErrorType.ModelContextExceeded,
  ModelErrorCode.ModelContextExceeded,
  "context_exceeded",
  "context_length_exceeded",
  "context_window_exceeded",
  "model_context_window_exceeded",
  "prompt_too_long",
]);

const MODEL_MEDIA_TOO_LARGE_MARKERS = new Set<string>([
  "media_too_large",
  "media_payload_too_large",
  "image_too_large",
  "document_too_large",
]);

export function isModelContextExceededError(error: unknown): boolean {
  let current = error;
  const seen = new WeakSet<object>();

  for (let depth = 0; depth <= 6; depth += 1) {
    if (current === undefined || current === null) return false;
    if (typeof current !== "object") return false;
    if (seen.has(current)) return false;
    seen.add(current);

    if (isCoreError(current) && current.type === CoreErrorType.ModelContextExceeded) {
      return true;
    }

    const record = current as Record<string, unknown>;
    if (
      isModelContextExceededMarker(stringProperty(record, "type")) ||
      isModelContextExceededMarker(stringProperty(record, "code")) ||
      isModelContextExceededMarker(stringProperty(record, "reason")) ||
      isModelContextExceededMarker(stringProperty(record, "stopReason")) ||
      isModelContextExceededMessage(stringProperty(record, "message"))
    ) {
      return true;
    }

    const context = isPlainRecord(record.context) ? record.context : undefined;
    if (
      context &&
      (isModelContextExceededMarker(stringProperty(context, "type")) ||
        isModelContextExceededMarker(stringProperty(context, "code")) ||
        isModelContextExceededMarker(stringProperty(context, "reason")))
    ) {
      return true;
    }

    current = record.cause ?? record.lastError ?? record.error;
  }

  return false;
}

function isModelContextExceededMarker(value: string | undefined): boolean {
  return value !== undefined && MODEL_CONTEXT_EXCEEDED_MARKERS.has(value.trim().toLowerCase());
}

export function isModelMediaTooLargeError(error: unknown): boolean {
  let current = error;
  const seen = new WeakSet<object>();

  for (let depth = 0; depth <= 6; depth += 1) {
    if (current === undefined || current === null) return false;
    if (typeof current !== "object") return false;
    if (seen.has(current)) return false;
    seen.add(current);

    const record = current as Record<string, unknown>;
    if (
      isModelMediaTooLargeMarker(stringProperty(record, "type")) ||
      isModelMediaTooLargeMarker(stringProperty(record, "code")) ||
      isModelMediaTooLargeMarker(stringProperty(record, "reason")) ||
      isModelMediaTooLargeMessage(stringProperty(record, "message"))
    ) {
      return true;
    }

    const context = isPlainRecord(record.context) ? record.context : undefined;
    if (
      context &&
      (isModelMediaTooLargeMarker(stringProperty(context, "type")) ||
        isModelMediaTooLargeMarker(stringProperty(context, "code")) ||
        isModelMediaTooLargeMarker(stringProperty(context, "reason")))
    ) {
      return true;
    }

    current = record.cause ?? record.lastError ?? record.error;
  }

  return false;
}

function isModelMediaTooLargeMarker(value: string | undefined): boolean {
  return value !== undefined && MODEL_MEDIA_TOO_LARGE_MARKERS.has(value.trim().toLowerCase());
}

/**
 * HTTP 413「请求体字节超限」判定——与 token 上下文超限是两条独立失败路径。
 *
 * 机制参照 jcode (MIT) crates/jcode-compaction-core/src/lib.rs:602-631
 * （is_request_payload_too_large_error + contains_independent_status_code），自撰实现。
 *
 * 413 由序列化后的请求体字节数触发（几乎总是内联 base64 媒体），token 会计有意不按 base64
 * 长度计费，所以 `isModelContextExceededError` 与 `isModelMediaTooLargeError` 都不会命中它：
 * adapter 把 413 归一成 `MODEL_REQUEST_FAILED` + `reason: unknown`（不可重试），
 * 只把真实状态码留在 `context.statusCode`（`adapters/src/model/runner-retry.ts:136`）。
 * 恢复动作见 `compact/payload-recovery.ts`（逐级收缩媒体字节预算后重试）。
 */
export function isModelRequestPayloadTooLargeError(error: unknown): boolean {
  let current = error;
  const seen = new WeakSet<object>();

  for (let depth = 0; depth <= 6; depth += 1) {
    if (current === undefined || current === null) return false;
    if (typeof current !== "object") return false;
    if (seen.has(current)) return false;
    seen.add(current);

    const record = current as Record<string, unknown>;
    if (isPayloadTooLargeStatusRecord(record)) return true;
    if (
      isModelRequestPayloadTooLargeMarker(stringProperty(record, "type")) ||
      isModelRequestPayloadTooLargeMarker(stringProperty(record, "code")) ||
      isModelRequestPayloadTooLargeMarker(stringProperty(record, "reason")) ||
      isModelRequestPayloadTooLargeMarker(stringProperty(record, "stopReason")) ||
      isModelRequestPayloadTooLargeMessage(stringProperty(record, "message"))
    ) {
      return true;
    }

    const context = isPlainRecord(record.context) ? record.context : undefined;
    if (
      context &&
      (isPayloadTooLargeStatusRecord(context) ||
        isModelRequestPayloadTooLargeMarker(stringProperty(context, "type")) ||
        isModelRequestPayloadTooLargeMarker(stringProperty(context, "code")) ||
        isModelRequestPayloadTooLargeMarker(stringProperty(context, "reason")) ||
        isModelRequestPayloadTooLargeMessage(stringProperty(context, "message")))
    ) {
      return true;
    }

    current = record.cause ?? record.lastError ?? record.error;
  }

  return false;
}

const HTTP_PAYLOAD_TOO_LARGE_STATUS = 413;

/** 归一化边界上可能承载 HTTP 状态码的字段名（adapter 与 provider 业务错误各用不同键）。 */
const PAYLOAD_TOO_LARGE_STATUS_KEYS = [
  "statusCode",
  "responseStatus",
  "httpStatus",
  "httpStatusCode",
  "httpResponseStatus",
  "status",
] as const;

const MODEL_REQUEST_PAYLOAD_TOO_LARGE_MARKERS = new Set<string>([
  "request_too_large",
  "payload_too_large",
  "request_entity_too_large",
  "request_payload_too_large",
  "http_413",
]);

const MODEL_REQUEST_PAYLOAD_TOO_LARGE_MESSAGE_PATTERNS = [
  "payload too large",
  "request too large",
  "request entity too large",
  "request body too large",
  "request exceeds the maximum size",
  "exceeds the maximum size",
];

/**
 * 裸「413」只在 HTTP/体积语境下才算字节超限。
 * jcode 直接匹配独立 413；ACode 的 token 超窗文案里也可能出现三位数
 * （如 `prompt is too long: 413 tokens > 200 maximum`），误判会把 token 轨道的
 * 丢轮次恢复换成媒体剥离，因此这里额外要求一个体积/状态语境词。
 */
const PAYLOAD_TOO_LARGE_MESSAGE_CONTEXT_WORDS = [
  "http",
  "status",
  "payload",
  "entity",
  "body",
  "size",
  "bytes",
];

function isPayloadTooLargeStatusRecord(record: Record<string, unknown>): boolean {
  return PAYLOAD_TOO_LARGE_STATUS_KEYS.some(
    (key) => numberProperty(record, key) === HTTP_PAYLOAD_TOO_LARGE_STATUS,
  );
}

function isModelRequestPayloadTooLargeMarker(value: string | undefined): boolean {
  return (
    value !== undefined && MODEL_REQUEST_PAYLOAD_TOO_LARGE_MARKERS.has(value.trim().toLowerCase())
  );
}

function isModelRequestPayloadTooLargeMessage(value: string | undefined): boolean {
  const message = value?.trim().toLowerCase();
  if (!message) return false;
  if (
    MODEL_REQUEST_PAYLOAD_TOO_LARGE_MESSAGE_PATTERNS.some((pattern) => message.includes(pattern))
  ) {
    return true;
  }
  return (
    containsIndependentStatusCode(message, String(HTTP_PAYLOAD_TOO_LARGE_STATUS)) &&
    PAYLOAD_TOO_LARGE_MESSAGE_CONTEXT_WORDS.some((word) => message.includes(word))
  );
}

/**
 * `code` 是否作为独立状态码出现，而不是更长数字的片段（"413" 命中，"4130"/"41300" 不命中）。
 * 与 jcode `contains_independent_status_code` 同口径：前后都不得紧邻 ASCII 数字。
 */
function containsIndependentStatusCode(haystack: string, code: string): boolean {
  let fromIndex = 0;
  while (fromIndex <= haystack.length - code.length) {
    const start = haystack.indexOf(code, fromIndex);
    if (start < 0) return false;
    const before = start === 0 ? undefined : haystack[start - 1];
    const after = haystack[start + code.length];
    const isDigit = (value: string | undefined): boolean =>
      value !== undefined && value >= "0" && value <= "9";
    if (!isDigit(before) && !isDigit(after)) return true;
    fromIndex = start + 1;
  }
  return false;
}

function numberProperty(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.trunc(value);
}

function isModelContextExceededMessage(value: string | undefined): boolean {
  const message = value?.trim().toLowerCase();
  if (!message) return false;
  return (
    (message.includes("context") && message.includes("exceed")) ||
    (message.includes("context") && message.includes("too long")) ||
    (message.includes("prompt") && message.includes("too long"))
  );
}

function isModelMediaTooLargeMessage(value: string | undefined): boolean {
  const message = value?.trim().toLowerCase();
  if (!message) return false;
  return (
    (message.includes("media") || message.includes("image") || message.includes("document")) &&
    (message.includes("too large") || message.includes("exceed"))
  );
}
