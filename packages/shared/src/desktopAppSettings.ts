/**
 * 桌面端 AppSettings 持久化形状（窗口/启动体验类）。
 *
 * 独立叶子模块：protocol.ts 有 400 行闸，AppSettings 的桌面持久化内联形状
 * 收敛到这里具名导出；validationAppSettings.ts 的 zod schema 与本契约同构
 * （键形状钉死见编排契约「AppSettings 新键名」节）。
 */

/** 桌面主窗口最近一次非最大化宽高及最大化状态。 */
export interface DesktopWindowSizeSettings {
  width: number;
  height: number;
  maximized: boolean;
}
