// 分类器（specs/turn-auto-resume.md「分类」）：结构化闭集主判据，无文本正则。
//
// 判定输入 = turn 失败的结构化归因：coreError.context.reason/retryable/statusCode 经
// projectExecutionErrorPayload 投影成的 ErrorAttribution（reason 已过闭集收窄）+
// CoreErrorType + 结局档位。外部文本永远不进入判定（错误分类闭集纪律 R1）。
import {
  CoreErrorType,
  ModelFailureReason,
  ModelRetryReason,
  SessionErrorClass,
} from "@acode/contracts";
import type {
  AutoResumeClassification,
  AutoResumeFailureFacts,
  AutoResumeSettlement,
} from "./types.js";

/** SessionErrorClass 面的 transient 闭集（spec 分类表）。 */
const TRANSIENT_SESSION_REASONS: readonly string[] = [
  SessionErrorClass.RateLimit,
  SessionErrorClass.Network,
  SessionErrorClass.Timeout,
];

/** SessionErrorClass 面的 permanent 闭集（spec 分类表）。 */
const PERMANENT_SESSION_REASONS: readonly string[] = [
  SessionErrorClass.AuthError,
  SessionErrorClass.ContextExceeded,
  SessionErrorClass.ConfigurationError,
  SessionErrorClass.DiskFull,
];

/**
 * ModelRetryReason/ModelFailureReason 面的 transient token（adapter 把请求面失败
 * 归一成这些 context.reason；与 SessionErrorClass 词表并存，同为闭集成员判定）。
 * auth_refresh / reasoning_signature_repair / offpeak_queued 是请求内即时重试语义，
 * 能走到跨回合面的概率极低，但归类上仍属瞬态请求面，一并收录。
 */
const TRANSIENT_MODEL_REASONS: readonly string[] = [
  ModelRetryReason.RateLimited,
  ModelRetryReason.ProviderOverloaded,
  ModelRetryReason.ServerError,
  ModelRetryReason.NetworkError,
  ModelRetryReason.Timeout,
  ModelRetryReason.StreamIdleTimeout,
  ModelRetryReason.StaleConnection,
  ModelRetryReason.AuthRefresh,
  ModelRetryReason.ReasoningSignatureRepair,
  ModelRetryReason.OffpeakQueued,
];

/**
 * ModelFailureReason 独有的 permanent token：本地配置/凭据/请求体问题不会因等待而自愈。
 * proxy_error / tls_error / unknown 不收录——语义两可的 token 不给 transient 资格，
 * 落到「不干预」档（保守缺席，符合闭集纪律「映射不了就不猜」）。
 */
const PERMANENT_MODEL_REASONS: readonly string[] = [
  ModelFailureReason.AuthFailed,
  ModelFailureReason.ContextExceeded,
  ModelFailureReason.InvalidRequest,
  ModelFailureReason.ProviderNotConfigured,
];

/** 预算结局档位（TurnResultType 闭集子集）：预算结局不是故障恢复面。 */
const BUDGET_RESULT_TYPES: readonly string[] = [
  "error_max_turns",
  "error_max_budget",
  "error_max_tool_calls",
];

export function isAutoResumeBudgetResultType(resultType: string): boolean {
  return BUDGET_RESULT_TYPES.includes(resultType);
}

/** 成功/取消结局 → 计数清零档（coordinator 据此重置）。 */
export function settlementClassification(
  settlement: AutoResumeSettlement,
): AutoResumeClassification {
  return settlement === "budget" ? { kind: "budget" } : { kind: "none" };
}

/**
 * turn 失败的结构化分类。优先级（spec 分类表 + 「retryable:false 优先」）：
 * 1. 显式 retryable:false → permanent（wrapper 的默认 false 不会进 attribution——
 *    projectExecutionErrorPayload 只收非 wrapper frame 与 context 显式布尔）；
 * 2. permanent 闭集 reason / CoreErrorType → permanent；
 * 3. transient 闭集 reason → transient；
 * 4. model_error（reason 或 CoreErrorType）且 retryable ≠ false → transient；
 * 5. 其余（含归因缺席的 unknown_error、工具/权限/存储错误）→ 不干预。
 */
export function classifyAutoResumeFailure(facts: AutoResumeFailureFacts): AutoResumeClassification {
  const { attribution, coreErrorType } = facts;
  const reason = attribution?.reason;

  if (coreErrorType === CoreErrorType.TurnCancelled) {
    return { kind: "none" };
  }
  if (attribution?.retryable === false) {
    return { kind: "permanent" };
  }
  if (reason && PERMANENT_SESSION_REASONS.includes(reason)) {
    return { kind: "permanent" };
  }
  if (reason && PERMANENT_MODEL_REASONS.includes(reason)) {
    return { kind: "permanent" };
  }
  if (
    coreErrorType === CoreErrorType.ModelContextExceeded ||
    coreErrorType === CoreErrorType.ConfigurationError
  ) {
    return { kind: "permanent" };
  }
  if (reason && TRANSIENT_SESSION_REASONS.includes(reason)) {
    return transientClassification(facts);
  }
  if (reason && TRANSIENT_MODEL_REASONS.includes(reason)) {
    return transientClassification(facts);
  }
  if (
    coreErrorType === CoreErrorType.ModelRateLimited ||
    coreErrorType === CoreErrorType.ModelTimeout
  ) {
    return transientClassification(facts);
  }
  // model_error 档的「retryable ≠ false」由函数开头的 retryable:false → permanent
  // 早退保证，走到这里 retryable 只可能是 true/undefined（缺席不剥夺 transient 资格）。
  if (reason === SessionErrorClass.ModelError || coreErrorType === CoreErrorType.ModelError) {
    return transientClassification(facts);
  }
  // adapter 权威判定兜底（E2E D2 实测回归）：真实网络/限流故障经 AiSdkModelAdapterError
  // → UnknownError 包装 + narrowErrorReasonToClosedToken 投影，"network_error"/
  // "rate_limited"/"server_error" 等 adapter token 会在闭集收窄边界丢失（attribution
  // .reason 缺席），但 retryable 是 failure-classifier 按状态码/错误类闭集映射出的
  // 结构化判定、随归因存活。置于全部 permanent 早退之后：permanent 分类不会被覆盖，
  // retryable 缺席时保守不猜（仍走「不干预」档）。
  if (attribution?.retryable === true) {
    return transientClassification(facts);
  }
  return { kind: "none" };
}

function transientClassification(facts: AutoResumeFailureFacts): AutoResumeClassification {
  return {
    kind: "transient",
    errorSummary: buildErrorSummary(facts),
    signature: buildErrorSignature(facts),
  };
}

/** 循环守卫签名：相同 reason+statusCode+providerCode 视为同一故障重复出现。 */
function buildErrorSignature(facts: AutoResumeFailureFacts): string {
  const reason = facts.attribution?.reason ?? facts.coreErrorType;
  const statusCode = facts.attribution?.statusCode ?? "";
  const providerCode = facts.attribution?.providerErrorCode ?? "";
  return `${reason}|${statusCode}|${providerCode}`;
}

/** 上报摘要只拼闭集 token 与状态码，不透传 provider 自由文本。reason 被投影边界
 * 收窄丢弃时退到 source 闭集词（"network" 等），比 unknown_error 更可诊断。 */
function buildErrorSummary(facts: AutoResumeFailureFacts): string {
  const reason = facts.attribution?.reason ?? facts.attribution?.source ?? facts.coreErrorType;
  const statusCode = facts.attribution?.statusCode;
  return statusCode === undefined ? reason : `${reason} (HTTP ${statusCode})`;
}
