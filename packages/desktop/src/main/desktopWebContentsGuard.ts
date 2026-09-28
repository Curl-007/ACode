/* eslint-disable max-lines -- 主窗导航守卫与弹窗守卫共享同一组 URL 判定与外部打开语义。 */
import { shell } from "electron";
import type { WebContents, WindowOpenHandlerResponse } from "electron";

/**
 * 主特权窗（P2 #2a）的导航/弹窗守卫。
 *
 * 设计约束（specs/electron-hardening.md §1）：
 * - 裁决全部收敛在纯函数里，Electron 事件接线只消费结果，便于 node:test 直接覆盖；
 * - dev 态主窗跑在 vite origin（http://localhost:*），打包态是 loadFile 的 file: 页面，
 *   两态的「应用自身页面」定义不同，必须按 current URL 的形态分别判定；
 * - 被诱导的外部导航不能在特权窗内换页（会带走整个 window.acode IPC 面），只能转交系统浏览器。
 */

/** 主帧导航可考虑的协议；其余（含 acode: 深链、自定义协议）一律 block。 */
const MAIN_FRAME_NAVIGABLE_PROTOCOLS = new Set(["http:", "https:", "file:"]);

export type MainWindowGuardAction = "allow" | "open-external" | "block";

function parseUrlOrNone(value: string | undefined | null): URL | null {
  if (!value) return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isHttpOrHttpsProtocol(protocol: string): boolean {
  return protocol === "http:" || protocol === "https:";
}

/**
 * 主帧导航裁决：
 * - file:→file:：打包态应用自身页面（index.html 与带 query 的自导航）放行；
 * - http(s) 同 origin：dev vite / login 页 / 带 query 自导航放行；
 * - 其它 http(s)：`open-external`，主帧阻止并转交系统浏览器；
 * - 其余（dev 下的 file: 目标、解析失败、任意自定义协议）：`block`。
 */
export function resolveMainWindowNavigationAction(
  currentUrl: string | undefined | null,
  targetUrl: string,
): MainWindowGuardAction {
  const target = parseUrlOrNone(targetUrl);
  if (!target || !MAIN_FRAME_NAVIGABLE_PROTOCOLS.has(target.protocol)) {
    return "block";
  }
  const current = parseUrlOrNone(currentUrl);
  if (target.protocol === "file:") {
    return current?.protocol === "file:" ? "allow" : "block";
  }
  if (
    current &&
    isHttpOrHttpsProtocol(current.protocol) &&
    current.origin === target.origin
  ) {
    return "allow";
  }
  return "open-external";
}

/**
 * 主窗 window.open 裁决：一律不创建新 BrowserWindow（全仓 renderer/UI 无 window.open 调用方），
 * 仅 http(s) 目标附带转交系统浏览器，避免用户点击外链后「毫无反应」。
 */
export function resolveMainWindowWindowOpenAction(targetUrl: string): MainWindowGuardAction {
  const target = parseUrlOrNone(targetUrl);
  if (target && isHttpOrHttpsProtocol(target.protocol)) {
    return "open-external";
  }
  return "block";
}

interface MainWindowGuardLogger {
  warn: (...args: unknown[]) => void;
}

interface MainWindowGuardOptions {
  webContents: WebContents;
  logger: MainWindowGuardLogger;
}

function openExternalSafely(url: string, logger: MainWindowGuardLogger, reason: string): void {
  void shell.openExternal(url).catch((error: unknown) => {
    logger.warn("[main-window-guard] failed to open url externally", {
      reason,
      url,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

/**
 * 在主窗 webContents 上安装导航与弹窗守卫（specs/electron-hardening.md §1）。
 *
 * 编程式 loadURL/loadFile 与 location.reload() 不会触发 will-navigate，
 * 因此守卫不拦截启动加载与 Vite HMR 整页刷新。
 */
export function attachMainWindowNavigationGuards(options: MainWindowGuardOptions): void {
  const { webContents, logger } = options;

  webContents.setWindowOpenHandler((details): WindowOpenHandlerResponse => {
    const action = resolveMainWindowWindowOpenAction(details.url);
    if (action === "open-external") {
      openExternalSafely(details.url, logger, "window-open");
    } else {
      logger.warn("[main-window-guard] blocked window.open", { url: details.url });
    }
    // 主特权窗不允许 window.open 产生任何子窗口；外链统一走系统浏览器。
    return { action: "deny" };
  });

  webContents.on("will-navigate", (event, url) => {
    // will-navigate 只在主帧导航时触发；current URL 必须实时读取，
    // 同一窗口在 dev/package 两态之间启动时形态不同。
    const action = resolveMainWindowNavigationAction(webContents.getURL(), url);
    if (action === "allow") {
      return;
    }
    event.preventDefault();
    if (action === "open-external") {
      openExternalSafely(url, logger, "will-navigate");
      return;
    }
    logger.warn("[main-window-guard] blocked main frame navigation", { url });
  });
}
