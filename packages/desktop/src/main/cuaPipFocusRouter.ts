import type { PipSessionEvent } from "@acode/acode-cua/pip-session";
import { asWebContentsId, type WebContentsId } from "./desktopWindowIds.js";

type FocusEvent = Extract<PipSessionEvent, { kind: "focus-changed" }>;

// ID 空间：本路由器的 windowId 全部是 WebContentsId（resolveCuaPipWindowKey
// 是唯一取值口；消费端 windowHostProcessMap 同为 WebContentsId 空间）。
interface CuaPipFocusRouter {
  updateActiveSession(windowId: WebContentsId, sessionId: string | null): void;
  focusWindow(windowId: WebContentsId): void;
  blurWindow(windowId: WebContentsId): void;
  refreshWindow(windowId: WebContentsId): void;
  removeWindow(windowId: WebContentsId): void;
}

export function resolveCuaPipWindowKey(window: { webContents: { id: number } }): WebContentsId {
  return asWebContentsId(window.webContents.id);
}

export function createCuaPipFocusRouter(options: {
  send(windowId: WebContentsId, event: FocusEvent): void;
}): CuaPipFocusRouter {
  const activeSessionByWindow = new Map<WebContentsId, string | null>();
  let focusedWindowId: WebContentsId | null = null;
  let focusRevision = 0;

  const publish = (windowId: WebContentsId, sessionId: string | null) => {
    focusRevision += 1;
    options.send(windowId, {
      kind: "focus-changed",
      revision: focusRevision,
      sourceWindowId: `window-${windowId}`,
      sessionId,
    });
  };

  return {
    updateActiveSession(windowId, sessionId) {
      if (activeSessionByWindow.get(windowId) === sessionId) return;
      activeSessionByWindow.set(windowId, sessionId);
      if (focusedWindowId === windowId) publish(windowId, sessionId);
    },
    focusWindow(windowId) {
      if (focusedWindowId === windowId) return;
      const previous = focusedWindowId;
      focusedWindowId = windowId;
      if (previous !== null) publish(previous, null);
      publish(windowId, activeSessionByWindow.get(windowId) ?? null);
    },
    blurWindow(windowId) {
      if (focusedWindowId !== windowId) return;
      focusedWindowId = null;
      publish(windowId, null);
    },
    refreshWindow(windowId) {
      if (focusedWindowId !== windowId) return;
      publish(windowId, activeSessionByWindow.get(windowId) ?? null);
    },
    removeWindow(windowId) {
      activeSessionByWindow.delete(windowId);
      if (focusedWindowId !== windowId) return;
      focusedWindowId = null;
      publish(windowId, null);
    },
  };
}

// ============================================================================
// OS 级焦点归还（带 TTL）—— specs/embedded-content-focus-yield.md §4
// ============================================================================

/**
 * OS 窗口焦点桥。读取/归还「前台 OS 窗口句柄」需要平台原生面（Windows HWND /
 * macOS 窗口指针），当前构建没有该原生模块且零新增依赖——桥由接线方注入，
 * 缺席时协调器全链 fail-soft no-op（焦点归还是体验增强，绝不阻断面板 show/dismiss）。
 */
export interface OsWindowFocusBridge {
  /** 读取当前前台 OS 窗口句柄；不可得返回 null（0 同样视为不可得）。 */
  getForegroundWindowHandle(): number | null;
  /** 按句柄归还 OS 前台焦点；返回是否成功（失败不抛）。 */
  focusWindowByHandle(handle: number): boolean;
}

/** 超过该时限不再归还：用户已走远，把前台焦点抢回来是打扰而不是恢复。 */
export const CUA_PANEL_FOCUS_RETURN_TTL_MS = 30_000;

export interface CuaPanelFocusReturnCoordinator {
  /** 面板 show（将抢 OS 前台焦点）前调用：记录前台窗口句柄 + 时间戳。 */
  captureForegroundBeforeShow(): void;
  /** 面板 dismiss 后调用：TTL 内归还焦点；记录一次性消费，重复调用 no-op。 */
  restoreForegroundAfterDismiss(): void;
  /** 面板销毁 / app 退出等异常路径：丢弃记录，不归还。 */
  discardPendingReturn(): void;
  /** 是否存在待归还记录（测试与诊断用）。 */
  hasPendingReturn(): boolean;
}

/**
 * CUA 面板焦点归还协调器（机制移植，参考实现 :184866-184894）。
 *
 * 与本文件既有 router 的关系：router 的 blurWindow 已实现 app 内「blur 即 dismiss」
 * （blur → publish focus-changed(null) → PiP 退场）；本协调器是 OS 级增量——当面板
 * 形态是会抢前台焦点的独立 OS 窗口时，show 前 capture、dismiss（含 blur 触发的
 * dismiss）后 restore。当前 CUA 浮层均 focusable:false + showInactive()（不抢焦点），
 * 暂无调用方；TTL 语义先由单测锚定，接线随首个抢焦点浮窗出现。
 */
export function createCuaPanelFocusReturnCoordinator(
  options: {
    bridge?: OsWindowFocusBridge | null;
    now?: () => number;
    logger?: { debug(message: string, meta?: unknown): void };
  } = {},
): CuaPanelFocusReturnCoordinator {
  const now = options.now ?? (() => Date.now());
  const debug = options.logger?.debug ?? (() => {});
  let record: { handle: number; timestamp: number } | null = null;

  return {
    captureForegroundBeforeShow() {
      const bridge = options.bridge;
      if (!bridge) {
        record = null;
        return;
      }
      let handle: number | null;
      try {
        handle = bridge.getForegroundWindowHandle();
      } catch (error) {
        // 读取失败不阻断 show：宁可这次不归还，也不能让面板打不开。
        record = null;
        debug("[focus-return] capture failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      if (typeof handle !== "number" || !Number.isFinite(handle) || handle === 0) {
        record = null;
        debug("[focus-return] no foreground window handle");
        return;
      }
      record = { handle, timestamp: now() };
      debug("[focus-return] captured foreground window", { handle });
    },
    restoreForegroundAfterDismiss() {
      // 一次性消费：无论归还、过期还是抛错，记录都先清空，绝不二次归还。
      const pending = record;
      record = null;
      if (!pending) {
        return;
      }
      const ageMs = now() - pending.timestamp;
      if (ageMs > CUA_PANEL_FOCUS_RETURN_TTL_MS) {
        debug("[focus-return] record expired, skipping restore", { ageMs });
        return;
      }
      const bridge = options.bridge;
      if (!bridge) {
        return;
      }
      try {
        debug("[focus-return] restoring foreground window", { handle: pending.handle, ageMs });
        bridge.focusWindowByHandle(pending.handle);
      } catch (error) {
        debug("[focus-return] restore failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
    discardPendingReturn() {
      record = null;
    },
    hasPendingReturn() {
      return record !== null;
    },
  };
}
