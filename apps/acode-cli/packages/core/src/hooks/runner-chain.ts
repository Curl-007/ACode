// ============================================================
// Hook 链走查（runner.ts 拆分件二）——一期最小洋葱
// ============================================================
// specs/plugin-hook-middleware.md 一：无 middleware 注册时与既有顺序链逐一等价
// （每个环节 "continue"）；middleware 环节经 next 递归推进下游（next(e') 改写
// 下游所见）或以自答短路收口。环节结算与 next 工厂在 runner-link.ts（经注入的
// 续行闭包推进下游，避免模块环）。拆分依据见 runner-lifecycle.ts 头注；公开
// API 不变（InMemoryHookRunner 仍从 runner.ts 导出）。
import {
  HookOutcome,
  SessionEventType,
  traceContextToLogContext,
  type HookInput,
} from "@acode/contracts";
import { sanitizeHookDisplayText } from "./display-metadata.js";
import {
  createHookRefusalObservability,
  resolveHookRefusalName,
  resolveHookRefusalReason,
} from "./hook-refusal-visibility.js";
import {
  matchesAnyHookMatcher,
  resolveHookDescriptor,
  resolveHookRunAdmission,
} from "./runner-helpers.js";
import {
  emitHookLifecycleEvent,
  runBackgroundHook,
  type HookRunnerExecutionContext,
} from "./runner-lifecycle.js";
import { dispatchHookLink } from "./runner-link.js";
import type { HookChainWalkState } from "./runner-chain-types.js";
import type { HookRegistration, HookRunOptions, HookRunResult } from "./types.js";

/** 链走查入口：预扫描（admission/skipLifecycle 剔除）由调用方完成后传入参与环节。 */
export async function runHookChain(input: {
  ctx: HookRunnerExecutionContext;
  event: HookInput;
  hookInvocationId: string;
  options: HookRunOptions;
  participatingHooks: readonly { hook: HookRegistration }[];
  result: HookRunResult;
}): Promise<void> {
  const { ctx, event, hookInvocationId, options, participatingHooks, result } = input;
  const clientVisibleHookCount = participatingHooks.filter(
    ({ hook }) => resolveHookDescriptor(hook, ctx.defaultTimeoutMs, event).clientVisible,
  ).length;
  const chain: HookChainWalkState = {
    clientVisibleHookCount,
    clientVisibleHookIndex: { value: 0 },
    hookInvocationId,
    options,
  };
  await runChainFrom(ctx, participatingHooks, 0, event, result, chain);
}

/** 匹配过滤（run() 预扫描用；与链走查同文件保持单一形状事实源）。 */
export function selectMatchingHooks(
  hooks: readonly HookRegistration[],
  input: HookInput,
  options: HookRunOptions,
): HookRegistration[] {
  return hooks.filter(
    (hook) => hook.event === input.hookEventName && matchesAnyHookMatcher(options, hook.matcher),
  );
}

/**
 * 从 startIndex 起顺序走查链环节；result 是本段合并目标（middleware 的 next 段
 * 用独立累加器，结算时并回，见 dispatchHookLink）。currentInput 是下游所见事件——
 * middleware next(e') 改写后，后续环节（含 legacy 与进程 hook 的 stdin 投影）
 * 一律看到改写值。
 */
async function runChainFrom(
  ctx: HookRunnerExecutionContext,
  links: readonly { hook: HookRegistration }[],
  startIndex: number,
  currentInput: HookInput,
  result: HookRunResult,
  chain: HookChainWalkState,
): Promise<void> {
  for (let runtimeIndex = startIndex; runtimeIndex < links.length; runtimeIndex += 1) {
    const { hook } = links[runtimeIndex]!;
    const descriptor = resolveHookDescriptor(hook, ctx.defaultTimeoutMs, currentInput);
    const hookIndex = descriptor.clientVisible
      ? chain.clientVisibleHookIndex.value++
      : runtimeIndex;
    const hookRunId = crypto.randomUUID();
    const startedAt = Date.now();
    // dispatch 前重新解析授权决定。预扫描结果可能已过时——前序 Hook
    // 执行期间用户 revoke、管理员收紧 policy 或 trust store reload 都会改变
    // 结论。security revision 的价值就在执行边界重验，授权决定不得缓存。
    const admission = resolveHookRunAdmission(hook, currentInput, ctx.logger);
    if (!admission.allowed) {
      // 失败可见性（admission 拒绝）：hook 未执行，引擎默认行为生效——闭集原因 +
      // 注记行进 payload（本会话 transcript 通道）与 debug log（全部会话）。
      const refusalReason = resolveHookRefusalReason({
        admissionReasonCode: admission.reasonCode,
      });
      const { payloadExtra } = createHookRefusalObservability({
        event: currentInput,
        hookName: resolveHookRefusalName({ descriptor, source: hook.source }),
        logger: ctx.logger,
        reason: refusalReason,
        source: hook.source,
      });
      await emitHookLifecycleEvent(
        ctx,
        SessionEventType.HookRunBlocked,
        currentInput,
        chain.hookInvocationId,
        hookRunId,
        hookIndex,
        chain.clientVisibleHookCount,
        hook,
        descriptor,
        startedAt,
        {
          durationMs: 0,
          errorCode: admission.reasonCode,
          outcome: HookOutcome.Blocked,
          ...(admission.reasonCode
            ? { blockReason: sanitizeHookDisplayText(admission.reasonCode) }
            : {}),
          ...payloadExtra,
        },
      );
      continue;
    }
    await emitHookLifecycleEvent(
      ctx,
      SessionEventType.HookRunStarted,
      currentInput,
      chain.hookInvocationId,
      hookRunId,
      hookIndex,
      chain.clientVisibleHookCount,
      hook,
      descriptor,
      startedAt,
    );

    if (hook.async) {
      if (hook.middleware) {
        // async 与 middleware 互斥：后台派发脱离链，无法参与洋葱——async 胜出，
        // middleware 标志忽略（spec 一.6）。
        ctx.logger?.debug("Async hook registration ignores middleware flag", {
          event: "hook.middleware.ignored_async",
          hookEventName: currentInput.hookEventName,
          module: "core.hooks",
          source: hook.source,
        });
      }
      // async command 的生命周期独立于当前 turn；输出不得反向改变已经继续执行的动作。
      void runBackgroundHook(ctx, {
        clientVisibleHookCount: chain.clientVisibleHookCount,
        descriptor,
        hook,
        hookIndex,
        hookInvocationId: chain.hookInvocationId,
        hookRunId,
        input: currentInput,
        parentSignal: chain.options.signal,
        runtimeIndex,
        startedAt,
      }).catch((error) => {
        ctx.logger?.warn("Async hook lifecycle reporting failed", {
          ...traceContextToLogContext({
            traceId: currentInput.traceId,
            sessionId: currentInput.sessionId,
            turnId: currentInput.turnId,
          }),
          error: error instanceof Error ? error.message : String(error),
          event: "hook.run.async_reporting_failed",
          hookEventName: currentInput.hookEventName,
          hookIndex,
          module: "core.hooks",
          source: hook.source,
        });
      });
      continue;
    }

    const settlement = await dispatchHookLink(ctx, {
      chain,
      continueChain: (fromIndex, event, accumulator) =>
        runChainFrom(ctx, links, fromIndex, event, accumulator, chain),
      currentInput,
      descriptor,
      hook,
      hookIndex,
      hookRunId,
      result,
      runtimeIndex,
      startedAt,
    });
    if (settlement === "stop") return;
  }
}
