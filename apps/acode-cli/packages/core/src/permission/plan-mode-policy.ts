import {
  ENTER_PLAN_MODE_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
} from "@acode/contracts";
import type { PermissionAdjudicationMode } from "./dont-ask-mode.js";

interface PlanModeTransitionContext {
  toolName: string;
  /** 裁决模式（批 2 R1 放宽：CollaborationMode + dontAsk；本判定只比较 "plan"）。 */
  mode: PermissionAdjudicationMode;
  planEnabled?: boolean;
  prePlanMode?: Exclude<PermissionAdjudicationMode, "plan">;
}

interface PlanModeTransitionPermission {
  behavior: "allow" | "deny";
  reason: string;
  ruleId: string;
}

export function resolvePlanModeTransitionPermission(
  context: PlanModeTransitionContext,
): PlanModeTransitionPermission | undefined {
  if (context.toolName === ENTER_PLAN_MODE_TOOL_NAME) {
    return {
      behavior: "allow",
      reason: "EnterPlanMode switches to plan mode without a permission prompt",
      ruleId: "tool.plan.enter",
    };
  }

  if (
    context.toolName === EXIT_PLAN_MODE_TOOL_NAME &&
    !(context.planEnabled ?? context.mode === "plan")
  ) {
    return {
      behavior: "deny",
      reason: "ExitPlanMode can only be used while plan mode is active",
      ruleId: "mode.plan.exitOnly",
    };
  }

  return undefined;
}
