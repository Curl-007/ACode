// 继续指令模板（specs/turn-auto-resume.md「注入路径」）：自撰英文，跟随
// output-token continuation 惯例。语义要素：上一轮因临时性故障中断而非用户停止；
// 从中断处继续；不重复已完成工作；上一步操作结果未知时先确认状态再继续。
// 占位符 {count}/{max}/{remaining}；customMessage 覆盖仅作用 transient 档
// （注入只发生在 transient 档，覆盖天然同域）。

export const AUTO_RESUME_CONTINUE_PROMPT = [
  "The previous turn was interrupted by a transient infrastructure failure (for example a rate limit, network error, or timeout) — not by the user, and not because the task is complete.",
  "Continue the task from exactly where the interruption happened.",
  "Do not repeat work that already completed successfully.",
  "If the outcome of the last action before the interruption is unknown, first verify the current state (files on disk, git status, or the previous command's output) before continuing.",
  "Auto-resume attempt {count} of {max}; {remaining} attempt(s) remain after this one.",
].join("\n");

export interface AutoResumeContinueTextInput {
  /** 第几次自动继续（1-based）。 */
  count: number;
  max: number;
  /** 自定义模板（config.continueMessage 或命令面 override）；缺席用默认模板。 */
  customMessage?: string;
}

export function buildAutoResumeContinueText(input: AutoResumeContinueTextInput): string {
  const template = input.customMessage?.trim()
    ? input.customMessage.trim()
    : AUTO_RESUME_CONTINUE_PROMPT;
  const remaining = Math.max(input.max - input.count, 0);
  return template
    .replaceAll("{count}", String(input.count))
    .replaceAll("{max}", String(input.max))
    .replaceAll("{remaining}", String(remaining));
}
