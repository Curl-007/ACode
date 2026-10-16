import type { TuiSubmitPromptResult } from "@acode/tui";
import {
  formatAvailableCommandCenterModes,
  normalizeSwitchableCommandCenterMode,
} from "../modes.js";
import type { CommandCenterDeps } from "../types.js";

export async function handleModeCommand(
  args: string,
  deps: CommandCenterDeps,
): Promise<TuiSubmitPromptResult> {
  const current = deps.getMode?.() ?? "build";
  if (args.length === 0) {
    return {
      mode: current,
      response: `Current mode: ${current}. Available modes: ${formatAvailableCommandCenterModes()}.`,
    };
  }

  // 大小写不敏感归一回规范词汇（dontAsk 是 camelCase）；setMode 只吃规范值。
  const requested = normalizeSwitchableCommandCenterMode(args);
  if (!requested) {
    return {
      mode: current,
      response: `Unsupported mode: ${args}. Available modes: ${formatAvailableCommandCenterModes()}.`,
    };
  }

  if (!deps.setMode) {
    return {
      mode: current,
      response: "Mode switching is not available in this client.",
    };
  }

  const next = await deps.setMode(requested);
  return {
    mode: next,
    response: `Mode switched to ${next}.`,
  };
}
