/**
 * OTel span writer 实现（specs/otel-telemetry.md「Span 层级与命名」）。
 *
 * 把既有 AgentExecutionTelemetryPort 契约面（contracts/telemetry/agent-execution）
 * 映射为 GenAI 语义约定 span：turn=invoke_agent、step=agent_step、
 * 工具=execute_tool {name}、命令=command {safeName}、compaction/detached 独立 span
 *（模型请求 chat span 由 impl.ts 以事实回填方式创建，见 recordModelRequest）。
 * 嵌套父子关系依赖各 writer 的 run() 激活 OTel context
 *（AsyncLocalStorageContextManager 在 impl.ts 注册）。
 *
 * 隐私红线：全部属性经 attributes.ts 的封闭白名单过滤；错误只保留 type/code 级
 * 元数据。终态 finish* 幂等（只收口一次），turn 终态触发 onTurnEnd（flush 钩子）。
 * 起点属性构造在 span-attributes.ts（本文件只管生命周期）。
 *
 * 本文件只在懒加载图内被 import，默认启动路径不加载。
 */
import {
  context as contextApi,
  ROOT_CONTEXT,
  SpanStatusCode,
  trace,
  type Context,
  type Span,
  type Tracer,
} from "@opentelemetry/api";
import type {
  AgentStepSpanWriter,
  AgentTelemetryCancellationReason,
  AgentTelemetryCausation,
  AgentTelemetryErrorCategory,
  AgentTurnSpanWriter,
  CommandExecutionSpanWriter,
  CommandFailureStage,
  CommandTraceStart,
  CompactionFailureStage,
  ContextCompactionSpanWriter,
  DetachedFailureStage,
  DetachedOperationSpanWriter,
  StepFailureStage,
  ToolExecutionSpanWriter,
  ToolFailureStage,
  TurnFailureStage,
} from "@acode/contracts";
import {
  errorMetaAttributes,
  whitelisted,
  type WhitelistAttributeValue,
} from "./attributes.js";
import { causationSpanContext } from "./span-attributes.js";

export interface SpanWriterHooks {
  /** turn 终态（完成/失败/取消/abandon）回调：impl 层据此做去抖 forceFlush。 */
  onTurnEnd: () => void;
}

/** 在 span 的 OTel context 内执行（AsyncLocalStorage 传播，嵌套即父子）。 */
function activate<T>(span: Span, execute: () => T): T {
  return contextApi.with(trace.setSpan(contextApi.active(), span), execute);
}

function causationOf(span: Span): AgentTelemetryCausation | undefined {
  const spanContext = span.spanContext();
  if (!spanContext) return undefined;
  return {
    isRemote: false,
    spanId: spanContext.spanId,
    traceFlags: spanContext.traceFlags,
    traceId: spanContext.traceId,
  };
}

/** causation=child：以远端 span context 为父；linked_root/无 causation：另处理。 */
export function remoteParentContext(causation: AgentTelemetryCausation): Context {
  return trace.setSpanContext(ROOT_CONTEXT, causationSpanContext(causation));
}

/** writer 公共骨架：终态幂等收口 + 白名单属性 + 错误只留 type 级元数据。 */
abstract class SpanWriterBase {
  protected finished = false;
  constructor(protected readonly span: Span) {}

  run<T>(execute: () => T): T {
    return activate(this.span, execute);
  }

  captureCausation(): AgentTelemetryCausation | undefined {
    return causationOf(this.span);
  }

  protected setAttrs(fields: Record<string, WhitelistAttributeValue>): void {
    this.span.setAttributes(whitelisted(fields));
  }

  protected finishOnce(
    attrs: Record<string, WhitelistAttributeValue>,
    options?: { error?: unknown; status?: SpanStatusCode },
  ): boolean {
    if (this.finished) return false;
    this.finished = true;
    this.setAttrs(attrs);
    if (options?.error !== undefined) {
      this.span.setAttributes(errorMetaAttributes(options.error));
    }
    this.span.setStatus({
      code: options?.status ?? SpanStatusCode.UNSET,
    });
    this.span.end();
    return true;
  }
}

