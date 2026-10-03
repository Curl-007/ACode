// 成员纪律（能力提升方案 S3）：只收录**真实注册**的工具名。上游遗留的占位死名
// （EnterWorktree/ExitWorktree/LSP/NotebookEdit/ScheduleWakeup/TaskCreate/TaskGet/
// TaskList/TaskUpdate）已移除——它们不注入任何工具、只误导维护者，且曾是模型可见文本
// 悬空引用的源头（prompt-corpus-audit F7）。新增工具落地时再按字母序补名。
const SORTED_PROVIDER_TOOL_NAMES = new Set([
  "Agent",
  "ApplyPatch",
  "AskUserQuestion",
  "Bash",
  "CronCreate",
  "CronDelete",
  "CronList",
  "CronUpdate",
  "Edit",
  "EnterPlanMode",
  "ExitPlanMode",
  "Glob",
  "Grep",
  "Read",
  "Skill",
  "TaskOutput",
  "TaskStop",
  "TodoRead",
  "TodoWrite",
  "WebFetch",
  "WebSearch",
  "Workflow",
  "Write",
]);

export function orderProviderVisibleToolContracts<T extends { name: string }>(
  tools: readonly T[],
): T[] {
  const referenceTools: T[] = [];
  const localTools: T[] = [];
  for (const tool of tools) {
    if (SORTED_PROVIDER_TOOL_NAMES.has(tool.name)) {
      referenceTools.push(tool);
    } else {
      localTools.push(tool);
    }
  }

  return [
    ...referenceTools.sort((left, right) => left.name.localeCompare(right.name)),
    ...localTools,
  ];
}
