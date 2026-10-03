import {
  SessionEventType,
  createChildTraceContext,
  runWithModelInvocationContext,
  traceContextToLogContext,
} from "../deps.js";
import type { ModelInputMessage, SessionEvent, TraceContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { createRefreshRuntimeHeadersBeforeModelAttempt } from "./model-runtime-headers.js";
import { recordModelUsageFact } from "./usage-observability.js";
import { createRuntimeModel } from "./runtime-model.js";
import { auxiliaryModelOptions } from "../../model/auxiliary-model-options.js";
import {
  AUTO_CLASSIFIER_FORENSIC_MAX_CHARS,
  AUTO_CLASSIFIER_MAX_CALLS_PER_TURN,
  AUTO_CLASSIFIER_MIN_CONFIDENCE,
  AUTO_CLASSIFIER_TIMEOUT_MS,
  AUTO_RISK_CLASSIFIER_SYSTEM_PROMPT,
  buildAutoRiskClassifierUserMessage,
  buildAutoRiskCacheKey,
  createAutoRiskDecisionCache,
  parseAutoRiskVerdict,
  serializeAutoRiskClassifierInput,
  type AutoRiskClassifierPort,
  type AutoRiskVerdict,
} from "../../permission/auto-risk-classifier.js";

/**
 * auto 模式风险分类器的 sidecar 实现（specs/auto-mode-risk-classifier.md R2）。
 * 1:1 沿 title-generation-sidecar 模板：会话模型 + auxiliaryModelOptions（最低
 * reasoning 档 + 输出上限）、AbortSignal.timeout、ModelRequest/ModelComplete 事件对
 * （querySource=auto_risk_classify）、recordModelUsageFact 两路入账。
 * 构造点唯一：runtime/helpers/runtime-tools.ts 的 createRuntimeToolExecutor
 * （runtime 在作用域处）；子代理 child runtime 走同一 helper 自动获得。
 * 缓存与预算是本闭包的私有状态（session 级生命周期，随 runtime 生灭）。
 */
export function createAutoRiskClassifier(runtime: AgentRuntimeInternal): AutoRiskClassifierPort {
  const cache = createAutoRiskDecisionCache();
  const budgetByTurn = new Map<string, number>();

  return {
    async classify(req): Promise<AutoRiskVerdict> {
      const cacheKey = buildAutoRiskCacheKey(req.toolName, req.input);
      const cached = cache.get(cacheKey);
      if (cached) {
        // 缓存只存 allow/deny verdict（R3/D5）；unavailable 分支是类型防御。
        return cached.kind === "verdict" ? { ...cached, via: "cache" } : cached;
      }

      // D6 预算：turnId 缺席时归入同一兜底键（仍受限，不因缺 turn 而无限）。
      const turnKey = req.turnId ?? "__no_turn__";
      const used = budgetByTurn.get(turnKey) ?? 0;
      if (used >= AUTO_CLASSIFIER_MAX_CALLS_PER_TURN) {
        return { kind: "unavailable", reason: "budget" };
      }

      const requestedModelSelection = runtime.getSessionModelSelection();
      if (!requestedModelSelection) {
        return { kind: "unavailable", reason: "no_model" };
      }
      budgetByTurn.set(turnKey, used + 1);

      const verdict = await runClassifierSidecar(runtime, req, cacheKey, cache);
      return verdict;
    },
  };
}

async function runClassifierSidecar(
  runtime: AgentRuntimeInternal,
  req: Parameters<AutoRiskClassifierPort["classify"]>[0],
  cacheKey: string,
  cache: ReturnType<typeof createAutoRiskDecisionCache>,
): Promise<AutoRiskVerdict> {
  const baseModel = createRuntimeModel(runtime, {
    selection: runtime.getSessionModelSelection()!,
  });
  const model = baseModel.bind(auxiliaryModelOptions(baseModel));
  const parentTraceContext: TraceContext = req.traceContext ?? runtime.rootTraceContext;
  const modelTraceContext = createChildTraceContext(parentTraceContext, {
    attributes: {
      model: `${model.providerId}/${model.modelId}`,
      querySource: "auto_risk_classify",
      classifiedTool: req.toolName,
    },
  });
  const events: SessionEvent[] = [];
  const messages = buildClassifierMessages(runtime, req);
  const modelRequestEvent = runtime.createEvent(
    SessionEventType.ModelRequest,
    {
      messages,
      providerId: String(model.providerId),
      modelId: String(model.modelId),
      querySource: "auto_risk_classify",
      toolCount: 0,
    },
    modelTraceContext,
  );
  await runtime.appendEvent(modelRequestEvent, modelTraceContext);
  events.push(modelRequestEvent);
  const networkEventStartIndex = events.length;

  // 外部取消（工具调用被中止）与分类超时合并：任一触发即终止。
  const timeoutSignal = AbortSignal.timeout(AUTO_CLASSIFIER_TIMEOUT_MS);
  const abortSignal = req.signal ? AbortSignal.any([req.signal, timeoutSignal]) : timeoutSignal;
  const modelStartedAt = Date.now();
  const invocationContext = {
    metadata: traceContextToLogContext(modelTraceContext),
    modelRequestSessionType: "other" as const,
    modelCall: {
      operation: "auto_risk_classification" as const,
      reasoning: { requestedLevel: model.options.reasoningLevel },
    },
    statusSink: runtime.createModelStatusSink(modelTraceContext, events),
    traceContext: modelTraceContext,
    refreshRuntimeHeadersBeforeAttempt: createRefreshRuntimeHeadersBeforeModelAttempt(runtime, {
      abortSignal,
      model,
      traceContext: modelTraceContext,
    }),
  };

  let result;
  try {
    result = await runWithModelInvocationContext(invocationContext, () =>
      model.generateText({ abortSignal, messages, tools: [] }),
    );
  } catch (error) {
    await recordModelUsageFact(runtime, {
      error,
      events,
      model,
      networkEventStartIndex,
      querySource: "auto_risk_classify",
      startedAt: modelStartedAt,
      status: "error",
      traceContext: modelTraceContext,
    }).catch(() => undefined);
    return {
      kind: "unavailable",
      reason: isTimeoutError(error, timeoutSignal) ? "timeout" : "error",
    };
  }

  const toolCalls = runtime.extractToolCallsFromResult(result);
  const modelCompleteEvent = runtime.createEvent(
    SessionEventType.ModelComplete,
    {
      content: result.text,
      querySource: "auto_risk_classify",
      stopReason: result.finishReason,
      toolCallCount: toolCalls.length,
      usage: result.usage,
    },
    modelTraceContext,
  );
  await runtime.appendEvent(modelCompleteEvent, modelTraceContext).catch(() => undefined);
  events.push(modelCompleteEvent);
  await recordModelUsageFact(runtime, {
    events,
    model,
    networkEventStartIndex,
    querySource: "auto_risk_classify",
    result,
    startedAt: modelStartedAt,
    status: "completed",
    toolCallCount: toolCalls.length,
    traceContext: modelTraceContext,
  }).catch(() => undefined);

  // 分类器不得调工具（tools: [] 下理论上不可能；出现即视为输出不可信）。
  if (toolCalls.length > 0) return { kind: "unavailable", reason: "parse_error" };
  const parsed = parseAutoRiskVerdict(result.text);
  if (!parsed || parsed.kind !== "verdict") {
    return { kind: "unavailable", reason: "parse_error" };
  }
  if (parsed.confidence < AUTO_CLASSIFIER_MIN_CONFIDENCE) {
    return { kind: "unavailable", reason: "low_confidence" };
  }
  // 只缓存 allow/deny（ask 人是最终变量，缓存它会冻结审批语义）。
  if (parsed.verdict === "allow" || parsed.verdict === "deny") {
    cache.set(cacheKey, parsed);
  }
  return parsed;
}

function buildClassifierMessages(
  runtime: AgentRuntimeInternal,
  req: Parameters<AutoRiskClassifierPort["classify"]>[0],
): ModelInputMessage[] {
  return [
    { role: "system", content: AUTO_RISK_CLASSIFIER_SYSTEM_PROMPT },
    {
      role: "user",
      content: buildAutoRiskClassifierUserMessage({
        toolName: req.toolName,
        riskLevel: req.riskLevel,
        ...(req.sideEffectScope ? { sideEffectScope: req.sideEffectScope } : {}),
        serializedInput: serializeAutoRiskClassifierInput(req.input),
        forensicWindow: buildForensicWindow(runtime),
      }),
    },
  ];
}

/**
 * D4-B 取证窗：最近 1 条**真实用户**消息（跳过 system-reminder 等合成来源），
 * 硬截断 2K。工具结果/文件内容/网页文本默认不进（spec R2）。
 */
function buildForensicWindow(runtime: AgentRuntimeInternal): string {
  const entries = runtime.messageHistory.borrowReadOnlyRuntimeEntries();
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry || entry.kind === "attachment") continue;
    if (entry.message.role !== "user") continue;
    if (entry.metadata?.source && entry.metadata.source !== "real_user") continue;
    const text = extractMessageText(entry.message.content);
    if (text.trim()) {
      return text.slice(0, AUTO_CLASSIFIER_FORENSIC_MAX_CHARS);
    }
  }
  return "";
}

function extractMessageText(content: ModelInputMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      block && typeof block === "object" && "type" in block && block.type === "text"
        ? String((block as { text?: unknown }).text ?? "")
        : "",
    )
    .filter((text) => text.length > 0)
    .join("\n");
}

function isTimeoutError(error: unknown, timeoutSignal: AbortSignal): boolean {
  if (error instanceof Error && error.name === "TimeoutError") return true;
  return timeoutSignal.aborted;
}
