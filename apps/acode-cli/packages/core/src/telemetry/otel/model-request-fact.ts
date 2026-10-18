/**
 * 模型请求遥测事实（specs/otel-telemetry.md 属性白名单）。
 *
 * 纯类型 + 纯元数据：绝不携带提示词正文、模型输出、工具参数、文件内容或凭据。
 * 位于默认启动路径静态图（facade 与 usage-observability 都要 import type），
 * 因此本文件不得引入任何 @opentelemetry/* 运行时依赖。
 */

/** 一次模型请求收口后的元数据事实，由 recordModelUsageFact 单一 producer 供给。 */
export interface ModelRequestTelemetryFact {
  /** main_turn / subagent / compact / session_title 等（映射 gen_ai.operation 语义）。 */
  querySource: string;
  providerId: string;
  modelId: string;
  reasoningLevel?: string;
  status: "completed" | "error" | "cancelled";
  /** epoch ms；span 的显式 startTime。 */
  startedAt: number;
  /** epoch ms；span 的显式 endTime。 */
  completedAt: number;
  firstTokenAt?: number;
  durationMs?: number;
  finishReason?: string;
  toolCallCount?: number;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
  retryCount?: number;
  contextExceeded?: boolean;
  /** 错误分类/代码级元数据；errorMessage 被刻意排除（可能内嵌内容片段）。 */
  errorType?: string;
  errorCode?: string;
}

/**
 * 结构化能力探测：OTel port 实现在 AgentExecutionTelemetryPort 之外附加的模型请求
 * 收口方法。NOOP port 没有该方法，facade 转发即静默——contracts 面不改。
 */
export interface ModelRequestTelemetryRecorder {
  recordModelRequest(fact: ModelRequestTelemetryFact): void;
}
