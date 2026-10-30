/**
 * PreviewPane 批次 5 外迁：大文件预览延迟加载占位组件（逐字迁移自 PreviewPane.tsx）。
 *
 * resize/sliver 阶段不挂载重型 CodeViewer，用静态 code-line 纹理保留视觉重量。
 */
import type { CSSProperties } from "react";

export const PREVIEW_PANE_DEFERRED_PLACEHOLDER_LINE_WIDTHS = [
  44, 72, 58, 86, 64, 78, 52, 90, 68, 48, 82, 60,
] as const;

export function PreviewPaneDeferredHeavyContent({ style }: { style?: CSSProperties }) {
  return (
    <div
      aria-hidden="true"
      className="h-full w-full overflow-hidden bg-background"
      data-preview-pane-heavy-content-deferred="true"
      style={style}
    >
      {/* resize/sliver 阶段不能展示大文件 CodeViewer，但只放空白会明显闪烁。
          这里用少量静态 code-line 纹理保留预览区的视觉重量，不让千行 Shadow DOM 参与可见布局。 */}
      <div
        className="sticky top-0 flex h-full min-h-0 flex-col gap-1.5 overflow-hidden p-3"
        data-preview-pane-heavy-content-placeholder="true"
      >
        {PREVIEW_PANE_DEFERRED_PLACEHOLDER_LINE_WIDTHS.map((width, index) => (
          <div key={`${width}-${index}`} className="flex h-4 shrink-0 items-center gap-2">
            <span className="h-3 w-8 shrink-0 rounded-sm bg-surface" />
            <span className="h-3 rounded-sm bg-surface-hover" style={{ width: `${width}%` }} />
          </div>
        ))}
      </div>
    </div>
  );
}
