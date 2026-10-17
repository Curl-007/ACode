import type { SwitchableCommandCenterMode } from "./types.js";

// dontAsk（specs/permission-adjudication-batch2.md 接线项 2）：无人可问即拒的档位，
// /mode 菜单与文本命令同款可达；语义 = 未被规则放行的一律不弹卡直接拒。
const SWITCHABLE_COMMAND_CENTER_MODES = [
  "plan",
  "build",
  "edit",
  "yolo",
  "dontAsk",
] as const satisfies readonly SwitchableCommandCenterMode[];

export function formatAvailableCommandCenterModes(): string {
  return SWITCHABLE_COMMAND_CENTER_MODES.join(", ");
}

/**
 * 输入大小写不敏感，输出规范词汇（dontAsk 是 camelCase，其余全小写同形）——
 * setMode 消费的是规范值，不能把 "dontask" 直接透传进 CollaborationMode。
 */
export function normalizeSwitchableCommandCenterMode(
  value: string,
): SwitchableCommandCenterMode | undefined {
  const normalized = value.trim().toLowerCase();
  return SWITCHABLE_COMMAND_CENTER_MODES.find((mode) => mode.toLowerCase() === normalized);
}
