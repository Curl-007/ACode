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

export function resolveCuaPipWindowKey(window: {
  webContents: { id: number };
}): WebContentsId {
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
