// ============================================================
// Model request governance types - status events / admission / retry
// ============================================================
// 架构断环下沉（specs/architecture-contracts-module.md）：model/invocation-context.ts
// 与 telemetry/index.ts 需要引用这里的准入/状态汇/重试预算类型，而 model/index.ts 又
// `export * from` invocation-context、telemetry/index.ts 被 model/index.ts 引用，
// 构成文件级 import 环。把被反向引用的定义下沉到本文件断环；model/index.ts 原样
// 再导出（export *），包导出面逐名不变。
//
// 依赖方向约束：本文件只允许依赖 interfaces/shared（id 词汇）、./protocol-types
// （基础模型类型）与 telemetry/observations（观测词汇叶子），不得导入 model/index.ts
// 或 telemetry/index.ts，否则环会重新闭合。

import type { QueryId, SessionId, TraceId, TurnId } from "../interfaces/shared.js";
import type {
  ModelApiErrorPhase,
  ResolvedModelApiCallObservation,
} from "../telemetry/observations.js";
import type { ModelId, ModelProviderId, ModelUsage } from "./protocol-types.js";

export const ModelRequestSessionType = {
  Main: "main",
  Other: "other",
  Subagent: "subagent",
} as const;

/**
 * 模型请求的重试预算档位（runtime-only）。
 * - `default`：adapter 构造时解析出的 maxAttempts（默认 10 次重试）。
 * - `unbounded`：**瞬态**失败无上限重试（退避曲线不变、封顶 60s 后无限探测），永久失败照旧立即抛。
 *   给 workflow actor（taskType workflow_child / nested_workflow_child）使用：模型错误绝不是
 *   workflow 错误，唯一出口是用户 cancel。
 */
export const ModelRetryBudget = {
  Default: "default",
  Unbounded: "unbounded",
} as const;

export type ModelRetryBudget = (typeof ModelRetryBudget)[keyof typeof ModelRetryBudget];

/**
 * 一次模型请求尝试的准入票据（runtime-only）。
 *
 * 它同时是**这一次尝试**的状态事件汇：runner 把该尝试的 ModelNetworkStatus 事件
 * （`model_request_started` / `model_request_completed` / `model_request_failed` /
 * `model_retry_scheduled`）原样也投递给它，治理器据此判定这次请求的结果（成功 / 限流 / 瞬态失败 /
 * 终结），不需要 runner 在每个失败分支上另写一遍结果。`release()` 是兜底：尝试无论如何结束（成功、
 * 抛出、消费者提前放弃流）runner 都在 finally 里调一次；未见终结事件即按终结处理。**幂等**。
 */
export interface ModelRequestAdmissionTicket extends ModelStatusSink {
  release(): void;
}

/**
 * 模型请求的准入端口（runtime-only）。runner 在**每一次尝试发出前**先试同步快路径
 * `tryAcquire`，未命中再 `acquire` 排队；拿到票据后才发请求；尝试结束即 `release`，退避 sleep 期间
 * 不持票——所以进程级并发 cap 约束的是 provider 真正看到的在飞请求数。`signal` 被 abort 时
 * `acquire` 以 `signal.reason` reject。
 *
 * `tryAcquire` 未命中是 runner 发 `model_request_queued` / `model_request_admitted` 的唯一依据
 * 没有快路径的实现 runner 无法分辨「排了队」与「立即放行」，一律不发这两条事件。
 *
 * 端口绑定在 runtime 的模型工厂上：runtime 交出的每一个模型句柄——turn step、工具内部
 * 的模型调用、压缩、标题 sidecar——都带它；缺席即不设闸门（runner 行为逐字不变）。主代理拿的是
 * 治理器的 observer 实现：`tryAcquire` 总命中、只喂信号。
 */
export interface ModelRequestAdmission {
  /** 同步快路径：闸门开着且无人排队即给票；否则 undefined，runner 转 `acquire` 并报排队。 */
  tryAcquire?(input: { model: ModelRequestTarget }): ModelRequestAdmissionTicket | undefined;
  acquire(input: {
    model: ModelRequestTarget;
    signal?: AbortSignal;
  }): Promise<ModelRequestAdmissionTicket>;
  /**
   * D5 并发只读诊断投影（`specs/concurrency-diagnostics-projection.md` R4）：返回全部治理桶
   * （每个 provider key 一桶）的只读快照。**纯投影**——实现不得因它改变任何准入决策，也不得
   * 因此新增状态。可选成员（先例：`tryAcquire?`、`DynamicWorkflowRunPort.concurrencyCeiling?`）：
   * 缺席 = 宿主未装配投影面，消费方（runtime 诊断面）投影「未知」，不得猜测。
   */
  concurrencyBuckets?(): ModelRequestAdmissionBucketSnapshot[];
}

