/**
 * WorkspaceShellLayout 批次 5 外迁：workspace 侧栏宽度的纯决策与持久化（逐字迁移）。
 *
 * 单一职责：宽度钳制（min/容器比例上限）+ localStorage 像素宽读写 + 旧版 RRP 百分比迁移读取。
 * window/localStorage 访问全部带 typeof window 守卫与 try/catch，SSR/测试环境安全。
 */

export const WORKSPACE_SIDEBAR_DEFAULT_WIDTH_PX = 264;
export const WORKSPACE_SIDEBAR_MIN_WIDTH_PX = 264;
export const WORKSPACE_SIDEBAR_MAX_WIDTH_RATIO = 0.5;
export const WORKSPACE_SIDEBAR_WIDTH_STORAGE_KEY = "acode:workspace-shell:sidebar-width-px";
export const LEGACY_WORKSPACE_SHELL_LAYOUT_STORAGE_KEY =
  "react-resizable-panels:workspace-shell-layout:sidebar:content";
export const WORKSPACE_SIDEBAR_RESIZE_KEYBOARD_STEP_PX = 16;
export const WORKSPACE_SIDEBAR_PANEL_WIDTH_CSS_VAR = "--workspace-sidebar-panel-width";
export const WORKSPACE_SIDEBAR_WIDTH_CSS_VAR = "--workspace-sidebar-width";

export type WorkspaceSidebarResizeSession = {
  containerWidthPx: number;
  pointerId: number;
  startWidthPx: number;
  startX: number;
};

export function clampWorkspaceSidebarWidth(widthPx: number, containerWidthPx?: number) {
  const maxWidthPx =
    containerWidthPx && containerWidthPx > 0
      ? Math.max(
          WORKSPACE_SIDEBAR_MIN_WIDTH_PX,
          containerWidthPx * WORKSPACE_SIDEBAR_MAX_WIDTH_RATIO,
        )
      : Number.POSITIVE_INFINITY;

  return Math.round(Math.max(WORKSPACE_SIDEBAR_MIN_WIDTH_PX, Math.min(widthPx, maxWidthPx)));
}

export function readStoredWorkspaceSidebarWidthPx(): number | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(WORKSPACE_SIDEBAR_WIDTH_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? clampWorkspaceSidebarWidth(parsed) : null;
  } catch {
    return null;
  }
}

export function readLegacyWorkspaceSidebarWidthRatio(): number | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(LEGACY_WORKSPACE_SHELL_LAYOUT_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as { sidebar?: unknown };
    const ratio = Number(parsed.sidebar);
    return Number.isFinite(ratio) && ratio > 0 ? ratio / 100 : null;
  } catch {
    return null;
  }
}

export function persistWorkspaceSidebarWidthPx(widthPx: number) {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(WORKSPACE_SIDEBAR_WIDTH_STORAGE_KEY, String(Math.round(widthPx)));
  } catch {
    // ignore
  }
}