export class TurnSpanWriter extends SpanWriterBase implements AgentTurnSpanWriter {
  constructor(
    span: Span,
    private readonly hooks: SpanWriterHooks,
    private readonly onAbandoned?: () => void,
  ) {
    super(span);
  }

  finishCompleted(resultType?: "assistant_message" | "tool_request" | "no_output" | "other"): void {
    if (this.finishOnce({ "acode.turn.result": resultType ?? "other" })) {
      this.onAbandoned?.();
      this.hooks.onTurnEnd();
    }
  }

  finishFailed(
    stage: TurnFailureStage,
    category: AgentTelemetryErrorCategory,
    error?: unknown,
  ): void {
    if (
      this.finishOnce(
        { "acode.failure.stage": stage, "acode.error.category": category },
        { error, status: SpanStatusCode.ERROR },
      )
    ) {
      this.onAbandoned?.();
      this.hooks.onTurnEnd();
    }
  }

  finishCancelled(reason: AgentTelemetryCancellationReason): void {
    if (this.finishOnce({ "acode.cancellation.reason": reason })) {
      this.onAbandoned?.();
      this.hooks.onTurnEnd();
    }
  }

  /** abandonSession 收口：悬挂 turn 以 missing_terminal 结束（status ERROR）。 */
  abandon(): void {
    if (
      this.finishOnce(
        { "acode.abandon.reason": "missing_terminal" },
        { status: SpanStatusCode.ERROR },
      )
    ) {
      this.hooks.onTurnEnd();
    }
  }
}

export class StepSpanWriter extends SpanWriterBase implements AgentStepSpanWriter {
  finishCompleted(
    terminalReason: "model_completed" | "tool_requested" | "turn_completed" | "compaction_requested",
  ): void {
    this.finishOnce({ "acode.step.result": terminalReason });
  }

  finishDiscarded(): void {
    this.finishOnce({ "acode.step.result": "discarded" });
  }

  finishFailed(
    stage: StepFailureStage,
    category: AgentTelemetryErrorCategory,
    error?: unknown,
  ): void {
    this.finishOnce(
      { "acode.failure.stage": stage, "acode.error.category": category },
      { error, status: SpanStatusCode.ERROR },
    );
  }

  finishCancelled(reason: AgentTelemetryCancellationReason): void {
    this.finishOnce({ "acode.cancellation.reason": reason });
  }
}

export class CommandSpanWriter extends SpanWriterBase implements CommandExecutionSpanWriter {
  markFirstOutput(): void {
    // 只记事件不记内容：首字输出时间是性能元数据。
    this.span.addEvent("first_output");
  }

  markTerminationRequested(reason: "cancelled" | "timeout" | "shutdown"): void {
    this.setAttrs({ "acode.command.termination_reason": reason });
  }

  setExitCode(exitCode: number): void {
    this.setAttrs({ "acode.command.exit_code": exitCode });
  }

  setSignal(signal: string): void {
    this.setAttrs({ "acode.command.signal": signal });
  }

  setOutputBytes(bytes: number): void {
    this.setAttrs({ "acode.command.output_bytes": bytes });
  }

  setTimedOut(timedOut: boolean): void {
    this.setAttrs({ "acode.command.timed_out": timedOut });
  }

  finishCompleted(): void {
    this.finishOnce({});
  }

  finishFailed(
    stage: CommandFailureStage,
    category: AgentTelemetryErrorCategory,
    error?: unknown,
  ): void {
    this.finishOnce(
      { "acode.failure.stage": stage, "acode.error.category": category },
      { error, status: SpanStatusCode.ERROR },
    );
  }

  finishCancelled(reason: AgentTelemetryCancellationReason): void {
    this.finishOnce({ "acode.cancellation.reason": reason });
  }

  finishBackgrounded(): void {
    this.finishOnce({ "acode.command.backgrounded": true });
  }
}