/**
 * 一个 provider key 治理桶的只读事实（D5 投影的最小形状，字段口径见
 * `specs/concurrency-diagnostics-projection.md` R1/R3）。刻意是 `ConcurrencyControllerSnapshot`
 * 的收窄投影：诊断面只要 caps/current/degraded 能算出来的那几个数，epoch/streak 等控制器
 * 内部状态不外泄到跨包契约上。
 */
export interface ModelRequestAdmissionBucketSnapshot {
  /** provider key：`${providerId}/${modelId}`。 */
  key: string;
  /** CPU 推导天花板（桶的初值与上界）。 */
  ceiling: number;
  /** AIMD 当前并发 cap。 */
  cap: number;
  /** 已准入未结算的模型请求数。 */
  inFlight: number;
  /** 排队等待准入的请求数。 */
  waiters: number;
  /** Retry-After 冷却截止（ms epoch）；缺席 = 不在冷却。 */
  cooldownUntil?: number;
}

/**
 * 准入端口看到的模型身份：配额键的最小事实。既不是 Selection（那是执行意图），也不是
 * Active Model（那带完整配置）——treaty 只要 provider/model 两段。
 */
export interface ModelRequestTarget {
  providerId: string;
  modelId: string;
}

export type ModelRequestSessionType =
  (typeof ModelRequestSessionType)[keyof typeof ModelRequestSessionType];

export const ModelErrorCode = {
  InvalidModelSelection: "invalid_model_selection",
  ModelConfigMissing: "model_config_missing",
  ProviderNotFound: "provider_not_found",
  ProviderNotConfigured: "provider_not_configured",
  ModelNotFound: "model_not_found",
  InvalidModelRequest: "invalid_model_request",
  InvalidModelResponse: "invalid_model_response",
  ModelRequestFailed: "model_request_failed",
  ModelRequestAuthMissing: "model_request_auth_missing",
  ModelRequestCancelled: "model_request_cancelled",
  ModelRequestTimeout: "model_request_timeout",
  ModelRateLimited: "model_rate_limited",
  ModelContextExceeded: "model_context_exceeded",
} as const;

export type ModelErrorCode = (typeof ModelErrorCode)[keyof typeof ModelErrorCode];

export const ModelTransportKind = {
  Http: "http",
  Sse: "sse",
  WebSocket: "websocket",
} as const;

export type ModelTransportKind = (typeof ModelTransportKind)[keyof typeof ModelTransportKind];

export const ModelRetryReason = {
  RateLimited: "rate_limited",
  ProviderOverloaded: "provider_overloaded",
  ServerError: "server_error",
  NetworkError: "network_error",
  Timeout: "timeout",
  StreamIdleTimeout: "stream_idle_timeout",
  StaleConnection: "stale_connection",
  AuthRefresh: "auth_refresh",
  /** Anthropic 明确拒绝历史 thinking signature 后，对请求副本清理并立即重试一次。 */
  ReasoningSignatureRepair: "reasoning_signature_repair",
  /** off-peak 闲时排队（429/3105+Retry-After）：豁免重试预算、无限探测（仅 idle plan provider）。 */
  OffpeakQueued: "offpeak_queued",
} as const;

export type ModelRetryReason = (typeof ModelRetryReason)[keyof typeof ModelRetryReason];

export const ModelFailureReason = {
  ...ModelRetryReason,
  AuthFailed: "auth_failed",
  Cancelled: "cancelled",
  ContextExceeded: "context_exceeded",
  InvalidRequest: "invalid_request",
  ProviderNotConfigured: "provider_not_configured",
  ProxyError: "proxy_error",
  TlsError: "tls_error",
  Unknown: "unknown",
} as const;

export type ModelFailureReason = (typeof ModelFailureReason)[keyof typeof ModelFailureReason];

