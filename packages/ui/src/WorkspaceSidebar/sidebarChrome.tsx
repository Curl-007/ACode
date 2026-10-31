/**
 * WorkspaceSidebar 批次 5 外迁：侧栏小型展示组件（逐字迁移自 WorkspaceSidebar.tsx）。
 * - WorkspaceNewTaskTooltip：仅禁用态才挂原因 tooltip（正常态按钮自带走文案/快捷键）。
 * - WorkspaceDragOverlay：workspace 列表拖拽预览浮层。
 */
import type { ReactNode } from "react";
import { Cloud, Folder } from "lucide-react";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";

export function WorkspaceNewTaskTooltip({
  children,
  disabledReason,
}: {
  children: ReactNode;
  disabledReason?: string;
}) {
  // 正常状态下按钮已带“新建任务”文案和快捷键，再挂 tooltip 只是重复；仅禁用时才解释原因。
  if (!disabledReason) return children;
  return (
    <ControlHintTooltip title={disabledReason}>
      <div>{children}</div>
    </ControlHintTooltip>
  );
}

export function WorkspaceDragOverlay({
  tab,
  width,
}: {
  tab: WorkspaceTabState;
  width: number | null;
}) {
  const isRemote = Boolean(tab.remoteSessionId || tab.remoteTarget || tab.workspaceIdentity);
  return (
    <div
      data-testid="workspace-drag-overlay"
      className="pointer-events-none flex cursor-grabbing items-center rounded-lg border border-border bg-background text-ui-base text-foreground shadow-lg h-8 px-2.5 gap-2 [&_svg]:pointer-events-none [&_svg]:size-3.5 [&_svg]:shrink-0"
      style={width ? { width } : undefined}
    >
      {/* 项目列表图标位于 Button 内，运行态会被按钮 SVG 规则收敛为 14px；
          overlay 脱离 Button 后不再继承该规则，因此显式使用相同尺寸，避免 preview 图标放大。 */}
      {isRemote ? (
        <Cloud className="size-3.5 shrink-0 text-foreground-subtle" />
      ) : (
        <Folder className="size-3.5 shrink-0 text-foreground-subtle" />
      )}
      <span className="min-w-0 flex-1 truncate px-1">{tab.label}</span>
    </div>
  );
}
