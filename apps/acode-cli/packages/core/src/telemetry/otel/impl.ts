/**
 * OTel trace 运行时装配与 AgentExecutionTelemetryPort 实现
 * （specs/otel-telemetry.md「落点与分层」「Flush 时序」）。
 *
 * 本文件位于懒加载图内：只有 env-gate 判定启用后由 init.ts 动态 import，
 * 默认启动路径（无 OTEL_EXPORTER_OTLP_* 端点）完全不加载 OTel SDK 模块图
 *（机制参照 oh-my-pi MIT telemetry-export-otlp.ts 的按需加载设计，~100ms
 * 模块评估成本留在门禁之后）。
 *
 * Resource 合并顺序同 omp：兜底 service.name 先构造，再 merge env detector
 *（OTEL_SERVICE_NAME / OTEL_RESOURCE_ATTRIBUTES 用户自配优先）。
 */
import { context as contextApi, ROOT_CONTEXT, SpanStatusCode, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { detectResources, envDetector, resourceFromAttributes } from "@opentelemetry/resources";
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-base";
import type {
  AgentStepTraceStart,
  AgentTelemetryCausation,
  AgentTurnTraceStart,
  CompactionTraceStart,
  DetachedOperationTraceStart,
  ToolTraceStart,
} from "@acode/contracts";
import type { ModelRequestTelemetryFact } from "./model-request-fact.js";
import type { OtelAgentTelemetryPort } from "./impl-types.js";
import type { TelemetryLogSink } from "./logger-sink.js";
import { whitelisted } from "./attributes.js";
import {
  causationLinks,
  compactionStartAttributes,
  detachedStartAttributes,
  modelRequestAttributes,
  stepStartAttributes,
  toolStartAttributes,
  turnStartAttributes,
} from "./span-attributes.js";
import {
  CompactionSpanWriter,
  DetachedSpanWriter,
  remoteParentContext,
  StepSpanWriter,
  ToolSpanWriter,
  TurnSpanWriter,
} from "./spans.js";

export interface OtelTraceRuntimeOptions {
  serviceName: string;
  serviceVersion?: string;
  /** CLI=app sessionId；desktop=进程启动 UUID。 */
  serviceInstanceId?: string;
  /** os.type（process.platform）。 */
  platform?: string;
  logger?: TelemetryLogSink;
  /** 测试缝：注入 InMemorySpanExporter；缺省 OTLPTraceExporter（自读 OTEL_* env）。 */
  exporter?: SpanExporter;
  /** turn 终态去抖 flush 窗口，默认 250ms。 */
  turnFlushDebounceMs?: number;
  /** 周期 flush 间隔，默认 30s（omp 同款，长驻进程不等批窗口）。 */
  periodicFlushIntervalMs?: number;
  /** shutdown 等待上限，默认 5s。 */
  shutdownTimeoutMs?: number;
}

/** OTel 实现的 port 面类型在 impl-types.ts（叶子类型文件，init/impl 共享）。 */
export type { OtelAgentTelemetryPort };

export interface OtelTraceRuntime {
  readonly port: OtelAgentTelemetryPort;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/i;
const SPAN_ID_PATTERN = /^[0-9a-f]{16}$/i;

/** 跨进程因果引用格式校验：非法 id 一律忽略（宁可不挂父，不造坏 trace）。 */
function sanitizeCausation(causation: AgentTelemetryCausation | undefined): AgentTelemetryCausation | undefined {
  if (!causation) return undefined;
  if (!TRACE_ID_PATTERN.test(causation.traceId)) return undefined;
  if (!SPAN_ID_PATTERN.test(causation.spanId)) return undefined;
  if (!Number.isFinite(causation.traceFlags)) return undefined;
  return causation;
}

export function createOtelTraceRuntime(options: OtelTraceRuntimeOptions): OtelTraceRuntime {
  const logger = options.logger;
  // Resource：兜底身份先构造，env detector（用户自配）merge 在后 = 优先级最高。
  const resource = resourceFromAttributes({
    "service.name": options.serviceName,
    ...(options.serviceVersion ? { "service.version": options.serviceVersion } : {}),
    ...(options.serviceInstanceId ? { "service.instance.id": options.serviceInstanceId } : {}),
    ...(options.platform ? { "os.type": options.platform } : {}),
  }).merge(detectResources({ detectors: [envDetector] }));

  const exporter = options.exporter ?? new OTLPTraceExporter();
  const provider = new BasicTracerProvider({
    resource,
    spanProcessors: [new BatchSpanProcessor(exporter)],
    // 防御性上限：单属性 512 字符 / 单 span 64 属性，异常长值直接截断。
    spanLimits: { attributeCountLimit: 64, attributeValueLengthLimit: 512 },
  });
  // OTel JS 2.x：TracerProvider 不再有 register()——全局 context manager 与
  // provider 分别经 API 注册。AsyncLocalStorage context manager 是 scope.run()
  // 嵌套父子传播的前提；同进程重复 set 时 API 保留首个并返回 false，不抛。
  // span 创建走下方实例级 tracer，不依赖全局 provider 注册结果（测试可多实例并存）。
  contextApi.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  trace.setGlobalTracerProvider(provider);
  const tracer = provider.getTracer("acode.telemetry", options.serviceVersion);

  const turnFlushDebounceMs = options.turnFlushDebounceMs ?? 250;
  const periodicFlushIntervalMs = options.periodicFlushIntervalMs ?? 30_000;
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? 5_000;

  let shutdownStarted = false;
  let turnFlushTimer: ReturnType<typeof setTimeout> | undefined;
  /** 悬挂 turn 登记（sessionId → writers）：abandonSession 收口用。 */
  const activeTurns = new Map<string, Set<TurnSpanWriter>>();

  const flush = async (): Promise<void> => {
    try {
      await provider.forceFlush();
    } catch (error) {
      // 导出失败只降级为 debug 诊断，永不抛回业务路径（spec Flush 时序 4）。
      logger?.debug("OTel trace flush failed", {
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  };

  /** turn 边界主动 flush（omp 同款语义）：去抖 + fire-and-forget。 */
  const scheduleTurnFlush = (): void => {
    if (shutdownStarted) return;
    if (turnFlushTimer) clearTimeout(turnFlushTimer);
    turnFlushTimer = setTimeout(() => {
      turnFlushTimer = undefined;
      void flush();
    }, turnFlushDebounceMs);
    turnFlushTimer.unref?.();
  };

  const periodicTimer = setInterval(() => {
    void flush();
  }, periodicFlushIntervalMs);
  periodicTimer.unref?.();

  const trackTurn = (sessionId: string, writer: TurnSpanWriter): void => {
    let bucket = activeTurns.get(sessionId);
    if (!bucket) {
      bucket = new Set();
      activeTurns.set(sessionId, bucket);
    }
    bucket.add(writer);
  };

  const port: OtelAgentTelemetryPort = {
    captureCausation() {
      const spanContext = trace.getSpanContext(contextApi.active());
      if (!spanContext) return undefined;
      return {
        isRemote: false,
        spanId: spanContext.spanId,
        traceFlags: spanContext.traceFlags,
        traceId: spanContext.traceId,
      };
    },

    startTurn(input: AgentTurnTraceStart) {
      const causation = sanitizeCausation(input.causation);
      const linkedRoot = input.causationMode === "linked_root";
      const links = linkedRoot ? causationLinks(causation) : undefined;
      const parentContext = linkedRoot
        ? ROOT_CONTEXT
        : causation
          ? remoteParentContext(causation)
          : undefined;
      const span = tracer.startSpan(
        "invoke_agent",
        {
          attributes: whitelisted(turnStartAttributes(input)),
          ...(links ? { links } : {}),
        },
        parentContext,
      );
      const writer = new TurnSpanWriter(
        span,
        { onTurnEnd: scheduleTurnFlush },
        () => activeTurns.get(input.context.sessionId)?.delete(writer),
      );
      trackTurn(input.context.sessionId, writer);
      return writer;
    },

    startStep(input: AgentStepTraceStart) {
      const span = tracer.startSpan("agent_step", {
        attributes: whitelisted(stepStartAttributes(input)),
      });
      return new StepSpanWriter(span);
    },

    startTool(input: ToolTraceStart) {
      const span = tracer.startSpan(`execute_tool ${input.registeredToolName}`, {
        attributes: whitelisted(toolStartAttributes(input)),
      });
      return new ToolSpanWriter(span, tracer);
    },

    startCompaction(input: CompactionTraceStart) {
      const span = tracer.startSpan("context_compaction", {
        attributes: whitelisted(compactionStartAttributes(input)),
      });
      return new CompactionSpanWriter(span);
    },

    startDetachedOperation(input: DetachedOperationTraceStart) {
      const causation = sanitizeCausation(input.causation);
      const span = tracer.startSpan(
        input.operation,
        { attributes: whitelisted(detachedStartAttributes(input)) },
        causation ? remoteParentContext(causation) : undefined,
      );
      return new DetachedSpanWriter(span);
    },

    abandonSession(sessionId: string) {
      // 悬挂 turn 统一以 missing_terminal 收口（status ERROR），避免批内 span 永无终态。
      const bucket = activeTurns.get(sessionId);
      if (!bucket) return;
      activeTurns.delete(sessionId);
      for (const writer of bucket) writer.abandon();
    },

    recordModelRequest(fact: ModelRequestTelemetryFact) {
      // 事实回填型 span：显式 startTime/endTime（epoch ms），落在当时活跃的
      // step/turn/detached scope 下（recordModelUsageFact 在 scope.run 内调用）。
      const span = tracer.startSpan(
        `chat ${fact.modelId}`,
        {
          attributes: whitelisted(modelRequestAttributes(fact)),
          startTime: fact.startedAt,
        },
        contextApi.active(),
      );
      if (fact.status !== "completed") {
        span.setStatus({ code: SpanStatusCode.ERROR });
      }
      span.end(fact.completedAt);
    },
  };

  const shutdown = async (): Promise<void> => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    if (turnFlushTimer) clearTimeout(turnFlushTimer);
    clearInterval(periodicTimer);
    try {
      await withTimeout(provider.shutdown(), shutdownTimeoutMs);
    } catch (error) {
      logger?.warn("OTel trace provider shutdown failed", {
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  };

  return { port, flush, shutdown };
}

function withTimeout(promise: Promise<void>, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`OTel shutdown timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
    promise.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
