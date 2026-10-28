// ============================================================
// Session Event supporting types - attachment / message / tool / usage / error
// ============================================================
// 例外债务偿还（2026-10-28，batch B）：session.events.ts（1373 行）按主题拆叶，
// 本文件承载跨 payload 复用的支撑类型（原文件末尾的 Supporting Types 节）。
// 依赖方向（DAG）：shared.js / tools/tool-result-metadata / tools/performance /
// telemetry/observations → 本文件 → turn/model/tool 等 payload 叶 → factory 叶 → 桶。
// 注：原文件 ToolResultPayload.perf 用 inline import("../tools/performance.js") 形态，
// 拆叶后统一为顶层 import type（语义不变）。

import type { ToolCallId } from "../interfaces/shared.js";
import type { ToolResultDisplayPayload } from "../tools/tool-result-metadata.js";
import type { ToolExecutionTelemetry } from "../tools/performance.js";
// 观测词汇走 telemetry 叶子文件（telemetry/index 反向引用 model 侧类型，桶级互指即成环）。
import type { ModelApiErrorPhase, ModelFailureExceptionKind } from "../telemetry/observations.js";

export interface Attachment {
  type: "file" | "image" | "pdf" | "url";
  path?: string;
  content?: string;
  mimeType?: string;
}

export interface ModelMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: ToolCallPayload[];
  toolCallId?: string;
}

export interface ToolCallPayload {
  id: ToolCallId;
  name: string;
  input: unknown;
}

export interface ToolResultPayload {
  success: boolean;
  content: string;
  display?: ToolResultDisplayPayload;
  perf?: ToolExecutionTelemetry;
  error?: ErrorPayload;
  truncated?: boolean;
  originalBytes?: number;
  returnedBytes?: number;
  budgetStrategy?: string;
  artifactPath?: string;
}

export interface ToolSchedulePayload {
  parallelGroups: ToolCallId[][];
  executionOrder: ToolCallId[];
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheTokens?: number;
}

export interface ErrorPayload {
  code?: string;
  detail?: string;
  /** 错误链中最深的非 wrapper frame 的原始 message，供客户端 telemetry 定位根因。 */
  underlyingErrorMessage?: string;
  /** 同一底层 frame 的 detail/errorDetails/details 内容。 */
  underlyingErrorDetail?: string;
  type: string;
  message: string;
  attribution?: ErrorAttribution;
  retryable?: boolean;
  stack?: string;
  data?: unknown;
}

/** 只承载可聚合的失败事实，不包含请求正文、凭据、URL 或监控策略。 */
export interface ErrorAttribution {
  source?: "provider" | "runtime" | "tool" | "network";
  reason?: string;
  errorPhase?: ModelApiErrorPhase;
  exceptionKind?: ModelFailureExceptionKind;
  providerId?: string;
  modelId?: string;
  providerKind?: string;
  transport?: "http" | "sse" | "websocket";
  statusCode?: number;
  providerErrorCode?: string;
  retryable?: boolean;
}
