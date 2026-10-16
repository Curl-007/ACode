// ============================================================
// Hook 环节生命周期原语（runner.ts 拆分件一）
// ============================================================
// 拆分依据：中间件链语义落地后 runner.ts 逼近 400 行 ratchet 的两倍，按仓库先例
// （runtime/methods/hooks.ts → hooks-extended.ts）拆分；本文件承载与链走查无关的
// 环节级原语——生命周期事件发射、带超时的 callback 派发、async 后台环节结算、
// callback 结果解包与诊断消毒。公开 API 不变：InMemoryHookRunner 仍从 runner.ts
// 导出，本文件只被 runner.ts / runner-chain.ts 消费。
import {
  HookOutcome,
  SessionEventType,
  isCoreError,
  traceContextToLogContext,
  type HookExecutionDescriptor,
  type HookInput,
  type HookJSONOutput,
  type Logger,
  type SessionEvent,
} from "@acode/contracts";
import { sanitizeHookDisplayText } from "./display-metadata.js";
import { createHookRefusalObservability, resolveHookRefusalName, resolveHookRefusalReason } from "./hook-refusal-visibility.js";
import {
  HOOK_TIMEOUT_ABORT_REASON,
  createHookCancelledError,
  createHookTimeoutError,
  linkAbortSignal,
  readHookErrorMessage,
  resolveHookFailureOutcome,
} from "./runner-helpers.js";
import type {
  HookCallbackDiagnostics,
  HookCallbackResult,
  HookMiddlewareNext,
  HookRegistration,
} from "./types.js";

/** 环节级原语所需的最小 runner 面（由 InMemoryHookRunner 装配后传入）。 */
export interface HookRunnerExecutionContext {
  defaultTimeoutMs: number;
  emitEvent?: (event: SessionEvent) => Promise<void>;
  logger?: Logger;
}

export async function emitHookLifecycleEvent(
  ctx: HookRunnerExecutionContext,
  type: SessionEventType,
  input: HookInput,
  hookInvocationId: string,
  hookRunId: string,
  hookIndex: number,
  hookCount: number,
  hook: HookRegistration,
  descriptor: HookExecutionDescriptor,
  startedAt: number,
  extra: Partial<SessionEvent["payload"] & Record<string, unknown>> = {},
): Promise<void> {
  if (!ctx.emitEvent) return;
  await ctx.emitEvent({
    id: crypto.randomUUID() as never,
    sessionId: input.sessionId,
    turnId: input.turnId,
    type,
    timestamp: type === SessionEventType.HookRunStarted ? new Date(startedAt) : new Date(),
    traceId: input.traceId,
    sequenceNumber: 0,
    payload: {
      agentName: input.agentName,
      descriptor,
      hookEventName: input.hookEventName,
      hookIndex,
      hookCount,
      hookInvocationId,
      hookRunId,
      hookSource: hook.source,
      matcher: hook.matcher,
      requestId: "requestId" in input ? input.requestId : undefined,
      startedAt,
      toolCallId: "toolCallId" in input ? input.toolCallId : undefined,
      toolName: "toolName" in input ? input.toolName : undefined,
      ...extra,
    },
  });
}

export async function runHookCallbackWithTimeout(
  ctx: HookRunnerExecutionContext,
  hook: HookRegistration,
  input: HookInput,
  hookIndex: number,
  parentSignal?: AbortSignal,
  next?: HookMiddlewareNext,
): Promise<HookJSONOutput | HookCallbackResult | void> {
  const timeoutMs = hook.timeoutMs ?? ctx.defaultTimeoutMs;
  const controller = new AbortController();
  const unlink = linkAbortSignal(parentSignal, controller);
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await new Promise<HookJSONOutput | HookCallbackResult | void>((resolve, reject) => {
      if (controller.signal.aborted) {
        reject(createHookCancelledError());
        return;
      }

      timer = setTimeout(() => {
        controller.abort(HOOK_TIMEOUT_ABORT_REASON);
        reject(createHookTimeoutError(timeoutMs));
      }, timeoutMs);
      timer.unref?.();

      controller.signal.addEventListener(
        "abort",
        () => {
          reject(
            controller.signal.reason === HOOK_TIMEOUT_ABORT_REASON
              ? createHookTimeoutError(timeoutMs)
              : createHookCancelledError(),
          );
        },
        { once: true },
      );

      // next 只对 middleware 注册提供（legacy callback 的 context 形状不变）。
      Promise.resolve(
        hook.callback(input, {
          hookIndex,
          signal: controller.signal,
          ...(next ? { next } : {}),
        }),
      ).then(resolve, reject);
    });
  } finally {
    if (timer) clearTimeout(timer);
    unlink();
  }
}

