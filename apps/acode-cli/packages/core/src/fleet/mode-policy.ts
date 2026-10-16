// ============================================================
// Fleet Mode Policy - 只紧不松 + 升降权分类
// (apps/acode-cli/specs/session-fleet.md R2/R4)
// ============================================================
// 严苛度序的单一事实源是 subagent/nesting-policy.ts 的 MODE_SEVERITY
// （auto < plan < edit < build < yolo），本模块只消费其导出的
// moreRestrictiveMode，不另写第二份排序（「不许两处各写一份排序」纪律）。
//
// 结构性不变量（既有机制，舰队不重复实现）：child 的有效模式天花板 =
// 发起者当前有效模式（resolveSubagentPermissionMode，launch 与每次 resume 重锚）。
// 舰队叠加的是**记录面**（recorded mode）与**不对称门**（升权必过用户）。

import type { CollaborationMode, SessionModePort } from "@acode/contracts";
import type { FleetPermissionMode } from "@acode/contracts";
import { SESSION_ENTRY_EXECUTION_STATE } from "@acode/contracts";
import type { SessionEntryInfo, SessionId } from "@acode/contracts";
import { moreRestrictiveMode } from "../subagent/nesting-policy.js";

/** 发起者当前有效模式（plan 生效时按 plan 计，与 subagent.ts 的 parentEffectiveMode 同款推导）。 */
export function resolveLauncherEffectiveMode(
  sessionModePort: SessionModePort | undefined,
): CollaborationMode {
  if (!sessionModePort) return "build";
  const planEnabled = sessionModePort.isPlanEnabled?.() ?? sessionModePort.getMode() === "plan";
  return planEnabled ? "plan" : (sessionModePort.getMode() ?? "build");
}

/**
 * 升权判定：requested 比 current 更宽 = 升权。用 moreRestrictiveMode 表达——
 * 两者不等且「更严者」是 current，即 requested 更宽。等值不算升权（平调直通）。
 */
export function isFleetModeEscalation(
  current: CollaborationMode,
  requested: CollaborationMode,
): boolean {
  if (requested === current) return false;
  return moreRestrictiveMode(current, requested) === current;
}

export type FleetLaunchModeDecision =
  /** 缺席或与发起者同档：child 继承天花板（结构性 clamp），recorded = 发起者模式。 */
  | { kind: "inherit"; mode: CollaborationMode }
  /** plan 档：vessel 换 bundled Plan preset（frontmatter permissionMode: plan 地板）。 */
  | { kind: "plan_vessel"; mode: "plan" }
  | {
      kind: "rejected";
      reason: "mode_above_launcher" | "mode_tightening_unsupported";
      message: string;
    };

/**
 * StartSession / HandOffToSession（新建）的模式裁决（R2）：
 * - 高于发起者 → mode_above_launcher（只紧不松）；
 * - plan → Plan vessel（结构性只读地板）；
 * - 低于发起者的非 plan 收紧 → mode_tightening_unsupported：launch 面没有
 *   per-request 模式缝（profile 决定 + 天花板 clamp），绝不假装生效
 *   （spec 非目标 #2/#3）。
 */
export function resolveFleetLaunchMode(input: {
  requested: FleetPermissionMode | undefined;
  launcherMode: CollaborationMode;
}): FleetLaunchModeDecision {
  const { requested, launcherMode } = input;
  if (requested === undefined || requested === launcherMode) {
    return { kind: "inherit", mode: launcherMode };
  }
  if (isFleetModeEscalation(launcherMode, requested)) {
    return {
      kind: "rejected",
      reason: "mode_above_launcher",
      message:
        `permission_mode "${requested}" is above your current mode "${launcherMode}". ` +
        `A session you start can never be less restrictive than you are (tighten-only). ` +
        `Omit permission_mode to inherit "${launcherMode}", or request "plan" for a read-only session.`,
    };
  }
  if (requested === "plan") {
    return { kind: "plan_vessel", mode: "plan" };
  }
  return {
    kind: "rejected",
    reason: "mode_tightening_unsupported",
    message:
      `Launching a session at "${requested}" while you are at "${launcherMode}" is not supported yet: ` +
      "background launches inherit your current mode as a structural ceiling, and only the plan floor has a dedicated vessel. " +
      `Omit permission_mode to inherit "${launcherMode}", or request "plan" for a read-only session.`,
  };
}

/** SetSessionPermissionMode 的生效边界（R4 诚实语义，进工具结果 binding 字段）。 */
export function resolveFleetModeBinding(
  modeLineage: "plan" | "ceiling",
): "next_turn_boundary" | "cold_restore" {
  return modeLineage === "plan" ? "next_turn_boundary" : "cold_restore";
}

/**
 * recorded mode → child 会话的 execution-state 持久化条目（R4 降权/已批准升权
 * 都落）。形状按契约自建（entry id / type / touchSession 语义与 runtime 的
 * buildExecutionStateEntry 一致，但不 import runtime/——依赖方向纪律，spec
 * 「依赖方向」节）：resume 面读回该条目（plan 系不带 modeOverride → 下个回合
 * 边界绑定；天花板系热 resume 重锚发起者当前模式，条目绑定冷恢复面）。
 * plan 记录为 `{mode: build, planEnabled: true}`——planEnabled 是权限判定的
 * 主导位，基底 build 与 Plan vessel 构造期的取值一致（parent 基础模式缺省）。
 */
export function buildFleetModeEntry(
  sessionId: SessionId,
  mode: FleetPermissionMode,
  now?: () => number,
): SessionEntryInfo {
  const timestamp = (now ?? Date.now)();
  const planEnabled = mode === "plan";
  return {
    id: `${sessionId}:runtime-execution-state`,
    sessionID: sessionId,
    type: SESSION_ENTRY_EXECUTION_STATE,
    touchSession: false,
    time: { created: timestamp, updated: timestamp },
    data: { mode: planEnabled ? "build" : mode, planEnabled },
  };
}
