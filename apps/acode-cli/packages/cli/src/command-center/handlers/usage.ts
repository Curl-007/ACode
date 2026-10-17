import type { TuiSubmitPromptResult } from "@acode/tui";
import type { CommandCenterDeps } from "../types.js";

/**
 * /usage 命令面（apps/acode-cli/specs/usage-statusbar.md）：零 token 本地执行——
 * 直接返回 { response }，不进 submitPrompt。解析/取数/渲染的单一实现在 core 的
 * usage-query 模块，经 app.queryUsage 能力面调用（bootstrap session-facade 实现）。
 */
export async function handleUsageCommand(
  args: string,
  deps: CommandCenterDeps,
): Promise<TuiSubmitPromptResult> {
  const app = await deps.getApp();
  if (typeof app.queryUsage !== "function") {
    return {
      mode: deps.getMode?.(),
      response: "Usage queries are not available in this client.",
    };
  }
  const result = await app.queryUsage({ args });
  return {
    locale: app.getLocale?.(),
    mode: deps.getMode?.(),
    response: result.text,
  };
}
