import { BrowserWindow, ipcMain } from "electron";
import { PlatformChannels } from "@acode/shared";

import { resolveCuaPipWindowKey } from "./cuaPipFocusRouter.js";
import type { WebContentsId } from "./desktopWindowIds.js";

export function registerCuaPipActiveSessionIpc(options: {
  syncActiveTaskSession: (windowKey: WebContentsId, sessionId: string | null) => void;
  warn: (message: string) => void;
}): void {
  ipcMain.on(PlatformChannels.SyncActiveTaskSession, (event, payload: unknown) => {
    const senderWindow = BrowserWindow.fromWebContents(event.sender);
    const sessionId = typeof payload === "string" ? payload.trim() : "";
    if (!senderWindow) return;
    if (sessionId.length > 255) {
      options.warn("[cua-pip-session] ignored overlong active session id");
      return;
    }
    options.syncActiveTaskSession(resolveCuaPipWindowKey(senderWindow), sessionId || null);
  });
}
