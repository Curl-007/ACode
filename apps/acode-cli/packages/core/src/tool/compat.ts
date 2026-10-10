export const AGENT_TOOL_NAME = "Agent";
export const TASK_TOOL_NAME = "Task";

/**
 * 派发工具面的单一事实源（specs/subagent-policy-floor-inheritance.md 增补 R4）：
 * 注册门（handlers/index.ts 与 embedded-search-branch.ts 两入口）与子代理强制剔除集
 * （subagent/tool-policy.ts）共用同一份名单，两侧永不各写一份字面量。
 */
export const SUBAGENT_DISPATCH_TOOL_NAMES: readonly string[] = [AGENT_TOOL_NAME, TASK_TOOL_NAME];

const subagentDispatchToolNames = new Set<string>(SUBAGENT_DISPATCH_TOOL_NAMES);

const hookMatcherAliasesByToolName = new Map<string, readonly string[]>([
  [AGENT_TOOL_NAME, [TASK_TOOL_NAME]],
  [TASK_TOOL_NAME, [AGENT_TOOL_NAME]],
  ["ApplyPatch", ["Write", "Edit"]],
]);

export function isSubagentDispatchToolName(toolName: string | undefined): boolean {
  return toolName ? subagentDispatchToolNames.has(toolName) : false;
}

export function hookMatcherToolNamesForTool(toolName: string): readonly string[] {
  const aliases = hookMatcherAliasesByToolName.get(toolName) ?? [];
  if (aliases.length === 0) return [toolName];

  const values = new Set<string>([toolName]);
  for (const alias of aliases) values.add(alias);
  return [...values];
}
