import {
  CoreErrorType,
  HookEventName,
  isCoreError,
  type CollaborationMode,
  type PermissionBrokerResult,
  type ToolCallId,
  type TraceContext,
} from "@acode/contracts";
import { formatHookContextEntryHeader } from "../../hooks/index.js";
import type { HookRunResult } from "../../hooks/index.js";
import type { PermissionDecisionResult } from "../../permission/service.js";
import { hookMatcherToolNamesForTool } from "../compat.js";
import type { ExecutableToolCall, ToolEntry } from "../types.js";
import type { ToolExecutorDeps } from "./types.js";
import { previewHookValue } from "./utils.js";

export async function runPreToolUseHooks(
  deps: ToolExecutorDeps,
  toolCall: ExecutableToolCall,
  input: unknown,
  entry: ToolEntry,
  mode: CollaborationMode,
  traceContext: TraceContext,
  signal?: AbortSignal,
): Promise<HookRunResult> {
  if (!deps.hookRunner) return { additionalContexts: [] };
  return deps.hookRunner.run(
    {
      cwd: deps.getWorkingDirectory(),
      hookEventName: HookEventName.PreToolUse,
      mode,
      riskLevel: entry.metadata.riskLevel,
      sessionId: deps.sessionId,
      sideEffectScope: entry.metadata.sideEffectScope,
      timestamp: new Date().toISOString(),
      toolCallId: toolCall.id,
      toolInput: input,
      toolName: toolCall.name,
      traceId: traceContext.traceId,
      turnId: traceContext.turnId ?? deps.turnId,
    },
    {
      matchValue: toolCall.name,
      matchValues: hookMatcherToolNamesForTool(toolCall.name),
      signal,
    },
  );
}

export async function runPermissionRequestHooks(
  deps: ToolExecutorDeps,
  toolCall: ExecutableToolCall,
  input: unknown,
  requestId: string,
  permissionDecision: PermissionDecisionResult,
  mode: CollaborationMode,
  traceContext: TraceContext,
  signal?: AbortSignal,
): Promise<PermissionBrokerResult | undefined> {
  if (!deps.hookRunner) return undefined;
  const hookResult = await deps.hookRunner.run(
    {
      cwd: deps.getWorkingDirectory(),
      hookEventName: HookEventName.PermissionRequest,
      mode,
      reason: permissionDecision.reason ?? `Tool ${toolCall.name} requires approval`,
      requestId,
      riskLevel: permissionDecision.riskLevel,
      sessionId: deps.sessionId,
      sideEffectScope: permissionDecision.sideEffectScope,
      timestamp: new Date().toISOString(),
      toolCallId: toolCall.id,
      toolInput: input,
      toolName: toolCall.name,
      traceId: traceContext.traceId,
      turnId: traceContext.turnId ?? deps.turnId,
    },
    {
      matchValue: toolCall.name,
      matchValues: hookMatcherToolNamesForTool(toolCall.name),
      signal,
    },
  );
  const decision = hookResult.permissionRequestResult;
  if (hookResult.preventContinuation) {
    return {
      decision: "deny",
      reason: hookResult.stopReason ?? "Denied by PermissionRequest hook",
    };
  }
  if (!decision) {
    if (hookResult.permissionBehavior === "deny") {
      return {
        decision: "deny",
        reason: hookResult.stopReason ?? "Denied by PermissionRequest hook",
      };
    }
    return hookResult.permissionBehavior === "allow"
      ? {
          decision: "allow",
          reason: "Allowed by PermissionRequest hook",
        }
      : undefined;
  }
  if (decision.behavior === "deny") {
    return {
      decision: "deny",
      reason: decision.message ?? "Denied by PermissionRequest hook",
    };
  }
  const permissionUpdates = decision.permissionUpdates ?? decision.updatedPermissions;
  return decision.updatedInput === undefined
    ? {
        decision: "allow",
        permissionUpdates,
        reason: "Allowed by PermissionRequest hook",
      }
    : {
        decision: "modify",
        modifiedInput: decision.updatedInput,
        permissionUpdates,
        reason: "Allowed with modified input by PermissionRequest hook",
      };
}

