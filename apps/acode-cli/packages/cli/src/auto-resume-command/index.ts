// /auto-resume TUI 命令入口（specs/turn-auto-resume.md「命令面」）。
// 解析 + 回执文本（随 locale zh/en）的单一实现住 core 的 runtime/auto-resume/command.ts
// （bootstrap v4 handler leaf 复用同一实现——依赖方向约束下本体不能住 cli）；
// 本模块只做 CommandCenterDeps → host 适配与 TuiSubmitPromptResult 包装。
// 注册三件套（help entry / parseSlashCommand 分支 / create.ts 拦截）= 编排者接线。
import {
  createAutoResumeCommandHost,
  handleAutoResumeCommand as runAutoResumeCommand,
} from "@acode/core";
import type { TuiSubmitPromptResult } from "@acode/tui";
import type { CommandCenterDeps } from "../command-center/types.js";

export async function handleAutoResumeCommand(
  args: string,
  deps: CommandCenterDeps,
): Promise<TuiSubmitPromptResult> {
  const app = await deps.getApp();
  const result = await runAutoResumeCommand(args, createAutoResumeCommandHost(app));
  return {
    locale: app.getLocale?.(),
    mode: deps.getMode?.(),
    response: result.response,
  };
}
