// ============================================================
// Hook 链环节结算（runner.ts 拆分件三）——前台环节 dispatch + middleware next
// ============================================================
// specs/plugin-hook-middleware.md 一：legacy 环节与既有顺序链行为逐一等价；
// middleware 环节经注入的 continueChain 续行推进下游（避免与 runner-chain.ts 形成
// 模块环：本文件只依赖注入的续行闭包，不反向 import 走查模块）。
// 拆分依据见 runner-lifecycle.ts 头注；公开 API 不变。
import {
  HookOutcome,
  SessionEventType,
  isCoreError,
  traceContextToLogContext,
  type HookExecutionDescriptor,
  type HookInput,
} from "@acode/contracts";
import {
  hardenHookAdditionalContexts,
  mergeHookRunResult,
  processHookOutput,
} from "./output.js";
import { sanitizeHookDisplayText } from "./display-metadata.js";
import {
  createHookMiddlewareMisuseError,
  createMiddlewareNextState,
  freezeHookEvent,
  validateHookEventRewrite,
  type HookMiddlewareNextState,
} from "./hook-middleware.js";
import {
  createHookRefusalObservability,
  resolveHookRefusalName,
  resolveHookRefusalReason,
} from "./hook-refusal-visibility.js";
import {
  readHookErrorMessage,
  resolveHookFailureOutcome,
} from "./runner-helpers.js";
import {
  emitHookLifecycleEvent,
  runHookCallbackWithTimeout,
  sanitizeHookDiagnostics,
  unwrapHookCallbackResult,
  type HookRunnerExecutionContext,
} from "./runner-lifecycle.js";
import type { HookChainWalkState } from "./runner-chain-types.js";
import type {
  HookMiddlewareNext,
  HookRegistration,
  HookRunResult,
} from "./types.js";

/** 单环节结算结论：continue = 走查推进到下一环节；stop = 链已收口（短路或下游已跑完）。 */
export type HookLinkSettlement = "continue" | "stop";

/** 注入式续行：从 startIndex 起以 event 继续走查，结果并入 accumulator。 */
export type HookChainContinuation = (
  startIndex: number,
  event: HookInput,
  accumulator: HookRunResult,
) => Promise<void>;

/**
 * 执行一个前台环节并结算其生命周期事件。
 * - legacy：与既有顺序链行为逐一等价（dispatch → process → merge → emit），返回
 *   "continue"。
 * - middleware：收到冻结事件副本与 next；next(e') 以独立累加器跑下游段，结算时
 *   下游结果先并入、自身输出后并入（洋葱包裹序）；不调 next = 自答短路（下游
 *   零执行），返回 "stop"。失败（含 misuse/超时）按 fail-open：自身输出丢弃，
 *   在飞下游照跑完且结果照常并入（真实完成的执行不被 middleware 失败吞掉）。
 */