export class ToolSpanWriter extends SpanWriterBase implements ToolExecutionSpanWriter {
  constructor(
    span: Span,
    private readonly tracer: Tracer,
  ) {
    super(span);
  }

  markPermissionRequested(): void {
    this.setAttrs({ "acode.permission.requested": true });
  }

  setPermissionDecision(decision: "granted" | "denied" | "not_required"): void {
    this.setAttrs({ "acode.permission.decision": decision });
  }

  setOutputBytes(bytes: number): void {
    this.setAttrs({ "acode.output.bytes": bytes });
  }

  setOutputTruncated(truncated: boolean): void {
    this.setAttrs({ "acode.output.truncated": truncated });
  }

  startCommand(input: CommandTraceStart): CommandExecutionSpanWriter {
    // 命令 span 是工具 span 的子 span：显式以工具 span 的 context 为父，
    // 不依赖调用方是否包在 run() 里（executor 的 startCommand 在 scope 内调用，双保险）。
    const span = this.tracer.startSpan(
      `command ${input.safeName}`,
      {
        attributes: whitelisted({
          "acode.command.safe_name": input.safeName,
          "acode.command.category": input.category,
          "acode.command.count": input.commandCount,
          "acode.command.sandboxed": input.sandboxed,
          ...(input.shellKind ? { "acode.command.shell_kind": input.shellKind } : {}),
        }),
      },
      trace.setSpan(contextApi.active(), this.span),
    );
    return new CommandSpanWriter(span);
  }

  finishCompleted(): void {
    this.finishOnce({ "acode.tool.result": "completed" });
  }

  finishDenied(reason: "user_denied" | "policy_denied" | "unavailable" | "unknown"): void {
    this.finishOnce({ "acode.tool.result": "denied", "acode.error.code": reason });
  }

  finishFailed(
    stage: ToolFailureStage,
    category: AgentTelemetryErrorCategory,
    error?: unknown,
  ): void {
    this.finishOnce(
      { "acode.failure.stage": stage, "acode.error.category": category },
      { error, status: SpanStatusCode.ERROR },
    );
  }

  finishCancelled(reason: AgentTelemetryCancellationReason): void {
    this.finishOnce({ "acode.cancellation.reason": reason });
  }
}

export class CompactionSpanWriter extends SpanWriterBase implements ContextCompactionSpanWriter {
  setInputTokens(tokens: number): void {
    this.setAttrs({ "acode.usage.input_tokens": tokens });
  }

  setOutputTokens(tokens: number): void {
    this.setAttrs({ "acode.usage.output_tokens": tokens });
  }

  markFallbackSelected(reason: string): void {
    this.setAttrs({ "acode.compaction.fallback_reason": reason });
  }

  finishCompleted(): void {
    this.finishOnce({});
  }

  finishDiscarded(): void {
    this.finishOnce({ "acode.result.type": "discarded" });
  }

  finishFailed(
    stage: CompactionFailureStage,
    category: AgentTelemetryErrorCategory,
    error?: unknown,
  ): void {
    this.finishOnce(
      { "acode.failure.stage": stage, "acode.error.category": category },
      { error, status: SpanStatusCode.ERROR },
    );
  }

  finishCancelled(reason: AgentTelemetryCancellationReason): void {
    this.finishOnce({ "acode.cancellation.reason": reason });
  }
}

export class DetachedSpanWriter extends SpanWriterBase implements DetachedOperationSpanWriter {
  setResultType(resultType: "text" | "boolean" | "metadata" | "other"): void {
    this.setAttrs({ "acode.result.type": resultType });
  }

  finishCompleted(): void {
    this.finishOnce({});
  }

  finishFailed(
    stage: DetachedFailureStage,
    category: AgentTelemetryErrorCategory,
    error?: unknown,
  ): void {
    this.finishOnce(
      { "acode.failure.stage": stage, "acode.error.category": category },
      { error, status: SpanStatusCode.ERROR },
    );
  }

  finishCancelled(reason: AgentTelemetryCancellationReason): void {
    this.finishOnce({ "acode.cancellation.reason": reason });
  }
}
