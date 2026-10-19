/**
 * Span 起点属性构造 + 跨进程因果（causation）映射
 * （specs/otel-telemetry.md「属性白名单」「Span 层级与命名」）。
 *
 * 从 spans.ts 拆出的纯构造层：writer 只负责生命周期，属性键值全部在这里
 * 集中登记，便于白名单单测逐键对照。所有返回值仍需经 attributes.ts 的
 * `whitelisted()` 过滤后才写入 span（双保险）。
 *
 * 本文件只在懒加载图内被 import，默认启动路径不加载。
 */
import type { Link, SpanContext } from "@opentelemetry/api";
import type {
  AgentStepTraceStart,
  AgentTelemetryCausation,
  AgentTurnTraceStart,
  CompactionTraceStart,
  DetachedOperationTraceStart,
  ToolTraceStart,
} from "@acode/contracts";
import {
  ATTR_GEN_AI_AGENT_NAME,
  ATTR_GEN_AI_CONVERSATION_ID,
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_GEN_AI_PROVIDER_NAME,
  ATTR_GEN_AI_REQUEST_MODEL,
  ATTR_GEN_AI_RESPONSE_FINISH_REASONS,
  ATTR_GEN_AI_TOOL_CALL_ID,
  ATTR_GEN_AI_TOOL_NAME,
  ATTR_GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_OUTPUT_TOKENS,
  ATTR_GEN_AI_USAGE_REASONING_OUTPUT_TOKENS,
} from "@opentelemetry/semantic-conventions/incubating";
import type { ModelRequestTelemetryFact } from "./model-request-fact.js";
import { GEN_AI_OPERATION, type WhitelistAttributeValue } from "./attributes.js";

/** contracts 因果引用 → OTel SpanContext（字段保持 OTel 原义）。 */
export function causationSpanContext(causation: AgentTelemetryCausation): SpanContext {
  return {
    isRemote: causation.isRemote,
    spanId: causation.spanId,
    traceFlags: causation.traceFlags,
    traceId: causation.traceId,
    // traceState 不透传：contracts 侧是裸 string，OTel TraceState 是结构化接口；
    // 采样决策相关字段丢失只影响下游采样透传，不影响因果连接（登记为限制）。
  };
}

/** linked_root 模式的 Link 构造（根 span + 指向因果来源的 Link）。 */
export function causationLinks(
  causation: AgentTelemetryCausation | undefined,
): Link[] | undefined {
  if (!causation) return undefined;
  return [{ context: causationSpanContext(causation) }];
}

/** 各 span 的起点属性构造（全部过白名单）。 */
export function turnStartAttributes(
  input: AgentTurnTraceStart,
): Record<string, WhitelistAttributeValue> {
  const context = input.context;
  return {
    [ATTR_GEN_AI_OPERATION_NAME]: GEN_AI_OPERATION.invokeAgent,
    [ATTR_GEN_AI_CONVERSATION_ID]: context.sessionId,
    "acode.session.id": context.sessionId,
    "acode.turn.id": context.turnId,
    "acode.turn.number": input.turnNumber,
    "acode.query.id": context.queryId,
    "acode.actor.kind": context.actorKind,
    "acode.launch.surface": context.launchSurface,
    "acode.input.source": input.inputSource ?? "user",
    "acode.parent.session.id": context.parentSessionId,
    "acode.parent.turn.id": context.parentTurnId,
    ...(context.agentName
      ? { [ATTR_GEN_AI_AGENT_NAME]: context.agentName, "acode.agent.name": context.agentName }
      : {}),
  };
}

export function stepStartAttributes(
  input: AgentStepTraceStart,
): Record<string, WhitelistAttributeValue> {
  return {
    [ATTR_GEN_AI_OPERATION_NAME]: GEN_AI_OPERATION.agentStep,
    "acode.step.id": input.stepId,
    "acode.step.index": input.stepIndex,
  };
}

export function toolStartAttributes(
  input: ToolTraceStart,
): Record<string, WhitelistAttributeValue> {
  return {
    [ATTR_GEN_AI_OPERATION_NAME]: GEN_AI_OPERATION.executeTool,
    [ATTR_GEN_AI_TOOL_NAME]: input.registeredToolName,
    [ATTR_GEN_AI_TOOL_CALL_ID]: input.toolCallId,
  };
}

export function compactionStartAttributes(
  input: CompactionTraceStart,
): Record<string, WhitelistAttributeValue> {
  return {
    [ATTR_GEN_AI_OPERATION_NAME]: GEN_AI_OPERATION.contextCompaction,
    "acode.compaction.phase": input.phase,
    "acode.compaction.trigger": input.trigger,
    "acode.compaction.model_mode": input.modelMode,
    "acode.compaction.threshold_tokens": input.thresholdTokens,
    "acode.compaction.policy_context_window_tokens": input.policyContextWindowTokens,
    "acode.compaction.token_source": input.tokenSource,
    "acode.compaction.max_attempts": input.maxAttempts,
    "acode.compaction.outer_attempt": input.outerAttempt,
    "acode.compaction.triggering_step_index": input.triggeringStepIndex,
  };
}

export function detachedStartAttributes(
  input: DetachedOperationTraceStart,
): Record<string, WhitelistAttributeValue> {
  return {
    [ATTR_GEN_AI_OPERATION_NAME]: input.operation,
    "acode.session.id": input.context.sessionId,
    "acode.turn.id": input.context.turnId,
    "acode.operation.execution_kind": input.executionKind,
    "acode.operation.trigger": input.trigger,
    "acode.operation.target_kind": input.targetKind,
    "acode.operation.chunk_index": input.chunkIndex,
    "acode.operation.chunk_count": input.chunkCount,
    "acode.operation.goal_iteration": input.goalIteration,
  };
}

/** 模型请求事实 → chat span 属性（白名单内；errorMessage 刻意排除）。 */
export function modelRequestAttributes(
  fact: ModelRequestTelemetryFact,
): Record<string, WhitelistAttributeValue> {
  return {
    [ATTR_GEN_AI_OPERATION_NAME]: GEN_AI_OPERATION.chat,
    [ATTR_GEN_AI_PROVIDER_NAME]: fact.providerId,
    [ATTR_GEN_AI_REQUEST_MODEL]: fact.modelId,
    [ATTR_GEN_AI_USAGE_INPUT_TOKENS]: fact.inputTokens,
    [ATTR_GEN_AI_USAGE_OUTPUT_TOKENS]: fact.outputTokens,
    [ATTR_GEN_AI_USAGE_REASONING_OUTPUT_TOKENS]: fact.reasoningTokens,
    [ATTR_GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS]: fact.cacheReadTokens,
    [ATTR_GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS]: fact.cacheWriteTokens,
    ...(fact.finishReason ? { [ATTR_GEN_AI_RESPONSE_FINISH_REASONS]: [fact.finishReason] } : {}),
    "acode.query.source": fact.querySource,
    "acode.request.status": fact.status,
    "acode.request.duration_ms": fact.durationMs,
    "acode.request.ttft_ms":
      fact.firstTokenAt !== undefined
        ? Math.max(0, fact.firstTokenAt - fact.startedAt)
        : undefined,
    "acode.request.retry_count": fact.retryCount,
    "acode.request.context_exceeded": fact.contextExceeded,
    "acode.request.tool_call_count": fact.toolCallCount,
    "acode.reasoning.level": fact.reasoningLevel,
    "acode.error.type": fact.errorType,
    "acode.error.code": fact.errorCode,
    ...(fact.status === "cancelled" ? { "acode.cancellation.reason": "user" } : {}),
  };
}
