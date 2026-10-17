// 页内查找菜单项姊妹模块（specs/find-in-page.md）：desktopApplicationMenu.ts 有
// 400 行闸，条目构造（文案 locale 分支 + F3 让路语义 + 目标窗口解析）收敛到这里。
import { BrowserWindow } from "electron";
import type { Locale } from "@acode/shared";
import { desktopMenuMessageIds, getDesktopMenuMessage } from "@acode/shared";
import { requestFindInPageOpen } from "./findInPageMain.js";

/**
 * 「页内查找」菜单项：click → main 经 OpenFindInPage 推送 renderer
 * （查找栏未开 = 打开并聚焦；已开 = 下一处，与 renderer F3 键路同义——
 * 菜单 accelerator 会先于 renderer keydown 吃掉 F3，两条路径必须同语义）。
 *
 * F3 固定绑定与 disableShortcutAccelerators 的共存判定：F3 不是可配置命令
 * （renderer 侧保留黑名单挡住抢绑），但与可配置 accelerator 共用同一让路开关
 * （specs/embedded-content-focus-yield.md 案 A 的两个触发源）——
 * ① 录制态摘除：防止菜单在窗口级先于 renderer 吃掉 F3 干扰录制；
 * ② 嵌入第三方内容面可编辑焦点时摘除：让页面自行消费 F3。
 * 摘除后菜单项仍可点击；焦点在宿主 document 时 renderer 固定绑定接管 F3。
 */
export function buildFindInPageMenuItem(options: {
  currentApplicationLocale: Locale;
  disableShortcutAccelerators?: boolean;
}): Electron.MenuItemConstructorOptions {
  return {
    label: getDesktopMenuMessage(
      options.currentApplicationLocale,
      desktopMenuMessageIds.editFindInPage,
    ),
    accelerator: options.disableShortcutAccelerators ? undefined : "F3",
    click: (_menuItem, browserWindow) => {
      // 菜单点击上下文窗口优先（Electron 回调形参是 BrowserWindow | BaseWindow，
      // BaseWindow 无 webContents，instanceof 收窄）；无窗口上下文（如 tray 触发的
      // 重建）回退 focused/首个存活窗口。辅助窗口（更新窗/CUA indicator）没有挂载
      // 查找栏宿主组件，推送到达后无监听者即静默丢弃，行为安全。
      const targetWindow =
        browserWindow instanceof BrowserWindow && !browserWindow.isDestroyed()
          ? browserWindow
          : (BrowserWindow.getFocusedWindow() ??
            BrowserWindow.getAllWindows().find((win) => !win.isDestroyed()) ??
            null);
      if (targetWindow) {
        requestFindInPageOpen(targetWindow.webContents);
      }
    },
  };
}
