/* eslint-disable max-lines -- 权限矩阵、session 目标解析与 Electron 接线共享同一条安全判定链。 */
import { session as electronSession } from "electron";
import type { Session } from "electron";

/**
 * 全局权限请求策略（安全加固 P2 #2b，specs/electron-hardening.md §2）。
 *
 * 现状背景：Electron 默认放行全部权限请求，而内嵌浏览器（`<webview partition=
 * "persist:acode-embedded-browser">`）会加载任意页面；不设 handler 等于恶意页
 * 可以无确认拿摄像头/麦克风/屏幕捕获/定位。策略取「默认拒绝 + 显式最小放行」。
 */

/** Coding Plan 官网 webview 的持久 partition。原常量在 desktopCommandHandlers，移到这里统一维护。 */
export const CODING_PLAN_WEBVIEW_PARTITION = "persist:acode-coding-plan";

export type DesktopPermissionDecision = "granted" | "denied";

export type DesktopPermissionSessionName =
  | "default-session"
  | "embedded-browser"
  | "coding-plan-webview";

export interface DesktopPermissionPolicyTarget {
  name: DesktopPermissionSessionName;
  session: Session;
  /**
   * 该 session 是否承载「任意远程网页」（内嵌浏览器、Coding Plan 官网）。
   * 只有这类 session 保留网页对等体验所需的权限（如 pointerLock）。
   */
  servesArbitraryWebPages: boolean;
}

/**
 * 所有 session 都放行的权限（specs/electron-hardening.md §2 决策矩阵）：
 * - fullscreen：视频全屏 UX，无持久副作用；
 * - clipboard-sanitized-write：用户手势下的剪贴板写入（受 sanitized 语义约束），复制功能依赖。
 */
const UNIVERSALLY_GRANTED_PERMISSIONS: ReadonlySet<string> = new Set([
  "fullscreen",
  "clipboard-sanitized-write",
]);

/**
 * 仅「任意网页」session 额外放行的权限：pointerLock 维持网页（游戏/画布）的浏览器对等体验。
 * 应用自身 UI（defaultSession）不需要，保持拒绝以收窄特权页攻击面。
 */
const WEB_PAGE_PARITY_PERMISSIONS: ReadonlySet<string> = new Set(["pointerLock"]);

/**
 * 纯判定函数：给定时按矩阵返回 granted/denied。
 * 未识别的 permission 一律 denied（fail-closed，覆盖 Electron 未来新增类型）。
 */
export function resolveDesktopPermissionRequestDecision(input: {
  permission: string;
  servesArbitraryWebPages: boolean;
}): DesktopPermissionDecision {
  if (UNIVERSALLY_GRANTED_PERMISSIONS.has(input.permission)) {
    return "granted";
  }
  if (input.servesArbitraryWebPages && WEB_PAGE_PARITY_PERMISSIONS.has(input.permission)) {
    return "granted";
  }
  return "denied";
}

export interface DesktopSessionProvider {
  readonly defaultSession: Session;
  fromPartition(partition: string): Session;
}

interface PermissionPolicyLogger {
  info: (...args: unknown[]) => void;
}

export function resolveDesktopPermissionPolicyTargets(
  sessionProvider: DesktopSessionProvider,
): DesktopPermissionPolicyTarget[] {
  return [
    {
      name: "default-session",
      session: sessionProvider.defaultSession,
      servesArbitraryWebPages: false,
    },
    {
      name: "embedded-browser",
      session: electronSession.fromPartition("persist:acode-embedded-browser"),
      servesArbitraryWebPages: true,
    },
    {
      name: "coding-plan-webview",
      session: electronSession.fromPartition(CODING_PLAN_WEBVIEW_PARTITION),
      servesArbitraryWebPages: true,
    },
  ];
}

// fromPartition("persist:...") 返回的是进程级单例，模块级标记即可防止重复安装 handler
// 覆盖掉首次安装的策略（幂等）。
let permissionPolicyInstalled = false;

/**
 * 在三个承载 web 内容的 session 上安装 setPermissionRequestHandler（app ready 后调用一次）。
 *
 * 临时 recorder partition（acode-browser-video-recorder-*）刻意不覆盖：
 * 它是我们自己的录制页，已由 main 侧 setDisplayMediaRequestHandler 精确供流，
 * 不属于不可信页面（specs/electron-hardening.md §2）。
 */
export function installDesktopSessionPermissionPolicies(
  sessionProvider: DesktopSessionProvider,
  logger: PermissionPolicyLogger,
): void {
  if (permissionPolicyInstalled) {
    return;
  }
  // 只解析一次目标：fromPartition 虽在真实 Electron 里返回单例，但重复解析没有意义，
  // 也避免让日志行再触发一次 session 解析。
  const targets = resolveDesktopPermissionPolicyTargets(sessionProvider);
  for (const target of targets) {
    target.session.setPermissionRequestHandler((_webContents, permission, callback, details) => {
      const decision = resolveDesktopPermissionRequestDecision({
        permission,
        servesArbitraryWebPages: target.servesArbitraryWebPages,
      });
      if (decision === "denied") {
        // denied 决策统一落 info 日志（permission + 请求来源），便于审计误伤。
        logger.info("[desktop-permissions] denied permission request", {
          session: target.name,
          permission,
          requestingUrl: details.requestingUrl,
          isMainFrame: details.isMainFrame,
        });
      }
      callback(decision === "granted");
    });
  }
  permissionPolicyInstalled = true;
  logger.info("[desktop-permissions] permission request policies installed", {
    sessions: targets.map((target) => target.name),
  });
}

/** 仅供测试复位幂等标记；生产代码不得调用。 */
export function resetDesktopPermissionPolicyForTest(): void {
  permissionPolicyInstalled = false;
}