export async function dispatchHookLink(
  ctx: HookRunnerExecutionContext,
  input: {
    chain: HookChainWalkState;
    continueChain: HookChainContinuation;
    currentInput: HookInput;
    descriptor: HookExecutionDescriptor;
    hook: HookRegistration;
    hookIndex: number;
    hookRunId: string;
    result: HookRunResult;
    runtimeIndex: number;
    startedAt: number;
  },
): Promise<HookLinkSettlement> {
  const {
    chain,
    continueChain,
    currentInput,
    descriptor,
    hook,
    hookIndex,
    hookRunId,
    result,
    runtimeIndex,
    startedAt,
  } = input;
  const isMiddleware = hook.middleware === true;
  const nextState: HookMiddlewareNextState | undefined = isMiddleware
    ? createMiddlewareNextState()
    : undefined;
  const next = nextState
    ? createMiddlewareNext(nextState, runtimeIndex, currentInput, continueChain)
    : undefined;
  // 事件对象冻结纯值：middleware 收冻结副本；legacy 收 currentInput 原样
  // （位于 middleware 改写下风时 currentInput 本身已是冻结副本）。
  const dispatchInput = nextState ? freezeHookEvent(currentInput) : currentInput;

  try {
    const callbackResult = await runHookCallbackWithTimeout(
      ctx,
      hook,
      dispatchInput,
      runtimeIndex,
      chain.options.signal,
      next,
    );
    if (nextState) nextState.dispatchSettled = true;
    // next 已被调用（无论 callback 是否 await 到底）：先把下游段等完并并入，
    // 保证生命周期事件完整；未 await 的 next 属 misuse 但不影响链完整性，
    // 只记 debug 行（spec 一.3）。
    if (nextState?.called) {
      if (nextState.downstream) {
        const awaited = await nextState.downstream.then(
          () => "settled" as const,
          () => "rejected" as const,
        );
        if (awaited === "rejected") {
          ctx.logger?.debug("Hook middleware downstream segment rejected during settle", {
            event: "hook.middleware.downstream_rejected",
            hookEventName: currentInput.hookEventName,
            module: "core.hooks",
            source: hook.source,
          });
        }
      }
      if (nextState.downstreamResult) mergeHookRunResult(result, nextState.downstreamResult);
    }
    const { output, diagnostics } = unwrapHookCallbackResult(callbackResult);
    const durationMs = Date.now() - startedAt;
    const processed = processHookOutput(currentInput.hookEventName, output);
    // 防滥用硬化（specs/hook-additional-context-hardening.md）：环节结算点是 hook 输出
    // → additionalContexts 的唯一收集写入路径——每条 8KB 截断 + 来源 hook 名标注
    // （与失败可见性共用同一名字解析器）；条数上限在 mergeHookRunResult 实施。
    hardenHookAdditionalContexts(
      processed,
      resolveHookRefusalName({ descriptor, source: hook.source }),
    );
    mergeHookRunResult(result, processed);
    const blocked =
      processed.permissionBehavior === "deny" ||
      processed.permissionRequestResult?.behavior === "deny" ||
      processed.preventContinuation ||
      processed.blockRequested;
    // 阻断原因必须随终态事件进入持久化投影；只放在 TurnResult/tooltip 会在
    // 重放或移动端恢复时丢失，用户无法从 Hooks 明细判断是哪条 Hook 拦截了请求。
    const blockReason = blocked
      ? sanitizeHookDisplayText(
          processed.stopReason ??
            processed.hookPermissionDecisionReason ??
            (processed.permissionRequestResult?.behavior === "deny"
              ? processed.permissionRequestResult.message
              : undefined) ??
            "Hook blocked execution",
        )
      : undefined;
    const safeDiagnostics = blocked ? sanitizeHookDiagnostics(diagnostics) : undefined;

    await emitHookLifecycleEvent(
      ctx,
      blocked ? SessionEventType.HookRunBlocked : SessionEventType.HookRunCompleted,
      currentInput,
      chain.hookInvocationId,
      hookRunId,
      hookIndex,
      chain.clientVisibleHookCount,
      hook,
      descriptor,
      startedAt,
      {
        durationMs,
        outcome: blocked ? HookOutcome.Blocked : HookOutcome.Success,
        ...(blockReason ? { blockReason } : {}),
        ...(safeDiagnostics?.errorMessage ? { errorMessage: safeDiagnostics.errorMessage } : {}),
        ...(safeDiagnostics?.stderrPreview ? { stderrPreview: safeDiagnostics.stderrPreview } : {}),
        ...(safeDiagnostics?.stdoutPreview ? { stdoutPreview: safeDiagnostics.stdoutPreview } : {}),
      },
    );
    // middleware 成功结算即链收口：调过 next ⇒ 下游已跑完；没调 ⇒ 自答短路。
    return nextState ? "stop" : "continue";
  } catch (error) {
    if (nextState) nextState.dispatchSettled = true;
    const durationMs = Date.now() - startedAt;
    const outcome = resolveHookFailureOutcome(error);
    const errorMessage = sanitizeHookDisplayText(readHookErrorMessage(error));
    // 失败可见性（执行失败）：闭集原因 + 注记行；fail-open 裁决不变——本环节
    // 输出丢弃，业务动作放行。
    const refusalReason = resolveHookRefusalReason({ error });
    const { payloadExtra } = createHookRefusalObservability({
      event: currentInput,
      hookName: resolveHookRefusalName({ descriptor, source: hook.source }),
      logger: ctx.logger,
      reason: refusalReason,
      source: hook.source,
    });
    await emitHookLifecycleEvent(
      ctx,
      SessionEventType.HookRunFailed,
      currentInput,
      chain.hookInvocationId,
      hookRunId,
      hookIndex,
      chain.clientVisibleHookCount,
      hook,
      descriptor,
      startedAt,
      {
        durationMs,
        errorCode: isCoreError(error) ? error.code : undefined,
        errorMessage,
        outcome,
        stderrPreview: errorMessage,
        ...payloadExtra,
      },
    );

    ctx.logger?.warn("Hook execution failed", {
      ...traceContextToLogContext({
        traceId: currentInput.traceId,
        sessionId: currentInput.sessionId,
        turnId: currentInput.turnId,
      }),
      durationMs,
      event: "hook.run.failed",
      hookEventName: currentInput.hookEventName,
      hookIndex,
      matcher: hook.matcher,
      module: "core.hooks",
      source: hook.source,
    });
    // middleware 失败但 next 已发起：下游段等完、结果照常并入（真实完成的执行
    // 不被吞掉），链已覆盖后续环节 ⇒ stop。next 未发起（或改写校验失败、下游
    // 从未启动）的 middleware 失败按 fail-open 视作环节缺席，链继续。
    if (nextState?.called && nextState.downstream) {
      await nextState.downstream.then(
        () => undefined,
        () => undefined,
      );
      if (nextState.downstreamResult) mergeHookRunResult(result, nextState.downstreamResult);
      return "stop";
    }
    return "continue";
  }
}

/**
 * middleware 环节的 next 工厂：至多一次、只许 dispatch 期间发起；next(e') 经
 * 身份字段钉死校验后成为下游所见事件。下游段在独立累加器上跑（环节级错误已被
 * 走查层各环节自含，这里的 Promise 只在 emit 故障时才 reject——由结算点兜底收敛）。
 */
function createMiddlewareNext(
  nextState: HookMiddlewareNextState,
  runtimeIndex: number,
  currentInput: HookInput,
  continueChain: HookChainContinuation,
): HookMiddlewareNext {
  return (rewrite?: HookInput) => {
    if (nextState.called) {
      return Promise.reject(
        createHookMiddlewareMisuseError("Hook middleware called next() more than once"),
      );
    }
    if (nextState.dispatchSettled) {
      return Promise.reject(
        createHookMiddlewareMisuseError(
          "Hook middleware called next() after its dispatch settled",
        ),
      );
    }
    nextState.called = true;
    let downstreamInput: HookInput;
    try {
      downstreamInput =
        rewrite === undefined
          ? freezeHookEvent(currentInput)
          : validateHookEventRewrite(currentInput, rewrite);
    } catch (error) {
      // 校验失败 = misuse：called 已置位但下游从未启动——以 rejection 让 middleware
      // 环节按失败语义收敛（fail-open，链继续）。
      return Promise.reject(error);
    }
    const downstreamResult: HookRunResult = { additionalContexts: [] };
    nextState.downstreamResult = downstreamResult;
    nextState.downstream = continueChain(runtimeIndex + 1, downstreamInput, downstreamResult);
    return nextState.downstream.then(() => downstreamResult);
  };
}