export async function runPostToolUseHooks(
  deps: ToolExecutorDeps,
  toolCall: ExecutableToolCall,
  input: unknown,
  output: unknown,
  artifactPath: string | undefined,
  traceContext: TraceContext,
  signal?: AbortSignal,
): Promise<HookRunResult> {
  if (!deps.hookRunner) return { additionalContexts: [] };
  return deps.hookRunner.run(
    {
      artifactRefs: artifactPath ? [artifactPath] : undefined,
      cwd: deps.getWorkingDirectory(),
      hookEventName: HookEventName.PostToolUse,
      mode: deps.getMode(),
      sessionId: deps.sessionId,
      timestamp: new Date().toISOString(),
      toolCallId: toolCall.id,
      toolInput: input,
      toolName: toolCall.name,
      toolResponse: output,
      toolResultPreview: previewHookValue(output),
      traceId: traceContext.traceId,
      turnId: traceContext.turnId ?? deps.turnId,
    },
    {
      matchValue: toolCall.name,
      matchValues: hookMatcherToolNamesForTool(toolCall.name),
      signal,
    },
  );
}

export async function runPostToolUseFailureHooks(
  deps: ToolExecutorDeps,
  toolCall: ExecutableToolCall,
  input: unknown,
  error: unknown,
  traceContext: TraceContext,
  signal?: AbortSignal,
): Promise<HookRunResult> {
  if (!deps.hookRunner) return { additionalContexts: [] };
  const normalized = error instanceof Error ? error : new Error(String(error));
  return deps.hookRunner.run(
    {
      cwd: deps.getWorkingDirectory(),
      error: {
        message: normalized.message,
        type: isCoreError(normalized) ? normalized.type : normalized.name,
      },
      hookEventName: HookEventName.PostToolUseFailure,
      isInterrupt: isCoreError(normalized) && normalized.type === CoreErrorType.ToolCancelled,
      mode: deps.getMode(),
      sessionId: deps.sessionId,
      timestamp: new Date().toISOString(),
      toolCallId: toolCall.id,
      toolInput: input,
      toolName: toolCall.name,
      traceId: traceContext.traceId,
      turnId: traceContext.turnId ?? deps.turnId,
    },
    {
      matchValue: toolCall.name,
      matchValues: hookMatcherToolNamesForTool(toolCall.name),
      signal,
    },
  );
}

export interface TaskLifecycleHookInfo {
  description?: string;
  taskKind?: string;
  taskId: string;
  toolCallId?: ToolCallId | string;
  toolName?: string;
}

/**
 * TaskCreated：后台任务（bash/subagent/workflow）登记开始时。通知类；调用方
 * （background-tasks.ts）以 fire-and-forget 旁路执行——trackBackgroundTask 在工具
 * 结算路径上被 await，hook 不允许拖慢工具结果（specs/hook-event-surface.md）。
 */
export async function runTaskCreatedHooks(
  deps: ToolExecutorDeps,
  task: TaskLifecycleHookInfo,
  traceContext: TraceContext,
): Promise<HookRunResult> {
  if (!deps.hookRunner) return { additionalContexts: [] };
  return deps.hookRunner.run(
    {
      cwd: deps.getWorkingDirectory(),
      ...(task.description !== undefined ? { description: task.description } : {}),
      hookEventName: HookEventName.TaskCreated,
      mode: deps.getMode(),
      sessionId: deps.sessionId,
      ...(task.taskKind !== undefined ? { taskKind: task.taskKind } : {}),
      taskId: task.taskId,
      timestamp: new Date().toISOString(),
      ...(task.toolCallId !== undefined ? { toolCallId: task.toolCallId } : {}),
      ...(task.toolName !== undefined ? { toolName: task.toolName } : {}),
      traceId: traceContext.traceId,
      turnId: traceContext.turnId ?? deps.turnId,
    },
    { matchValue: task.toolName },
  );
}

