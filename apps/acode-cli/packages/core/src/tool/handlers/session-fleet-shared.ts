// ============================================================
// Session Fleet Tool 共享件 - 守卫、追踪上下文与 entry 公共段
// (apps/acode-cli/specs/session-fleet.md R1)
// ============================================================
// 失败语义分层（escalate/worktree 同款裁决）：接线故障（端口缺席）throw
// ConfigurationError；业务边界回**拒绝结果**（闭集 reason），模型需要读到
// reason 改道而不是把可预期边界当可重试故障反复撞墙。

import { CoreErrorType, createCoreError, type TraceContext } from "@acode/contracts";
import type { FleetRejectReason } from "@acode/contracts";
import type { ToolExecutionContext } from "../types.js";
import { getFleetRegistry, type FleetRegistry } from "../../fleet/registry.js";
import type { FleetWorktreeDeps } from "../../fleet/worktree-provision.js";

export const FLEET_MAX_OUTPUT_BYTES = 16_000;

export interface FleetToolDeps {
  /** 测试注入；生产走进程单例（getSessionWorktreeManager 同款先例）。 */
  registry?: FleetRegistry;
  /** 测试注入 worktree manager/ledger/时钟。 */
  worktreeDeps?: FleetWorktreeDeps;
  /** note watcher 轮询间隔（测试注入小值；生产缺省 1s，notes.ts）。 */
  notePollIntervalMs?: number;
}

export function resolveFleetRegistry(deps: FleetToolDeps): FleetRegistry {
  return deps.registry ?? getFleetRegistry();
}

export type FleetRejection = {
  outcome: "rejected";
  reason: FleetRejectReason;
  message: string;
};

export function fleetRejection(reason: FleetRejectReason, message: string): FleetRejection {
  return { outcome: "rejected", reason, message };
}

/**
 * 无人值守派发轮守卫（spec R1）：automation / off-peak 轮里舰队变更面一律
 * 拒绝——舰队是用户可见面，无人观看时派生/路由/归档/删除都不该发生。
 * 纵深防御：turn-loop-state 的隐藏名单（WSJ 面）另行接线。
 */
export function fleetUnattendedRejection(
  context: ToolExecutionContext,
): FleetRejection | undefined {
  if (context.automationTurn !== true && context.offPeakTurn !== true) return undefined;
  return fleetRejection(
    "unattended_turn",
    "Fleet session mutations are refused in unattended dispatch turns (automation/off-peak): " +
      "fleet sessions are a user-visible surface and nobody is watching this turn. " +
      "Use the Agent tool for unattended background work.",
  );
}

/** 接线故障：端口缺席不是业务结局（照 escalate/enter-worktree 的裁决）。 */
export function requireFleetPort<T>(
  port: T | undefined,
  context: ToolExecutionContext,
  toolName: string,
  portName: string,
): T {
  if (port !== undefined) return port;
  throw createCoreError(
    CoreErrorType.ConfigurationError,
    `${portName} is not configured for ${toolName}`,
    {
      context: { toolCallId: context.toolCallId, toolName },
      recoverable: false,
    },
  );
}

export function resolveFleetTraceContext(context: ToolExecutionContext): TraceContext {
  return (
    context.traceContext ?? {
      traceId: context.traceId,
      spanId: context.spanId,
      parentSpanId: context.parentSpanId,
      sessionId: context.sessionId,
      turnId: context.turnId,
    }
  );
}

// ── entry 公共段（七工具同构，逐工具只填差异位） ────────────────────

export function fleetResultBudget() {
  return {
    maxInlineBytes: FLEET_MAX_OUTPUT_BYTES,
    maxModelBytes: FLEET_MAX_OUTPUT_BYTES,
    strategy: "truncate" as const,
    preview: { maxBytes: FLEET_MAX_OUTPUT_BYTES, direction: "head" as const },
  };
}

export function fleetTimeout(defaultMs: number) {
  return {
    defaultMs,
    maxMs: defaultMs,
    allowCallOverride: false,
  };
}

export function fleetCancellation(userVisibleMessage: string) {
  return {
    supported: true as const,
    cleanup: "none" as const,
    userVisibleMessage,
  };
}

export function fleetTrace() {
  return {
    required: true as const,
    propagateToAdapters: true,
    recordInput: "summary" as const,
    recordOutput: "summary" as const,
  };
}

/**
 * 模型只读一段文本：成功摘要或拒绝理由（判别位不进模型面，
 * enter-session-worktree 同款裁决）。
 */
export function formatFleetModelContent(output: unknown): string {
  const record = output as { message?: unknown };
  return typeof record?.message === "string" ? record.message : String(output);
}
