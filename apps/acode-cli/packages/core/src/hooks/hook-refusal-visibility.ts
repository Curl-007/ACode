// ============================================================
// Hook 失败可见性协议（specs/plugin-hook-middleware.md 二）
// ============================================================
// 裁决：hook「被拒」= 未执行（admission/trust 拒绝）或执行失败（超时/取消/进程失败/
// 输出校验失败/中间件 misuse）。每个被拒执行都必须留下带闭集原因的可观测行：
// - 本会话 transcript：注记随生命周期事件 payload（refusalReason/refusalAnnotation）；
// - 全部会话：无条件 debug log（子会话/后台 runtime/无投影会话的可观测兜底）。
// 注记绝不改变 fail-open 结果——只增可观测性，不改业务裁决。
// 单源纪律：注记只在 runner 的拒绝/失败结算点生成（唯一写入路径）。
import {
  CoreErrorType,
  isCoreError,
  traceContextToLogContext,
  workspaceHookReasonCodeSchema,
  type HookExecutionDescriptor,
  type HookInput,
  type Logger,
  type WorkspaceHookReasonCode,
} from "@acode/contracts";
import { sanitizeHookDisplayText } from "./display-metadata.js";

/** 执行失败侧的闭集原因（admission 侧透传既有 WorkspaceHookReasonCode 闭集）。 */
export const HOOK_FAILURE_REFUSAL_REASONS = {
  timeout: "hook_timeout",
  cancelled: "hook_cancelled",
  processFailed: "hook_process_failed",
  outputInvalid: "hook_output_invalid",
  middlewareMisuse: "hook_middleware_misuse",
  failed: "hook_failed",
} as const;

export type HookRefusalReason =
  | WorkspaceHookReasonCode
  | (typeof HOOK_FAILURE_REFUSAL_REASONS)[keyof typeof HOOK_FAILURE_REFUSAL_REASONS];

/**
 * 闭集归一：admission 拒绝透传 reasonCode（本身已是 contracts 闭集；未知字符串
 * 收敛为兜底 hook_failed，保证注记原因永远落在闭集内）；执行失败按 CoreError 的
 * type 与 context.refusalKind 判别（打标点：configured-runner-callback.ts 两类
 * ToolExecutionFailed、hook-middleware.ts misuse）。
 */
export function resolveHookRefusalReason(input: {
  admissionReasonCode?: string;
  error?: unknown;
}): HookRefusalReason {
  if (input.admissionReasonCode !== undefined) {
    const parsed = workspaceHookReasonCodeSchema.safeParse(input.admissionReasonCode);
    return parsed.success ? parsed.data : HOOK_FAILURE_REFUSAL_REASONS.failed;
  }
  const error = input.error;
  if (!isCoreError(error)) return HOOK_FAILURE_REFUSAL_REASONS.failed;
  if (error.type === CoreErrorType.ToolTimeout) return HOOK_FAILURE_REFUSAL_REASONS.timeout;
  if (error.type === CoreErrorType.ToolCancelled) return HOOK_FAILURE_REFUSAL_REASONS.cancelled;
  const refusalKind = error.context?.refusalKind;
  if (refusalKind === "middleware_misuse") return HOOK_FAILURE_REFUSAL_REASONS.middlewareMisuse;
  if (refusalKind === "process_failed") return HOOK_FAILURE_REFUSAL_REASONS.processFailed;
  if (refusalKind === "output_invalid") return HOOK_FAILURE_REFUSAL_REASONS.outputInvalid;
  return HOOK_FAILURE_REFUSAL_REASONS.failed;
}

/** 注记里的 hook 名：展示命令优先，其次注册 source，最后兜底 "hook"；一律消毒截断。 */
export function resolveHookRefusalName(input: {
  descriptor?: HookExecutionDescriptor;
  source?: string;
}): string {
  const raw = input.descriptor?.commandDisplay?.trim() || input.source?.trim() || "hook";
  return sanitizeHookDisplayText(raw) || "hook";
}

/**
 * 注记行格式（自撰，specs/plugin-hook-middleware.md 二.2）：
 * `<hook 名>: <事件> 被拒: <闭集原因>; 已用引擎默认行为`
 */
export function formatHookRefusalAnnotation(input: {
  hookEventName: string;
  hookName: string;
  reason: HookRefusalReason;
}): string {
  return `${input.hookName}: ${input.hookEventName} 被拒: ${input.reason}; 已用引擎默认行为`;
}

/**
 * debug 通道（全部会话无条件）：每次被拒一行，携带注记全文与结构化字段。
 * `event:"hook.refusal.annotation"` 是检索键；高频诊断走 debug，生产不落盘
 * （AGENTS.md 日志分级）。
 */
export function logHookRefusalDebug(
  logger: Logger | undefined,
  input: HookInput,
  fields: {
    annotation: string;
    async?: boolean;
    reason: HookRefusalReason;
    source?: string;
  },
): void {
  logger?.debug("Hook refusal annotation", {
    ...traceContextToLogContext({
      traceId: input.traceId,
      sessionId: input.sessionId,
      turnId: input.turnId,
    }),
    event: "hook.refusal.annotation",
    hookEventName: input.hookEventName,
    module: "core.hooks",
    refusalAnnotation: fields.annotation,
    refusalReason: fields.reason,
    ...(fields.async ? { async: true } : {}),
    ...(fields.source ? { source: fields.source } : {}),
  });
}

/**
 * 一次拒绝结算的可观测产物：payload 增补字段（transcript 通道，旧投影忽略之，
 * 零破坏）+ debug 行。runner 的 admission 拒绝点与失败 catch 点是唯一调用方。
 */
export function createHookRefusalObservability(input: {
  event: HookInput;
  hookName: string;
  logger: Logger | undefined;
  reason: HookRefusalReason;
  source?: string;
  async?: boolean;
}): { payloadExtra: { refusalAnnotation: string; refusalReason: HookRefusalReason } } {
  const annotation = formatHookRefusalAnnotation({
    hookEventName: input.event.hookEventName,
    hookName: input.hookName,
    reason: input.reason,
  });
  logHookRefusalDebug(input.logger, input.event, {
    annotation,
    reason: input.reason,
    source: input.source,
    async: input.async,
  });
  return { payloadExtra: { refusalAnnotation: annotation, refusalReason: input.reason } };
}
