import { isBypassPermissionMode, resolveExecutionState, type ExecutionState } from "@acode/shared";
import {
  SESSION_ENTRY_EXECUTION_STATE,
  SessionEventType,
  type TraceContext,
  type SessionId,
  type SessionEntryInfo,
} from "@acode/contracts";
import type { AgentRuntimeInternal } from "./internal.js";
import { getRuntimeLifecyclePort } from "./runtime-lifecycle.js";
import { liveChildRuntimes } from "./subagent-child-registry.js";
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
  // 完全访问事后传播（specs/subagent-parent-inheritance.md R7）：进入 bypass 档时同步广播到
  // 同谱系活 child runtime；孙级由 child 的 apply 递归触达，无需手写递归。只对「非 bypass →
  // bypass」的跃迁触发，bypass 内部换档（yolo ↔ bypassPermissions）不重播。
  if (isBypassPermissionMode(next.mode) && !isBypassPermissionMode(previous.mode)) {
    await propagateBypassModeToLiveChildren(runtime, {
      source: cause.source,
      ...(cause.toolCallId ? { toolCallId: cause.toolCallId } : {}),
      traceContext: cause.traceContext,
    });
  }
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
  if (previous.planEnabled && !next.planEnabled)
    getRuntimeLifecyclePort(runtime).armPlanModeExitReminder();
  return next;
}

/**
 * 完全访问事后传播（specs/subagent-parent-inheritance.md R7）：把父 runtime 当前模式
 * 广播到注册表里的活 child runtime。广播复用 applyRuntimeExecutionState——child 会话
 * 持久化、SessionModeChanged 事件审计、托管策略地板校验全部沿用既有语义，不新写第二条
 * 模式写入路径；孙级由 child 自己的 apply 递归触达。
 *
 * 语义边界：
 * - child 的 planEnabled 不随广播改变（语义 1）：resolveExecutionState 对只传
 *   { mode } 的合法非 plan 输入会把 planEnabled 归 false，这里显式回传 child 当前值。
 * - 单个 child 失败（托管地板 modePolicyForbidden / 授权 busy）warn-skip，不反抛、
 *   不回滚根授权（语义 2：部分传播优于整体失败，地板仍是底线）。
 * - child 已在 bypass 档时 apply 同档早退，无事件刷屏（语义 3）。
 */
export async function propagateBypassModeToLiveChildren(
  runtime: AgentRuntimeInternal,
  cause: { source: "command" | "tool"; toolCallId?: string; traceContext?: TraceContext },
): Promise<void> {
  for (const child of liveChildRuntimes(runtime)) {
    try {
      await applyRuntimeExecutionState(
        child,
        { mode: runtime.config.mode, planEnabled: child.config.planEnabled },
        {
          source: cause.source,
          ...(cause.toolCallId ? { toolCallId: cause.toolCallId } : {}),
          traceContext: cause.traceContext,
        },
      );
    } catch (error) {
      runtime.logger?.warn?.("Bypass mode propagation skipped a live child runtime", {
        event: "runtime.permission.propagation_skip",
        childSessionId: child.sessionId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
