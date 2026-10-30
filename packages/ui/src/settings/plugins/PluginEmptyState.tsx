/**
 * 插件设置的空态提示行（受控组件，纯渲染）。
 * 批次 4 helper 外迁（2026-10-28）：自 settings/PluginsSection.tsx 内部 EmptyState
 * 逐字迁移。EmptyState 同时被 PluginList 与 PluginsSection 主组件（mcp/skills/commands
 * 分支）使用，单独成叶以避免 plugins/PluginList 与主文件之间产生循环依赖。
 */
export function PluginEmptyState({ message }: { message: string }) {
  return (
    <div className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-ui-base text-foreground-subtle">
      {message}
    </div>
  );
}
