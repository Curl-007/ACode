import { BrowserWindow, dialog, ipcMain } from "electron";
import type { MessageBoxOptions } from "electron";
import { PlatformChannels } from "@acode/shared";
import { clearEmbeddedBrowserData, importChromeBrowserData } from "./browserDataManager.js";
import { discoverChromeProfile } from "./chromeProfileDiscovery.js";
import { hasAppBoundEncryptedCookies } from "./chromeCookieManager.js";

type BrowserDataIpcLogger = {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
};

/**
 * 提权授权判定（安全加固 P2 #9，specs/electron-hardening.md §6）。
 *
 * 纯函数：只有「Windows 平台 + 嗅探确认 Cookie 库确有 v20（App-Bound）行 + 用户在 main 进程
 * 弹出的确认框显式确认」三者同时成立，才允许本次导入走提权解密路径。嗅探结果未知（null）
 * 必须 fail-closed：不弹窗、不提权，导入按无提权继续并返回既有的
 * chrome_cookie_elevation_required 错误码。
 */
export function resolveElevatedChromeDecryptionAuthorization(input: {
  platform: NodeJS.Platform;
  appBoundCookieRowsPresent: boolean | null;
  userConfirmed: boolean;
}): boolean {
  return (
    input.platform === "win32" &&
    input.appBoundCookieRowsPresent === true &&
    input.userConfirmed === true
  );
}

async function confirmElevatedChromeDecryptionWithUser(
  parentWindow: BrowserWindow | null,
): Promise<boolean> {
  // 对齐仓库既有 main 进程确认框模式（desktopCommandHandlers.showMessageBoxWithOptionalParent）。
  // 默认焦点落在「取消」上：安全确认框的安全默认是不提权。
  const options: MessageBoxOptions = {
    type: "question",
    title: "导入 Chrome Cookie",
    message: "是否解密受 Chrome App-Bound 保护的 Cookie？",
    detail:
      "检测到 Chrome Cookie 使用 App-Bound 加密。导入需要启动 Chrome 官方提权组件读取解密密钥，" +
      "仅用于把 Cookie 导入 ACode 内置浏览器。取消将跳过受保护的 Cookie。",
    buttons: ["确认解密", "取消"],
    defaultId: 1,
    cancelId: 1,
  };
  const { response } = parentWindow
    ? await dialog.showMessageBox(parentWindow, options)
    : await dialog.showMessageBox(options);
  return response === 0;
}

export function registerBrowserDataIpcHandlers(logger: BrowserDataIpcLogger) {
  ipcMain.handle(PlatformChannels.ImportChromeBrowserData, async (event, value: unknown) => {
    // 安全加固 P2 #9（及后续清理）：renderer 载荷一律不信任。提权解密授权完全由 main 判定：
    // 平台 + v20 前置嗅探 + 用户显式确认，且授权只在本次调用内有效（不持久化、不缓存）。
    // IPC 契约已不再携带任何 options（allowElevatedChromeDecryption 死字段已从 shared 类型移除）；
    // 这里仍防御性忽略任何残余载荷（void value），旧 renderer 进程或伪造请求都无法影响授权。
    void value;
    let allowElevatedChromeDecryption = false;
    if (process.platform === "win32") {
      const discovered = await discoverChromeProfile({ platform: process.platform });
      const profilePath = discovered.success ? discovered.source.profilePath : undefined;
      if (profilePath) {
        const appBoundCookieRowsPresent = await hasAppBoundEncryptedCookies({
          profilePath,
          logger,
        });
        if (appBoundCookieRowsPresent === true) {
          const userConfirmed = await confirmElevatedChromeDecryptionWithUser(
            BrowserWindow.fromWebContents(event.sender),
          );
          allowElevatedChromeDecryption = resolveElevatedChromeDecryptionAuthorization({
            platform: process.platform,
            appBoundCookieRowsPresent,
            userConfirmed,
          });
          logger.info("[browser-data] App-Bound 提权解密授权结果", {
            userConfirmed,
            authorized: allowElevatedChromeDecryption,
          });
        }
      }
    }
    return importChromeBrowserData({ allowElevatedChromeDecryption, logger });
  });
  ipcMain.handle(PlatformChannels.ClearEmbeddedBrowserData, (_event, mode: unknown) => {
    if (mode !== "cache" && mode !== "all") {
      return { success: false, error: "invalid_clear_mode" };
    }
    return clearEmbeddedBrowserData({ logger, mode });
  });
}
