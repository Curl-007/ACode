import { isBypassPermissionMode, resolveExecutionState, type ExecutionState } from "@acode/shared";
import {
  SESSION_ENTRY_EXECUTION_STATE,
  SessionEventType,
  type TraceContext,
  type SessionId,
  type SessionEntryInfo,
} from "@acode/contracts";
import type { AgentRuntimeInternal } from "./internal.js";
import {
  unpublishedPermissionGrants,
  recoverPendingPermissionGrant,
} from "./permission-grant-recovery.js";

export function readRuntimeExecutionState(runtime: AgentRuntimeInternal): ExecutionState {
  return resolveExecutionState(runtime.config);
}

async function persistExecutionState(
  runtime: AgentRuntimeInternal,
  state = readRuntimeExecutionState(runtime),
): Promise<void> {
  if (!runtime.sessionPersisted || !runtime.sessionStore?.saveSessionEntry) return;
  await runtime.sessionStore.saveSessionEntry(buildExecutionStateEntry(runtime.sessionId, state));
}

export function buildExecutionStateEntry(
  sessionId: SessionId,
  state: ExecutionState,
): SessionEntryInfo {
  const timestamp = Date.now();
  return {
    id: `${sessionId}:runtime-execution-state`,
    sessionID: sessionId,
    type: SESSION_ENTRY_EXECUTION_STATE,
    touchSession: false,
    time: { created: timestamp, updated: timestamp },
    data: state,
  };
}

/** 权限与 Plan 是一个已消费状态；保存失败不发布成功快照，也不提前改内存。 */
export async function applyRuntimeExecutionState(
  runtime: AgentRuntimeInternal,
  input: { mode?: string; planEnabled?: boolean },
  cause: { source: "command" | "tool"; toolCallId?: string; traceContext?: TraceContext },
): Promise<ExecutionState> {
  if (runtime.permissionFullAccessPending)
    throw new Error("Permission update is busy; retry mode change");
  if (unpublishedPermissionGrants.has(runtime)) await recoverPendingPermissionGrant(runtime);
  const previous = readRuntimeExecutionState(runtime);
  const next = resolveExecutionState(input, previous);
  if (next.mode === previous.mode && next.planEnabled === previous.planEnabled) return next;
  // 安全加固 P2（R4）：托管策略地板禁用 bypass 时，显式切换到全权限档（yolo/bypassPermissions）
  // 被拒。决策层的跳过（PermissionService 的 yolo 分支）是安全底线；这里让模式切换本身
  // 也失败，避免 UI 显示「已进 yolo」而实际按 build 判定的分裂状态。
  if (
    next.mode !== previous.mode &&
    isBypassPermissionMode(next.mode) &&
    runtime.permissionService.isBypassPermissionsModeDisabled()
  ) {
    throw new Error("modePolicyForbidden: managed policy disables bypass permission modes");
  }
  if (next.planEnabled && !previous.planEnabled) {
    const goal = await runtime.readSessionTargetForContext?.(
      cause.traceContext ?? runtime.rootTraceContext,
    );
    if (goal?.status === "active")
      throw new Error("Plan and Goal cannot be active at the same time.");
  }
  await persistExecutionState(runtime, next);
  runtime.config.mode = next.mode;
  runtime.config.planEnabled = next.planEnabled;
  if (previous.planEnabled !== next.planEnabled)
    runtime.needsPlanModeExitReminder = !next.planEnabled;
  const trace = cause.traceContext ?? runtime.rootTraceContext;
  await runtime.appendEvent(
    runtime.createEvent(
      SessionEventType.SessionModeChanged,
      {
        ...next,
        previousMode: previous.mode,
        previousPlanEnabled: previous.planEnabled,
        source: cause.source,
        ...(cause.toolCallId ? { toolCallId: cause.toolCallId } : {}),
      },
      trace,
    ),
    trace,
  );
  return next;
}
