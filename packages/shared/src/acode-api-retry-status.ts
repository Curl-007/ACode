import type {
  ACodeApiRetrySlotValue,
  ACodeApiRetryStatus,
  ACodeAutoResumeStatus,
} from "./acode-task-types-core.js";

export function normalizeACodeApiRetryStatus(
  value: unknown,
): ACodeApiRetrySlotValue | null | undefined {
  if (value === null) {
    return null;
  }
  const record = asRecord(value);
  if (Object.keys(record).length === 0) {
    return undefined;
  }
  // auto_resume 变体保 kind（specs/turn-auto-resume.md「状态上报」）：压扁成 api_retry
  // 会丢 resumeDelayMs/maxResumes 语义，UI 呈现分支按 kind 区分文案。
  if (stringValue(record.kind) === "auto_resume") {
    const resumeAttempt = positiveIntegerValue(record.attempt) ?? 1;
    return {
      kind: "auto_resume",
      attempt: resumeAttempt,
      maxResumes: Math.max(
        positiveIntegerValue(record.maxResumes) ?? resumeAttempt,
        resumeAttempt,
      ),
      resumeDelayMs: nonNegativeIntegerValue(record.resumeDelayMs) ?? 0,
      errorStatus: nonNegativeIntegerValue(record.errorStatus) ?? null,
      error: stringValue(record.error) ?? "Auto-resume scheduled",
    };
  }
  const attempt =
    positiveIntegerValue(record.attempt) ??
    Math.max((positiveIntegerValue(record.nextAttempt) ?? 2) - 1, 1);
  const maxRetries = Math.max(
    nonNegativeIntegerValue(record.maxRetries) ??
      (positiveIntegerValue(record.maxAttempts) ?? attempt + 1) - 1,
    attempt,
  );
  return {
    kind: "api_retry",
    attempt,
    maxRetries,
    retryDelayMs:
      nonNegativeIntegerValue(record.retryDelayMs) ?? nonNegativeIntegerValue(record.delayMs) ?? 0,
    errorStatus:
      nonNegativeIntegerValue(record.errorStatus) ??
      nonNegativeIntegerValue(record.statusCode) ??
      null,
    error:
      stringValue(record.error) ??
      stringValue(record.message) ??
      stringValue(record.reason) ??
      "Model retry scheduled",
  };
}

export function acodeApiRetryFromModelNetworkStatusPayload(
  payload: Record<string, unknown>,
): ACodeApiRetrySlotValue | null | undefined {
  const type = stringValue(payload.type);
  if (type === "model_retry_scheduled") {
    return normalizeACodeApiRetryStatus(payload);
  }
  if (type === "model_request_started") {
    const streamRecoveryRetry = acodeApiRetryFromStreamRecoveryPayload(payload.streamRecovery);
    if (streamRecoveryRetry !== undefined) {
      return streamRecoveryRetry;
    }
    if ((positiveIntegerValue(payload.attempt) ?? 1) <= 1) {
      return null;
    }
    // 普通 adapter retry 的 request_started 只代表下一次请求开始，
    // 不代表已经恢复成功；这里保持 undefined，让投影层等首个有效模型进展再清理重试态。
  }
  if (type === "model_request_completed") {
    return null;
  }
  if (type === "model_request_failed" && payload.retryable !== true) {
    return null;
  }
  return undefined;
}

/**
 * 跨回合 auto-resume 状态投影（specs/turn-auto-resume.md「状态上报」）：类型本体
 * 住 acode-task-types-core.ts（apiRetry 槽取值面与 ACodeApiRetryStatus 同址）；
 * 这里只做 payload → 变体的增量投影函数。
 */
export function acodeAutoResumeFromModelNetworkStatusPayload(
  payload: Record<string, unknown>,
): ACodeAutoResumeStatus | undefined {
  if (stringValue(payload.type) !== "auto_resume_scheduled") {
    return undefined;
  }
  const attempt = positiveIntegerValue(payload.attempt) ?? 1;
  return {
    kind: "auto_resume",
    attempt,
    maxResumes: Math.max(positiveIntegerValue(payload.maxAttempts) ?? attempt, attempt),
    resumeDelayMs: nonNegativeIntegerValue(payload.delayMs) ?? 0,
    errorStatus: nonNegativeIntegerValue(payload.statusCode) ?? null,
    error: stringValue(payload.errorSummary) ?? "Auto-resume scheduled",
  };
}

export function isACodeModelRetryRecoveryProgressPayload(
  payload: Record<string, unknown>,
): boolean {
  const kind = stringValue(payload.kind);
  if (kind === "text_delta" || kind === "reasoning_delta") {
    return Boolean(stringValue(payload.delta));
  }
  const toolCallId = stringValue(payload.toolCallId);
  if (!toolCallId) {
    return false;
  }
  if (kind === "tool_input_start" || kind === "tool_input_end" || kind === "tool_call") {
    return true;
  }
  if (kind === "tool_input_delta") {
    return Boolean(stringValue(payload.delta));
  }
  return false;
}

export function acodeApiRetryFromStreamRecoveryPayload(
  value: unknown,
): ACodeApiRetryStatus | undefined {
  const record = asRecord(value);
  const attempt = positiveIntegerValue(record.retryNumber);
  if (attempt === undefined) {
    return undefined;
  }
  // core stream recovery 每次新请求都是 adapter attempt=1，
  // 旧 UI 会误清空重试状态；这里改用 streamRecovery.retryNumber 展示 1/10、2/10。
  return {
    kind: "api_retry",
    attempt,
    maxRetries: Math.max(nonNegativeIntegerValue(record.maxRetries) ?? attempt, attempt),
    retryDelayMs: 0,
    errorStatus: null,
    error: stringValue(record.message) ?? "Model stream recovery retry started",
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function nonNegativeIntegerValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function positiveIntegerValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}
