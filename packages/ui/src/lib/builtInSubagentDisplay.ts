/**
 * 内置子代理类型 → i18n 显示名的唯一映射（apps/acode-cli/specs/usage-statusbar-port.md §2.5）。
 *
 * 显示层只做「精确名称 → 本地化文案」，未知/自定义/插件名必须原样返回：
 * 颜色解析、权限与持久化键仍使用原始 agentType，不能因为展示本地化而改名。
 */
const BUILT_IN_SUBAGENT_DISPLAY_NAME_IDS = {
  "general-purpose": "subagent.builtInName.generalPurpose",
  Explore: "subagent.builtInName.explore",
} as const;

type BuiltInSubagentDisplayName = keyof typeof BUILT_IN_SUBAGENT_DISPLAY_NAME_IDS;

type SubagentDisplayNameFormatMessage = (descriptor: { id: string }) => string;

export function isBuiltInSubagentName(name: string): name is BuiltInSubagentDisplayName {
  return Object.hasOwn(BUILT_IN_SUBAGENT_DISPLAY_NAME_IDS, name);
}

/**
 * 内置名返回本地化文案；locale 缺键时回退原始名称（不把 i18n key 打到 UI）。
 * 未知/自定义名一律原样返回。
 */
export function localizeSubagentDisplayName(
  name: string,
  formatMessage: SubagentDisplayNameFormatMessage,
): string {
  if (!isBuiltInSubagentName(name)) {
    return name;
  }
  const messageId = BUILT_IN_SUBAGENT_DISPLAY_NAME_IDS[name];
  const message = formatMessage({ id: messageId });
  return message === messageId ? name : message;
}
