// 机制参照 jcode (MIT)：jcode-app-core ambient cycle 的 fork prompt 组装（后台周期
// 检查指令 + 到期项 + workspace 摘要），自撰 TypeScript 实现
// （apps/acode-cli/specs/ambient-budget-scheduler.md R3 cycle 语义）。
//
// 独立文件（proposal.ts 同款小文件先例）：runner.ts 保持单文件职责清晰
// （oxlint max-lines），prompt 组装是纯函数、无状态。
import type { ScheduledItem } from "./queue.js";

/**
 * 组装 ambient cycle 的 fork prompt（R3：「后台周期检查」指令 + 到期项 + workspace 摘要）。
 * 导出供测试对照文案结构；内容是模型面（英文指令 + 项内容原样），与既有 prompt 策略一致。
 */
export function buildAmbientCyclePrompt(
  items: ScheduledItem[],
  workspaceSummary?: string,
): string {
  const lines: string[] = [
    "You are the ACode ambient background agent performing a scheduled periodic check.",
    "This wake-up was proposed earlier and approved by the local budget-aware scheduler; the user is not waiting on you.",
    "Due items for this cycle:",
  ];
  for (const item of items) {
    lines.push(`- [${item.priority}] ${item.taskDescription}`);
    if (item.context) lines.push(`  context: ${item.context}`);
    if (item.relevantFiles && item.relevantFiles.length > 0) {
      lines.push(`  relevant files: ${item.relevantFiles.join(", ")}`);
    }
  }
  if (workspaceSummary) {
    lines.push("", "Workspace state summary:", workspaceSummary);
  }
  lines.push(
    "",
    "Rules:",
    "- Permission is tightened for this unattended run: operations that would normally require user confirmation are denied outright. Do not retry them; record that they were skipped and continue.",
    "- Do the check quietly and keep output short.",
    "- If another wake-up is genuinely needed, end your reply with a fenced block:",
    "  ```acode-schedule",
    '  {"wakeInMinutes": 30, "taskDescription": "...", "priority": "low|normal|high"}',
    "  ```",
    "- wakeInMinutes must be 1-1440. If no further wake-up is needed, end normally without the block (the scheduler will go idle).",
  );
  return lines.join("\n");
}
