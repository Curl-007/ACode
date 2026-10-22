import { PlatformChannels } from "@acode/shared";
import { z } from "zod";
import type { EmbeddedBrowserSitePermissionController } from "./browserView/embeddedBrowserSitePermissionController.js";
import { createPlatformIpcRegistry } from "./platformIpcRegistry.js";

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
 *
 * 注册过 platformIpcRegistry 工厂（specs/ipc-registration-factory.md 的样板域）：
 * sender 门控 = "app-renderer"（受信顶层帧 + 窗口身份解析——设置页与权限弹窗都来自
 * 应用 renderer 窗口，迁移前此处无任何 sender 校验，属加固）；同通道重复注册幂等
 * 替换；ipcMain.handle 同步段计时包装由工厂内部统一接线，不再逐处手写。
 */
export function registerDesktopSitePermissionIpcHandlers(options: {
  controller: EmbeddedBrowserSitePermissionController;
  logger: { warn: (...args: unknown[]) => void };
}): void {
  const { controller } = options;
  const registry = createPlatformIpcRegistry({ logger: options.logger });
  registry.handle(PlatformChannels.GetEmbeddedBrowserSitePermissions, {
    sender: "app-renderer",
    handler: async () => {
      try {
        return { permissions: await controller.getPermissionTable() };
      } catch (error) {
        options.logger.warn("[embedded-browser-permissions] read table failed", error);
        return { permissions: {} };
      }
    },
  });
  registry.handle(PlatformChannels.ResetEmbeddedBrowserSitePermission, {
    sender: "app-renderer",
    validate: embeddedBrowserPermissionResetSchema,
    // 保留存量 renderer 契约：无效载荷返回 {success:false,error:"invalid_payload"} 信封
    // 而非 invoke reject（行为不变迁移，spec R4 onInvalidPayload 语义）。
    onInvalidPayload: () => ({ success: false, error: "invalid_payload" }),
    handler: async (_context, payload) => {
      try {
        await controller.resetPermission(payload.origin, payload.permission);
        return { success: true };
      } catch (error) {
        options.logger.warn("[embedded-browser-permissions] reset failed", error);
        return { success: false, error: "write_failed" };
      }
    },
  });
  registry.handle(PlatformChannels.ClearEmbeddedBrowserSitePermissions, {
    sender: "app-renderer",
    handler: async () => {
      try {
        await controller.clearPermissions();
        return { success: true };
      } catch (error) {
        options.logger.warn("[embedded-browser-permissions] clear failed", error);
        return { success: false, error: "write_failed" };
      }
    },
  });
  // 弹窗应答是单向 send：main 永远可达，未决弹窗不依赖 invoke 往返（spec 接口注释）。
  registry.on(PlatformChannels.EmbeddedBrowserPermissionResolve, {
    sender: "app-renderer",
    validate: embeddedBrowserPermissionResolveSchema,
    handler: (_context, payload) => {
      controller.resolvePrompt(payload.requestId, payload.action);
    },
  });
}