interface ModelNetworkStatusBase {
  timestamp: string;
  traceId: TraceId;
  queryId?: QueryId;
  sessionId?: SessionId;
  turnId?: TurnId;
  parentSessionId?: SessionId;
  toolCallId?: string;
  spanId?: string;
  parentSpanId?: string;
  querySource?: string;
  requestId: string;
  providerId: ModelProviderId;
  modelId: ModelId;
  baseURL?: string;
  providerKind?: string;
  transport: ModelTransportKind;
  attempt: number;
  /**
   * 本次请求的重试预算总尝试数（含首次）。**`0` = 无上限**（`ModelRetryBudget.Unbounded`）：`Infinity` 不可序列化，而 0 不占用任何既有合法值。
   * 消费方渲染「第 n/N 次」或推导 maxRetries 时必须特判 0。
   */
  maxAttempts: number;
  streamRecovery?: ModelStreamRecoveryStatus;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  requestHeaderCount?: number;
  responseHeaderCount?: number;
  modelCall?: ResolvedModelApiCallObservation;
}

export interface ModelStreamRecoveryStatus {
  attemptId: string;
  retryNumber: number;
  maxRetries: number;
  recoveredFromRequestId?: string;
  anchorId?: string;
}

export interface ModelRequestStartedStatusEvent extends ModelNetworkStatusBase {
  type: "model_request_started";
}

/**
 * 准入等待的两端：runner 的 `tryAcquire` 未命中
 * 即发 `queued`，拿到票即发 `admitted`（带排队时长）。它们是 runtime 观测——driver 据此报「等待槽位」，
 * 工具执行器据此暂停工具超时——不进 provider 请求；协议侧凡枚举状态类型的消费方显式忽略。
 */
export interface ModelRequestQueuedStatusEvent extends ModelNetworkStatusBase {
  type: "model_request_queued";
}

export interface ModelRequestAdmittedStatusEvent extends ModelNetworkStatusBase {
  type: "model_request_admitted";
  queuedMs: number;
}

export interface ModelRequestCompletedStatusEvent extends ModelNetworkStatusBase {
  type: "model_request_completed";
  durationMs: number;
  finishReason?: string;
  usage?: ModelUsage;
  providerRequestId?: string;
  timeToFirstProviderEventMs?: number;
  timeToFirstContentMs?: number;
  timeToFirstTextMs?: number;
  streamMaxIdleMs?: number;
  streamStallCount?: number;
  streamOutputCommitted?: boolean;
}

export interface ModelRequestFailedStatusEvent extends ModelNetworkStatusBase {
  type: "model_request_failed";
  durationMs?: number;
  reason: ModelFailureReason;
  retryable: boolean;
  message: string;
  statusCode?: number;
  errorCode?: ModelErrorCode;
  providerErrorCode?: string;
  providerErrorMessage?: string;
  providerRequestId?: string;
  retryAfterMs?: number;
  errorPhase?: ModelApiErrorPhase;
  exceptionType?: string;
  streamOutputCommitted?: boolean;
}

export interface ModelRetryScheduledStatusEvent extends ModelNetworkStatusBase {
  type: "model_retry_scheduled";
  delayMs: number;
  nextAttempt: number;
  reason: ModelRetryReason;
  message: string;
  statusCode?: number;
  errorCode?: ModelErrorCode;
  providerErrorCode?: string;
  providerErrorMessage?: string;
  providerRequestId?: string;
  retryAfterMs?: number;
}

export interface ModelStreamStalledStatusEvent extends ModelNetworkStatusBase {
  type: "model_stream_stalled";
  idleMs: number;
  timeoutMs: number;
  message: string;
}

/**
 * 仅供实时观测 Sink 消费的 Provider 里程碑。它们不进入 SessionEvent/回放协议，
 * 避免为了 Trace 事件扩大产品状态面。
 */
export interface ModelTelemetryMilestoneStatusEvent extends ModelNetworkStatusBase {
  type: "model_first_provider_event" | "model_first_content" | "model_first_text";
  elapsedMs: number;
}

export type ModelNetworkStatusEvent =
  | ModelRequestQueuedStatusEvent
  | ModelRequestAdmittedStatusEvent
  | ModelRequestStartedStatusEvent
  | ModelRequestCompletedStatusEvent
  | ModelRequestFailedStatusEvent
  | ModelRetryScheduledStatusEvent
  | ModelStreamStalledStatusEvent
  | ModelTelemetryMilestoneStatusEvent;

export interface ModelStatusSink {
  publish(event: ModelNetworkStatusEvent): void | Promise<void>;
  /**
   * Transport 捕获失败时可把原始异常直接交给进程级观测 Sink。产品 SessionEvent/日志仍只消费
   * publish(event)，避免原始异常对象和消息正文进入持久化领域状态。
   */
  publishFailure?(event: ModelRequestFailedStatusEvent, error: unknown): void | Promise<void>;
}
