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
  // 脚本工作流的入口，上游同名（那边叫 Workflow，alias 就是 RunWorkflow），故按纪律收录。
  // dwf 的 CreateWorkflow 家族是 ACode 自起源的名字，不在本集合里，走 localTools——
  // 于是 RunWorkflow 与它的 dwf 兄弟分属两段。这个分裂是既有的（dwf 十个从来没进过本集合），
  // 本行不制造它，也不去弥合它：本集合的判据是「名字是否来自上游参考实现」，不是「是否属于
  // 工作流家族」。
  "RunWorkflow",
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
