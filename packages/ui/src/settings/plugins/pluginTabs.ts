/**
 * PluginsSection 的 Plugin tab 归一化与计数样式 helper（批次 4 helper 外迁 2026-10-28：
 * 自 settings/PluginsSection.tsx 逐字迁移，函数体未改一字，仅补 export）。
 * 原本地的 workspaceKey 包装（函数体仅 `return getPluginWorkspaceKey(tab)`）与
 * PluginScopeMenu 导出的 getPluginWorkspaceKey 语义完全相同（纯委托别名），外迁时去重删除，
 * 调用点统一改用 getPluginWorkspaceKey，故此处不再重复迁移。
 */
export type PluginTabTarget = "plugins" | "mcps" | "skills" | "commands";
export type PluginTab = Exclude<PluginTabTarget, "commands">;

export function normalizePluginTab(tab: PluginTabTarget): PluginTab {
  return tab === "commands" ? "plugins" : tab;
}

export function getPluginTabCountClass(tab: PluginTabTarget, selectedTab: PluginTabTarget): string {
  return tab === selectedTab
    ? "text-ui-sm text-foreground-subtle"
    : "text-ui-sm text-foreground-subtlest";
}
