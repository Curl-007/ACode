// ============================================================
// T1-6 扩展事件面触发函数（specs/hook-event-surface.md）
// ============================================================
// 从 hooks.ts 拆出：事件扩到 17 个后 hooks.ts 越过 400 行架构 ratchet，按仓库
// 惯例拆分；hooks.ts 以 `export *` 再导出本文件，公开 API 与导入路径兼容——
// 模块内消费者与守护测试仍从 "./hooks.js" 导入，不感知拆分。
//
// 新增触发一律用「runtime 显式首参」的普通函数形态，而不是 this: 方法：
// this: 方法需要在 runtime/internal-hook-methods.ts 同步声明接口，普通函数形态
// 与 applySubmissionExecutionState（turn-model.ts）的既有模式一致，触发点与
// 守护测试都能直接调用（spec D6）。shutdown 漏斗的 SessionEnd 例外地另经
// AgentRuntime 公开方法暴露给 bootstrap（见 agent-runtime.ts 的桥接注释）。
import { HookEventName, traceContextToLogContext } from "../deps.js";
import type { CompactTrigger, HookRunResult, ToolCallId, TraceContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";

// 与 hooks.ts 的同名常量同构（空结果字面量，无状态）；拆分为两个模块私有副本，
// 避免本文件反向 import hooks.ts 形成再导出环。
const EMPTY_HOOK_RESULT: HookRunResult = {
  additionalContexts: [],
};

/** PostToolBatch：一个并行组的全部工具调用结算后一次；通知类（block 输出只记日志）。 */
export async function runPostToolBatchHooks(
  runtime: AgentRuntimeInternal,
  batch: {
    errorCount: number;
    successCount: number;
    toolResults: Array<{
      durationMs?: number;
      success: boolean;
      toolCallId: ToolCallId | string;
      toolName: string;
    }>;
  },
  traceContext: TraceContext,
  signal?: AbortSignal,
): Promise<HookRunResult> {
  if (!runtime.hookRunner) return EMPTY_HOOK_RESULT;
  return runtime.hookRunner.run(
    {
      agentName: runtime.config.agentName,
      cwd: runtime.workingDirectory,
      errorCount: batch.errorCount,
      hookEventName: HookEventName.PostToolBatch,
      mode: runtime.getMode(),
      sessionId: runtime.sessionId,
      successCount: batch.successCount,
      timestamp: new Date().toISOString(),
      toolResults: batch.toolResults,
      traceId: traceContext.traceId,
      turnId: traceContext.turnId,
    },
    { signal },
  );
}

/** PreCompact：压缩开始前；阻断类——block/preventContinuation ⇒ 触发点必须放弃压缩。 */
export async function runPreCompactHooks(
  runtime: AgentRuntimeInternal,
  input: {
    customInstructions?: string;
    preCompactTokenCount?: number;
    trigger: CompactTrigger;
  },
  traceContext: TraceContext,
  signal?: AbortSignal,
): Promise<HookRunResult> {
  if (!runtime.hookRunner) return EMPTY_HOOK_RESULT;
  return runtime.hookRunner.run(
    {
      agentName: runtime.config.agentName,
      ...(input.customInstructions !== undefined
        ? { customInstructions: input.customInstructions }
        : {}),
      cwd: runtime.workingDirectory,
      hookEventName: HookEventName.PreCompact,
      mode: runtime.getMode(),
      ...(input.preCompactTokenCount !== undefined
        ? { preCompactTokenCount: input.preCompactTokenCount }
        : {}),
      sessionId: runtime.sessionId,
      timestamp: new Date().toISOString(),
      traceId: traceContext.traceId,
      trigger: input.trigger,
      turnId: traceContext.turnId,
    },
    { matchValue: input.trigger, signal },
  );
}

/** PostCompact：压缩成功结算后一次；通知类，触发点必须 try/catch 包住本调用。 */
export async function runPostCompactHooks(
  runtime: AgentRuntimeInternal,
  input: {
    postCompactTokenCount?: number;
    preCompactTokenCount?: number;
    trigger: CompactTrigger;
  },
  traceContext: TraceContext,
  signal?: AbortSignal,
): Promise<HookRunResult> {
  if (!runtime.hookRunner) return EMPTY_HOOK_RESULT;
  return runtime.hookRunner.run(
    {
      agentName: runtime.config.agentName,
      cwd: runtime.workingDirectory,
      hookEventName: HookEventName.PostCompact,
      mode: runtime.getMode(),
      ...(input.postCompactTokenCount !== undefined
        ? { postCompactTokenCount: input.postCompactTokenCount }
        : {}),
      ...(input.preCompactTokenCount !== undefined
        ? { preCompactTokenCount: input.preCompactTokenCount }
        : {}),
      sessionId: runtime.sessionId,
      timestamp: new Date().toISOString(),
      traceId: traceContext.traceId,
      trigger: input.trigger,
      turnId: traceContext.turnId,
    },
    { matchValue: input.trigger, signal },
  );
}

/** PreModelSwitch：session model selection 真实变化后、任何 mutation 前；阻断类。 */
export async function runPreModelSwitchHooks(
  runtime: AgentRuntimeInternal,
  input: { nextModel: string; previousModel?: string },
  traceContext: TraceContext,
  signal?: AbortSignal,
): Promise<HookRunResult> {
  if (!runtime.hookRunner) return EMPTY_HOOK_RESULT;
  return runtime.hookRunner.run(
    {
      agentName: runtime.config.agentName,
      cwd: runtime.workingDirectory,
      hookEventName: HookEventName.PreModelSwitch,
      mode: runtime.getMode(),
      nextModel: input.nextModel,
      ...(input.previousModel !== undefined ? { previousModel: input.previousModel } : {}),
      sessionId: runtime.sessionId,
      timestamp: new Date().toISOString(),
      traceId: traceContext.traceId,
      turnId: traceContext.turnId,
    },
    { matchValue: input.nextModel, signal },
  );
}

/** PostModelSwitch：selection 已 set+persist、ModelSelected 已发出后；通知类。 */
export async function runPostModelSwitchHooks(
  runtime: AgentRuntimeInternal,
  input: { nextModel: string; previousModel?: string },
  traceContext: TraceContext,
  signal?: AbortSignal,
): Promise<HookRunResult> {
  if (!runtime.hookRunner) return EMPTY_HOOK_RESULT;
  return runtime.hookRunner.run(
    {
      agentName: runtime.config.agentName,
      cwd: runtime.workingDirectory,
      hookEventName: HookEventName.PostModelSwitch,
      mode: runtime.getMode(),
      nextModel: input.nextModel,
      ...(input.previousModel !== undefined ? { previousModel: input.previousModel } : {}),
      sessionId: runtime.sessionId,
      timestamp: new Date().toISOString(),
      traceId: traceContext.traceId,
      turnId: traceContext.turnId,
    },
    { matchValue: input.nextModel, signal },
  );
}

/**
 * StopFailure：turn 以失败/取消收口时（TurnError outcome 之后、throw 之前）。
 * 通知类且自带 containment：hook 故障（含 runner 自身抛错）绝不掩盖原始 turn error，
 * 也绝不让失败路径再抛第二个错。
 */
export async function runStopFailureHooks(
  runtime: AgentRuntimeInternal,
  failure: {
    cancelled: boolean;
    errorMessage: string;
    errorType: string;
    toolCallCount?: number;
  },
  traceContext: TraceContext,
): Promise<void> {
  if (!runtime.hookRunner) return;
  try {
    await runtime.hookRunner.run(
      {
        agentName: runtime.config.agentName,
        cancelled: failure.cancelled,
        cwd: runtime.workingDirectory,
        errorMessage: failure.errorMessage,
        errorType: failure.errorType,
        hookEventName: HookEventName.StopFailure,
        mode: runtime.getMode(),
        sessionId: runtime.sessionId,
        timestamp: new Date().toISOString(),
        ...(failure.toolCallCount !== undefined ? { toolCallCount: failure.toolCallCount } : {}),
        traceId: traceContext.traceId,
        turnId: traceContext.turnId,
      },
      { matchValue: failure.cancelled ? "cancelled" : "failed" },
    );
  } catch (error) {
    runtime.logger?.warn("StopFailure hook run failed", {
      ...traceContextToLogContext(traceContext),
      error: error instanceof Error ? error.message : String(error),
      event: "hook.stop_failure.run_failed",
      module: "core.runtime",
    });
  }
}

/**
 * CwdChanged：执行 cwd 真实变化后。setWorkingDirectory 是同步接口且 bash 已 cd
 * （事实不可回滚），因此走异步旁路：fire-and-forget + catch warn，不阻塞工具链路。
 */
export function runCwdChangedHooksDetached(
  runtime: AgentRuntimeInternal,
  previousCwd: string,
  newCwd: string,
): void {
  if (!runtime.hookRunner) return;
  const traceContext = runtime.rootTraceContext;
  void (async () => {
    await runtime.hookRunner?.run({
      agentName: runtime.config.agentName,
      cwd: newCwd,
      hookEventName: HookEventName.CwdChanged,
      mode: runtime.getMode(),
      newCwd,
      previousCwd,
      sessionId: runtime.sessionId,
      timestamp: new Date().toISOString(),
      traceId: traceContext.traceId,
    });
  })().catch((error) => {
    runtime.logger?.warn("CwdChanged hook run failed", {
      ...traceContextToLogContext(traceContext),
      error: error instanceof Error ? error.message : String(error),
      event: "hook.cwd_changed.run_failed",
      module: "core.runtime",
    });
  });
}

/**
 * SessionEnd：会话收口漏斗触发一次（specs/hook-event-surface.md F1 接线批次落地）。
 * 通知类且自带 containment：hook 故障（含 runner 自身抛错）只 warn，绝不阻断会话
 * 关闭；调用方（bootstrap session-facade.close，唯一 awaitable 收口漏斗）另加超时
 * 闸门——超时 abort 让 runner 收掉在飞 hook 进程，关闭链路不被 hook 拖住。
 * reason 现状：装配层单一漏斗传 "dispose"（宿主回收会话 app）；clear/logout/exit
 * 等更细来源需要 close 签名链路携带原因参数，登记为后续批次（spec F1 建议闭集）。
 * 子会话（dwf driver 直连 runtime.closeBrowserSession 的 child runtime）不经本漏斗，
 * 其生命周期事件面归 F5（SubagentStart/Stop）承接，避免双写同一事实。
 */
export async function runSessionEndHooks(
  runtime: AgentRuntimeInternal,
  input: { reason: string },
  traceContext?: TraceContext,
  signal?: AbortSignal,
): Promise<void> {
  if (!runtime.hookRunner) return;
  const trace = traceContext ?? runtime.rootTraceContext;
  try {
    await runtime.hookRunner.run(
      {
        agentName: runtime.config.agentName,
        cwd: runtime.workingDirectory,
        hookEventName: HookEventName.SessionEnd,
        mode: runtime.getMode(),
        reason: input.reason,
        sessionId: runtime.sessionId,
        timestamp: new Date().toISOString(),
        traceId: trace.traceId,
        turnId: trace.turnId,
      },
      { matchValue: input.reason, signal },
    );
  } catch (error) {
    runtime.logger?.warn("SessionEnd hook run failed", {
      ...traceContextToLogContext(trace),
      error: error instanceof Error ? error.message : String(error),
      event: "hook.session_end.run_failed",
      module: "core.runtime",
    });
  }
}
