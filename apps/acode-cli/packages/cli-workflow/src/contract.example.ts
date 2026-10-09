import {
  DYNAMIC_WORKFLOW_SKILL_NAME,
  collectDisabledPaths,
  type PrepareUserExecutionBoundary,
} from "./contract.js";

/**
 * 仅展示公开面的组合方式；不拥有 run/journal/owner 状态，也不复制装配顺序。
 * 宿主（bootstrap）经包名入口消费引擎，深度实现细节留在 contract 之后。
 */
export function composeHostExample(input: {
  skillOverrides: Record<string, { enable?: boolean }> | undefined;
  prepareUserExecutionBoundary: PrepareUserExecutionBoundary;
}): { skillName: string; disabledPaths: string[] } {
  // 禁用路径收集与技能常量都来自公开契约；执行边界由宿主注入，本包不持有会话事实。
  void input.prepareUserExecutionBoundary;
  return {
    skillName: DYNAMIC_WORKFLOW_SKILL_NAME,
    disabledPaths: collectDisabledPaths(input.skillOverrides),
  };
}
