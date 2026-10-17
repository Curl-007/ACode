/**
 * 桌面端 AppSettings 持久化形状（窗口/启动体验类）。
 *
 * 独立叶子模块：protocol.ts 有 400 行闸，AppSettings 的桌面持久化内联形状
 * 收敛到这里具名导出；validationAppSettings.ts 的 zod schema 与本契约同构
 * （键形状钉死见 packages/desktop/specs/boot-placeholder.md §9.1 与
 * 编排契约「AppSettings 新键名」节）。
 */

/** 桌面主窗口最近一次非最大化宽高及最大化状态。 */
export interface DesktopWindowSizeSettings {
  width: number;
  height: number;
  maximized: boolean;
}

/** 启动骨架占位的单个矩形：视口归一化比值（radius 相对短边；每值 0..1e4）。 */
export interface DesktopBootPlaceholderShape {
  top: number;
  left: number;
  width: number;
  height: number;
  radius: number;
}

/**
 * 启动骨架占位的最近一次采样（specs/boot-placeholder.md）：shapes ≤160 个；
 * sidebarWidth 为侧栏宽/视口宽比值（collapsed 时为 0）；zoomFactor 溯源采样时
 * 页面 zoom；sampledAt 为采样墙钟毫秒。
 */
export interface DesktopBootPlaceholderSettings {
  shapes: DesktopBootPlaceholderShape[];
  sidebarWidth: number;
  collapsed: boolean;
  zoomFactor: number;
  sampledAt: number;
}
