import { ipcMain } from "electron";
import { PlatformChannels } from "@acode/shared";
import { z } from "zod";
import type { EmbeddedBrowserSitePermissionController } from "./browserView/embeddedBrowserSitePermissionController.js";

/**
 * 站点权限的桌面 IPC registrar（specs/embedded-browser-site-permissions.md）。
 * 判定纯函数与弹窗状态机见 browserView/embeddedBrowserSitePermissionController.ts；
 * 这里只做载荷校验与通道注册。挂 desktopMainIpcPlatform.ts 既有挂载点；
 * 不进 acode-protocol-v4——浏览器权限是平台能力，不是会话协议。
 */
export {
  EMBEDDED_BROWSER_ASKABLE_PERMISSIONS,
  EmbeddedBrowserSitePermissionController,
  embeddedBrowserPermissionActionWritesStore,
  isEmbeddedBrowserPermissionAction,
  resolveEmbeddedBrowserRequestOrigin,
  resolveEmbeddedBrowserSitePermissionRequestOutcome,
  splitEmbeddedBrowserPermissionRequest,
} from "./browserView/embeddedBrowserSitePermissionController.js";
export type {
  EmbeddedBrowserPermissionAction,
  EmbeddedBrowserSitePermissionControllerOptions,
  EmbeddedBrowserSitePermissionRequestOutcome,
} from "./browserView/embeddedBrowserSitePermissionController.js";

const embeddedBrowserPermissionResolveSchema = z
  .object({
    requestId: z.string().min(1).max(128),
    action: z.enum(["allow-always", "allow-session", "block-always", "deny-once"]),
  })
  .strict();

const embeddedBrowserPermissionResetSchema = z
  .object({
    origin: z.string().min(1).max(2048),
    permission: z.string().min(1).max(128),
  })
  .strict();

/**
 * registrar：站点权限的全部桌面 IPC（设置页管理面 + 弹窗应答）。
 */
export function registerDesktopSitePermissionIpcHandlers(options: {
  controller: EmbeddedBrowserSitePermissionController;
  logger: { warn: (...args: unknown[]) => void };
}): void {
  const { controller } = options;
  ipcMain.handle(PlatformChannels.GetEmbeddedBrowserSitePermissions, async () => {
    try {
      return { permissions: await controller.getPermissionTable() };
    } catch (error) {
      options.logger.warn("[embedded-browser-permissions] read table failed", error);
      return { permissions: {} };
    }
  });
  ipcMain.handle(
    PlatformChannels.ResetEmbeddedBrowserSitePermission,
    async (_event, payload: unknown) => {
      const parsed = embeddedBrowserPermissionResetSchema.safeParse(payload);
      if (!parsed.success) {
        return { success: false, error: "invalid_payload" };
      }
      try {
        await controller.resetPermission(parsed.data.origin, parsed.data.permission);
        return { success: true };
      } catch (error) {
        options.logger.warn("[embedded-browser-permissions] reset failed", error);
        return { success: false, error: "write_failed" };
      }
    },
  );
  ipcMain.handle(PlatformChannels.ClearEmbeddedBrowserSitePermissions, async () => {
    try {
      await controller.clearPermissions();
      return { success: true };
    } catch (error) {
      options.logger.warn("[embedded-browser-permissions] clear failed", error);
      return { success: false, error: "write_failed" };
    }
  });
  // 弹窗应答是单向 send：main 永远可达，未决弹窗不依赖 invoke 往返（spec 接口注释）。
  ipcMain.on(PlatformChannels.EmbeddedBrowserPermissionResolve, (_event, payload: unknown) => {
    const parsed = embeddedBrowserPermissionResolveSchema.safeParse(payload);
    if (!parsed.success) {
      options.logger.warn("[embedded-browser-permissions] invalid resolve payload", payload);
      return;
    }
    controller.resolvePrompt(parsed.data.requestId, parsed.data.action);
  });
}