/** TaskCompleted：后台任务进入终态（含 lost）时。通知类、异步旁路（同 TaskCreated）。 */
export async function runTaskCompletedHooks(
  deps: ToolExecutorDeps,
  task: TaskLifecycleHookInfo & { taskStatus: string },
  traceContext: TraceContext,
): Promise<HookRunResult> {
  if (!deps.hookRunner) return { additionalContexts: [] };
  return deps.hookRunner.run(
    {
      cwd: deps.getWorkingDirectory(),
      ...(task.description !== undefined ? { description: task.description } : {}),
      hookEventName: HookEventName.TaskCompleted,
      mode: deps.getMode(),
      sessionId: deps.sessionId,
      ...(task.taskKind !== undefined ? { taskKind: task.taskKind } : {}),
      taskId: task.taskId,
      // TODO(闭集): completed/failed/cancelled/killed/stopped/lost——待与 runtime-task
      // 终态词表统一收敛（specs/hook-event-surface.md F7）。
      taskStatus: task.taskStatus,
      timestamp: new Date().toISOString(),
      ...(task.toolCallId !== undefined ? { toolCallId: task.toolCallId } : {}),
      ...(task.toolName !== undefined ? { toolName: task.toolName } : {}),
      traceId: traceContext.traceId,
      turnId: traceContext.turnId ?? deps.turnId,
    },
    { matchValue: task.toolName },
  );
}

export function applyPreToolPermissionDecision(
  permissionDecision: PermissionDecisionResult,
  hookResult: HookRunResult,
  mode: CollaborationMode,
): PermissionDecisionResult {
  if (permissionDecision.decision === "deny") return permissionDecision;
  // alwaysAsk 声明出来的确认（如 workflow 运行确认）不能被 PreToolUse hook
  // 的整体 allow 悄悄抹掉——那等于给"任何模式都要问"开了一个静默后门。自动化仍有正规出口：
  // PermissionRequest hook 可以应答这次弹窗（见 runPermissionRequestHooks）。
  if (
    hookResult.permissionBehavior === "allow" &&
    permissionDecision.decision === "ask" &&
    !permissionDecision.alwaysAsk
  ) {
    return {
      ...permissionDecision,
      allowed: true,
      decision: "allow",
      escalated: false,
      mode,
      reason: hookResult.hookPermissionDecisionReason ?? "Tool was allowed by PreToolUse hook",
      ruleId: "hook.PreToolUse.allow",
    };
  }
  if (hookResult.permissionBehavior === "ask" && permissionDecision.decision === "allow") {
    return {
      ...permissionDecision,
      allowed: false,
      decision: "ask",
      escalated: true,
      mode,
      reason:
        hookResult.hookPermissionDecisionReason ?? "Tool requires approval by PreToolUse hook",
      ruleId: "hook.PreToolUse.ask",
    };
  }
  return permissionDecision;
}

export function formatHookAdditionalContexts(
  additionalContexts: string[],
  sources?: readonly (string | undefined)[],
): string {
  return [
    "[Hook additional context]",
    ...additionalContexts.map(
      (context, index) => `${formatHookContextEntryHeader(index, sources)}\n${context}`,
    ),
  ].join("\n");
}

/**
 * 组合多个 HookRunResult 的 contexts 与 sources（specs/hook-additional-context-hardening.md）：
 * 无源侧以 undefined 占位补齐索引对齐；全部无源时返回 undefined，formatter 输出与
 * 无 sources 参数的旧版逐字节一致（零回归保证）。
 */
export function concatHookContextSources(
  parts: readonly { contexts: readonly string[]; sources?: readonly (string | undefined)[] }[],
): (string | undefined)[] | undefined {
  if (parts.every((part) => part.sources === undefined)) return undefined;
  return parts.flatMap((part) =>
    part.sources !== undefined ? [...part.sources] : part.contexts.map(() => undefined),
  );
}
