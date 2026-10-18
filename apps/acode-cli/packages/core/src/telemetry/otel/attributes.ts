/**
 * Span 属性白名单构造（specs/otel-telemetry.md「属性白名单（隐私红线）」）。
 *
 * 隐私红线：span 属性绝不携带提示词正文、模型输出、工具参数、文件内容、命令全文、
 * 凭据。实现上采用**封闭白名单**——只有登记在册的键能通过 `whitelisted()` 进入
 * span，非白名单键在构造层直接丢弃；值只接受原始类型（string/number/boolean）与
 * 字符串数组，对象/函数一律拒绝，杜绝「结构化载荷夹带内容」。
 *
 * 属性名对齐 OpenTelemetry GenAI 语义约定（gen_ai.*，常量取自
 * @opentelemetry/semantic-conventions/incubating）；ACode 内部元数据用 acode.* 前缀。
 * 本文件只在懒加载图内被 import（impl/spans），默认启动路径不加载。
 */
import type { Attributes, AttributeValue } from "@opentelemetry/api";
import {
  ATTR_GEN_AI_AGENT_NAME,
  ATTR_GEN_AI_CONVERSATION_ID,
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_GEN_AI_PROVIDER_NAME,
  ATTR_GEN_AI_REQUEST_MODEL,
  ATTR_GEN_AI_RESPONSE_FINISH_REASONS,
  ATTR_GEN_AI_RESPONSE_MODEL,
  ATTR_GEN_AI_TOOL_CALL_ID,
  ATTR_GEN_AI_TOOL_NAME,
  ATTR_GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_OUTPUT_TOKENS,
  ATTR_GEN_AI_USAGE_REASONING_OUTPUT_TOKENS,
} from "@opentelemetry/semantic-conventions/incubating";

/** GenAI 语义约定操作名（semconv 值域）+ ACode 扩展操作名。 */
export const GEN_AI_OPERATION = {
  chat: "chat",
  executeTool: "execute_tool",
  invokeAgent: "invoke_agent",
  agentStep: "agent_step",
  contextCompaction: "context_compaction",
} as const;

/**
 * 封闭白名单：所有允许出现在 span 上的属性键。新增键必须先改
 * specs/otel-telemetry.md 的白名单表，再登记到这里（单测会逐键对照）。
 */
export const SPAN_ATTRIBUTE_WHITELIST: readonly string[] = [
  // GenAI 语义约定（gen_ai.*）
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_GEN_AI_AGENT_NAME,
  ATTR_GEN_AI_CONVERSATION_ID,
  ATTR_GEN_AI_PROVIDER_NAME,
  ATTR_GEN_AI_REQUEST_MODEL,
  ATTR_GEN_AI_RESPONSE_MODEL,
  ATTR_GEN_AI_RESPONSE_FINISH_REASONS,
  ATTR_GEN_AI_TOOL_NAME,
  ATTR_GEN_AI_TOOL_CALL_ID,
  ATTR_GEN_AI_USAGE_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_OUTPUT_TOKENS,
  ATTR_GEN_AI_USAGE_REASONING_OUTPUT_TOKENS,
  ATTR_GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS,
  // ACode 会话/执行元数据（内部不透明 id，无 PII）
  "acode.session.id",
  "acode.turn.id",
  "acode.turn.number",
  "acode.turn.result",
  "acode.query.id",
  "acode.query.source",
  "acode.actor.kind",
  "acode.launch.surface",
  "acode.input.source",
  "acode.parent.session.id",
  "acode.parent.turn.id",
  "acode.agent.name",
  // step
  "acode.step.id",
  "acode.step.index",
  "acode.step.result",
  // 模型请求
  "acode.request.status",
  "acode.request.duration_ms",
  "acode.request.ttft_ms",
  "acode.request.retry_count",
  "acode.request.context_exceeded",
  "acode.request.tool_call_count",
  "acode.reasoning.level",
  // 工具与命令
  "acode.permission.decision",
  "acode.permission.requested",
  "acode.output.bytes",
  "acode.output.truncated",
  "acode.tool.result",
  "acode.command.safe_name",
  "acode.command.category",
  "acode.command.count",
  "acode.command.shell_kind",
  "acode.command.sandboxed",
  "acode.command.exit_code",
  "acode.command.signal",
  "acode.command.timed_out",
  "acode.command.output_bytes",
  "acode.command.backgrounded",
  "acode.command.termination_reason",
  // compaction
  "acode.compaction.phase",
  "acode.compaction.trigger",
  "acode.compaction.model_mode",
  "acode.compaction.threshold_tokens",
  "acode.compaction.policy_context_window_tokens",
  "acode.compaction.token_source",
  "acode.compaction.fallback_reason",
  "acode.compaction.max_attempts",
  "acode.compaction.outer_attempt",
  "acode.compaction.triggering_step_index",
  "acode.usage.input_tokens",
  "acode.usage.output_tokens",
  // detached 操作
  "acode.operation.execution_kind",
  "acode.operation.trigger",
  "acode.operation.target_kind",
  "acode.operation.chunk_index",
  "acode.operation.chunk_count",
  "acode.operation.goal_iteration",
  "acode.result.type",
  // 终态/错误（枚举与代码级；errorMessage 不在白名单——可能内嵌内容片段）
  "acode.failure.stage",
  "acode.error.category",
  "acode.error.type",
  "acode.error.code",
  "acode.cancellation.reason",
  "acode.abandon.reason",
  "error.type",
] as const;

const WHITELIST_SET: ReadonlySet<string> = new Set(SPAN_ATTRIBUTE_WHITELIST);

/** 候选属性值：只允许原始类型与字符串数组（semconv finish_reasons 形态）。 */
export type WhitelistAttributeValue = string | number | boolean | readonly string[] | undefined;

/**
 * 白名单过滤器：丢弃未登记键与非原始值。所有 span 属性必须经过这里，
 * 这是「属性白名单单测」断言的同一实现面。
 */
export function whitelisted(
  fields: Readonly<Record<string, WhitelistAttributeValue>>,
): Attributes {
  const out: Attributes = {};
  for (const key of Object.keys(fields)) {
    if (!WHITELIST_SET.has(key)) continue;
    const value = fields[key];
    if (value === undefined) continue;
    if (typeof value === "string") {
      if (value.length > 0) out[key] = value;
      continue;
    }
    if (typeof value === "number") {
      if (Number.isFinite(value)) out[key] = value;
      continue;
    }
    if (typeof value === "boolean") {
      out[key] = value;
      continue;
    }
    if (Array.isArray(value)) {
      const items = value.filter((entry): entry is string => typeof entry === "string");
      if (items.length > 0) out[key] = items;
    }
    // 其余类型（对象/函数/符号）一律拒绝：结构化载荷可能夹带内容。
  }
  return out;
}

/**
 * 错误元数据抽取：只保留分类/代码级信息。Error.name 进入 error.type；
 * message/stack 被刻意丢弃——provider 错误消息可能回显提示词片段或路径。
 */
export function errorMetaAttributes(error: unknown): Attributes {
  if (error === undefined || error === null) return {};
  const errorType =
    error instanceof Error && error.name.length > 0 ? error.name : typeof error === "string" ? "string_error" : "unknown";
  return whitelisted({ "error.type": errorType });
}

/** AttributeValue 导出给 spans 层做类型收窄用。 */
export type { AttributeValue };