export async function runBackgroundHook(
  ctx: HookRunnerExecutionContext,
  options: {
    clientVisibleHookCount: number;
    descriptor: HookExecutionDescriptor;
    hook: HookRegistration;
    hookIndex: number;
    hookInvocationId: string;
    hookRunId: string;
    input: HookInput;
    parentSignal: AbortSignal | undefined;
    runtimeIndex: number;
    startedAt: number;
  },
): Promise<void> {
  const {
    clientVisibleHookCount,
    descriptor,
    hook,
    hookIndex,
    hookInvocationId,
    hookRunId,
    input,
    parentSignal,
    runtimeIndex,
    startedAt,
  } = options;
  try {
    await runHookCallbackWithTimeout(ctx, hook, input, runtimeIndex, parentSignal);
    await emitHookLifecycleEvent(
      ctx,
      SessionEventType.HookRunCompleted,
      input,
      hookInvocationId,
      hookRunId,
      hookIndex,
      clientVisibleHookCount,
      hook,
      descriptor,
      startedAt,
      {
        durationMs: Date.now() - startedAt,
        outcome: HookOutcome.Success,
      },
    );
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const outcome = resolveHookFailureOutcome(error);
    const errorMessage = sanitizeHookDisplayText(readHookErrorMessage(error));
    // 失败可见性：后台环节与前台同规——每次被拒都有闭集原因 + 注记行
    //（payload 走本会话事件通道，debug log 无条件）。
    const { payloadExtra } = createHookRefusalObservability({
      event: input,
      hookName: resolveHookRefusalName({ descriptor, source: hook.source }),
      logger: ctx.logger,
      reason: resolveHookRefusalReason({ error }),
      source: hook.source,
      async: true,
    });
    await emitHookLifecycleEvent(
      ctx,
      SessionEventType.HookRunFailed,
      input,
      hookInvocationId,
      hookRunId,
      hookIndex,
      clientVisibleHookCount,
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
    ctx.logger?.warn("Async hook execution failed", {
      ...traceContextToLogContext({
        traceId: input.traceId,
        sessionId: input.sessionId,
        turnId: input.turnId,
      }),
      durationMs,
      event: "hook.run.async_failed",
      hookEventName: input.hookEventName,
      hookIndex,
      matcher: hook.matcher,
      module: "core.hooks",
      source: hook.source,
    });
  }
}

export function unwrapHookCallbackResult(result: HookJSONOutput | HookCallbackResult | void): {
  output: HookJSONOutput | undefined;
  diagnostics: HookCallbackDiagnostics | undefined;
} {
  if (isHookCallbackResult(result)) {
    return { output: result.output, diagnostics: result.diagnostics };
  }
  return { output: result as HookJSONOutput | undefined, diagnostics: undefined };
}

function isHookCallbackResult(value: unknown): value is HookCallbackResult {
  return Boolean(
    value &&
      typeof value === "object" &&
      "kind" in value &&
      (value as { kind?: unknown }).kind === "hookCallbackResult",
  );
}

export function sanitizeHookDiagnostics(
  diagnostics: HookCallbackDiagnostics | undefined,
): HookCallbackDiagnostics | undefined {
  if (!diagnostics) return undefined;
  const sanitize = (value: string | undefined): string | undefined => {
    const trimmed = value?.trim();
    return trimmed ? sanitizeHookDisplayText(trimmed).slice(0, 4000) : undefined;
  };
  const errorMessage = sanitize(diagnostics.errorMessage);
  const stderrPreview = sanitize(diagnostics.stderrPreview);
  const stdoutPreview = sanitize(diagnostics.stdoutPreview);
  if (!errorMessage && !stderrPreview && !stdoutPreview) return undefined;
  return {
    ...(errorMessage ? { errorMessage } : {}),
    ...(stderrPreview ? { stderrPreview } : {}),
    ...(stdoutPreview ? { stdoutPreview } : {}),
  };
}
