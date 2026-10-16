import {
  SESSION_ENTRY_MODEL_SELECTION,
  type Model,
  type ModelSelection,
  type TraceContext,
  type TurnInputIntentMetadata,
} from "@acode/contracts";
import { getCurrentModelInvocationContext } from "../deps.js";
import type { HookRunResult } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { cloneModelSelection } from "../model-selection.js";
import { createRefreshRuntimeHeadersBeforeModelAttempt } from "./model-runtime-headers.js";
import { createRuntimeModel, withModelInvocationContext } from "./runtime-model.js";
import { runPostModelSwitchHooks, runPreModelSwitchHooks } from "./hooks.js";
import { applyRuntimeExecutionState } from "../execution-state.js";

export function createTurnModel(
  runtime: AgentRuntimeInternal,
  options: {
    selection?: ModelSelection;
    requestDependencies?: import("@acode/contracts").ModelRequestDependencies;
  } = {},
): Model {
  const selection = options.selection ?? runtime.getSessionModelSelection();
  const model = createRuntimeModel(runtime, {
    selection,
    requestDependencies: options.requestDependencies,
  });
  return withModelInvocationContext(model, (request) => ({
    refreshRuntimeHeadersBeforeAttempt: createRefreshRuntimeHeadersBeforeModelAttempt(runtime, {
      abortSignal: request.abortSignal,
      model,
      traceContext: getCurrentModelInvocationContext()?.traceContext ?? runtime.rootTraceContext,
    }),
  }));
}

/**
 * 在 Submission 真正开始执行或 Guide 被下一次 model step 消费时应用其执行配置。
 * 选择只决定新创建的 Model；已经被其他 Loop 持有的 Model 不会被修改。
 */
export async function applySubmissionExecutionState(
  runtime: AgentRuntimeInternal,
  intent: TurnInputIntentMetadata | undefined,
  traceContext: TraceContext,
  modelExecution?: import("../types.js").ModelExecutionContext,
  preparedModel?: Model,
): Promise<Model | undefined> {
  const selection = intent?.modelSelection;
  const previousSelection = runtime.getSessionModelSelection();
  let model = preparedModel;

  if (selection) {
    model ??= createTurnModel(runtime, {
      selection,
      requestDependencies: modelExecution?.requestDependencies,
    });
    if (modelExecution?.selectionScope !== "execution") {
      const appliedSelection = cloneModelSelection(selection);
      if (sameModelSelection(previousSelection, appliedSelection)) {
        runtime.setSessionModelSelection(appliedSelection);
        await persistRuntimeModelSelection(runtime, appliedSelection);
      } else {
        // Pre/PostModelSwitch（specs/hook-event-surface.md）：只在 selection 真实变化时
        // 触发；Pre 在任何 mutation 之前运行，block ⇒ 拒绝切换（保持 previous selection，
        // 不落库、不发 ModelSelected），本 turn 用 previous selection 重建 Model。
        const nextModel = `${appliedSelection.providerId}/${appliedSelection.modelId}`;
        const previousModel = previousSelection
          ? `${previousSelection.providerId}/${previousSelection.modelId}`
          : undefined;
        const preSwitch = await runPreModelSwitchHooksSafely(
          runtime,
          {
            nextModel,
            ...(previousModel !== undefined ? { previousModel } : {}),
          },
          traceContext,
        );
        if (preSwitch.blockRequested || preSwitch.preventContinuation) {
          runtime.logger?.info("Model switch blocked by PreModelSwitch hook", {
            event: "hook.pre_model_switch.blocked",
            module: "core.runtime",
            nextModel,
            previousModel,
            stopReason: preSwitch.stopReason,
          });
          model = createTurnModel(runtime, {
            ...(previousSelection ? { selection: previousSelection } : {}),
            requestDependencies: modelExecution?.requestDependencies,
          });
        } else {
          runtime.setSessionModelSelection(appliedSelection);
          await persistRuntimeModelSelection(runtime, appliedSelection);
          await runtime.emitModelSelected({
            model,
            modelSelection: appliedSelection,
            effectiveReasoningLevel: model.options.reasoningLevel,
            previousModelSelection: previousSelection,
            supportedThoughtLevels: model.optionSpecs.reasoningLevel.values,
            traceContext,
          });
          await runPostModelSwitchHooksSafely(
            runtime,
            {
              nextModel,
              ...(previousModel !== undefined ? { previousModel } : {}),
            },
            traceContext,
          );
        }
      }
    }
  }

  if (intent?.mode !== undefined || intent?.planEnabled !== undefined) {
    await applyRuntimeExecutionState(runtime, intent, { source: "command", traceContext });
  }

  return model;
}

export function sameModelSelection(
  left: ModelSelection | undefined,
  right: ModelSelection,
): boolean {
  return (
    left?.providerId === right.providerId &&
    left.modelId === right.modelId &&
    left.options?.reasoningLevel === right.options?.reasoningLevel
  );
}

export async function persistRuntimeModelSelection(
  runtime: AgentRuntimeInternal,
  selection: ModelSelection,
): Promise<void> {
  if (!runtime.sessionStore?.saveSessionEntry) return;
  const timestamp = Date.now();
  try {
    await runtime.sessionStore.saveSessionEntry({
      id: `${runtime.sessionId}:runtime-model-selection`,
      sessionID: runtime.sessionId,
      type: SESSION_ENTRY_MODEL_SELECTION,
      touchSession: false,
      time: { created: timestamp, updated: timestamp },
      data: selection,
    });
  } catch (error) {
    runtime.logger?.warn("Session model selection persistence failed", {
      error: error instanceof Error ? error.message : String(error),
      event: "session.model_selection.persist_failed",
      modelId: selection.modelId,
      module: "core.runtime",
      providerId: selection.providerId,
      status: "failed",
      thoughtLevel: selection.options?.reasoningLevel,
    });
  }
}

/**
 * fail-open（specs/hook-event-surface.md「失败语义」）：hook 执行链自身故障
 * （如生命周期 emitEvent 抛错）放行切换；「block 等同拒绝」只发生在 hook 显式
 * 表达拒绝（退出码 2 / continue:false / decision:block）时。
 */
async function runPreModelSwitchHooksSafely(
  runtime: AgentRuntimeInternal,
  input: { nextModel: string; previousModel?: string },
  traceContext: TraceContext,
): Promise<HookRunResult> {
  try {
    return await runPreModelSwitchHooks(runtime, input, traceContext);
  } catch (error) {
    runtime.logger?.warn("PreModelSwitch hook run failed; allowing switch", {
      error: error instanceof Error ? error.message : String(error),
      event: "hook.pre_model_switch.run_failed",
      module: "core.runtime",
      nextModel: input.nextModel,
    });
    return { additionalContexts: [] };
  }
}

/** PostModelSwitch 通知类：切换已生效，hook 故障绝不影响已完成的切换。 */
async function runPostModelSwitchHooksSafely(
  runtime: AgentRuntimeInternal,
  input: { nextModel: string; previousModel?: string },
  traceContext: TraceContext,
): Promise<void> {
  try {
    await runPostModelSwitchHooks(runtime, input, traceContext);
  } catch (error) {
    runtime.logger?.warn("PostModelSwitch hook run failed", {
      error: error instanceof Error ? error.message : String(error),
      event: "hook.post_model_switch.run_failed",
      module: "core.runtime",
      nextModel: input.nextModel,
    });
  }
}
