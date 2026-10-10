import { ENTER_PLAN_MODE_TOOL_NAME, EXIT_PLAN_MODE_TOOL_NAME } from "@acode/contracts";
import { SUBAGENT_DISPATCH_TOOL_NAMES } from "../tool/compat.js";
import { filterDisallowedToolNames } from "../tool/tool-visibility.js";

const SUBAGENT_CHILD_FORCED_DISALLOWED_TOOLS: readonly string[] = [
  ENTER_PLAN_MODE_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
];

export function buildSubagentChildDisallowRules(
  disallowedTools: readonly string[] | undefined,
  options?: { allowDispatch?: boolean },
): readonly string[] {
  return [
    ...SUBAGENT_CHILD_FORCED_DISALLOWED_TOOLS,
    // 编排方案 §5 R2 修复（specs/subagent-policy-floor-inheritance.md 增补 R4）+ Phase 4
    // 按 depth 判定（specs/subagent-nesting-budget.md R3）：派发工具默认一律剔除——
    // 剔除在强制集单一出处，inherits 与显式 allowedTools 两分支（以及 profile.tools /
    // runner resolveAllowedTools 两个下游）自动同规则；此前剔除只在 inherits 分支，
    // allowedTools:["Agent"] 的 profile 在放开嵌套后会直接获得派发面、绕过 depth 判定。
    // 被允许再派发的 child（childDepth < 生效 maxDepth——树级预算闸落地前恒不存在，
    // resolveEffectiveSubagentMaxDepth fail-closed 硬封 1）经 allowDispatch 保留派发
    // 工具，与注册门（includeAgent=Boolean(subagentPort)）同由一个 enabled 判定派生。
    ...(options?.allowDispatch === true ? [] : SUBAGENT_DISPATCH_TOOL_NAMES),
    ...(disallowedTools ?? []),
  ];
}

export function filterSubagentChildToolNames(
  toolNames: readonly string[],
  disallowedTools: readonly string[] | undefined,
  options?: { allowDispatch?: boolean },
): readonly string[] {
  // 子 agent 没有独立的 plan approval 恢复面，暴露 plan tools 会让
  // ExitPlanMode 等待用户确认并卡住父 turn，因此所有子 agent 工具面统一剔除。
  return filterDisallowedToolNames(
    toolNames,
    buildSubagentChildDisallowRules(disallowedTools, options),
  );
}
