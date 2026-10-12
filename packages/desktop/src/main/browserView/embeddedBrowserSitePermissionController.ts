import { randomUUID } from "node:crypto";
import { BrowserWindow } from "electron";
import type { BrowserWindow as BrowserWindowType, WebContents } from "electron";
import { PlatformChannels } from "@acode/shared";
import type { PlatformChannelMap } from "@acode/shared";
import type {
  EmbeddedBrowserSitePermissionDecision,
  EmbeddedBrowserSitePermissionStore,
} from "./embeddedBrowserSitePermissionStore.js";
import { resolveDesktopPermissionRequestDecision } from "../desktopSessionPermissionPolicy.js";

/**
 * 站点权限的载荷类型定义在 shared/platform.ts 但未从 @acode/shared 入口再导出
 * （desktopMainIpcPlatform.ts 对 WindowControlsOverlayReadyPayload 的同一处境）；
 * 经由已导出的 PlatformChannelMap 对同名通道做索引访问派生，保持单一来源。
 */
export type EmbeddedBrowserPermissionAction =
  PlatformChannelMap[(typeof PlatformChannels)["EmbeddedBrowserPermissionResolve"]]["request"]["action"];
type EmbeddedBrowserPermissionPromptPayload =
  PlatformChannelMap[(typeof PlatformChannels)["EmbeddedBrowserPermissionPrompt"]]["request"];

/**
 * 嵌入式浏览器站点权限：main 侧唯一决策者（specs/embedded-browser-site-permissions.md）。
 * 判定纯函数 + 弹窗状态机；IPC registrar 见 desktopSitePermissionIpc.ts。
 * 纪律：闭集外同步 denied（无 prompt 路径）；同步探测只认 store allow 与 session-allow；
 * 弹窗期同 (origin, 细分权限集合) 去重共享未决 Promise（media 按子权限建键，详见 spec）；
 * 未知/过期 requestId 的 resolve → warn 后按 deny-once 结算语义（什么都不写），不抛错。
 */

/** 可询问权限闭集（spec 产品规则；clipboard-read/usb/hid/serial/屏幕捕获刻意不在内）。 */
export const EMBEDDED_BROWSER_ASKABLE_PERMISSIONS: ReadonlySet<string> = new Set([
  "camera",
  "microphone",
  "geolocation",
  "notifications",
  "midi",
  "midiSysex",
]);

/** media 权限按 mediaTypes 细分进 camera/microphone 后走同一条链（spec 产品规则）。 */
export function splitEmbeddedBrowserPermissionRequest(
  permission: string,
  mediaTypes?: readonly string[],
): string[] {
  if (permission === "media") {
    const split = new Set<string>();
    for (const mediaType of mediaTypes ?? []) {
      if (mediaType === "video") split.add("camera");
      else if (mediaType === "audio") split.add("microphone");
    }
    // Electron 对未声明 mediaTypes 的 media 请求按“可能同时要音视频”处理，
    // 这里同样保守地覆盖两者，避免只弹一半导致另一半静默拒绝。
    if (split.size === 0) return ["camera", "microphone"];
    return [...split];
  }
  return EMBEDDED_BROWSER_ASKABLE_PERMISSIONS.has(permission) ? [permission] : [];
}

export type EmbeddedBrowserSitePermissionRequestOutcome =
  | { kind: "granted"; reason: "static-matrix" | "stored-allow" | "session-allow" }
  | { kind: "denied"; reason: "not-askable" | "invalid-origin" | "stored-deny" }
  | { kind: "prompt"; permissions: string[] };

/**
 * 纯判定：给定时按 store/session/闭集返回 granted/denied/prompt。
 * 不可询问集合同步 denied（fail-closed）；从不触发弹窗。
 */
export function resolveEmbeddedBrowserSitePermissionRequestOutcome(input: {
  permission: string;
  mediaTypes?: readonly string[];
  origin: string | null;
  stored: Record<string, EmbeddedBrowserSitePermissionDecision> | undefined;
  isSessionAllowed: (permission: string) => boolean;
}): EmbeddedBrowserSitePermissionRequestOutcome {
  if (
    resolveDesktopPermissionRequestDecision({
      permission: input.permission,
      servesArbitraryWebPages: true,
    }) === "granted"
  ) {
    return { kind: "granted", reason: "static-matrix" };
  }
  const permissions = splitEmbeddedBrowserPermissionRequest(input.permission, input.mediaTypes);
  if (permissions.length === 0) {
    return { kind: "denied", reason: "not-askable" };
  }
  if (!input.origin) {
    return { kind: "denied", reason: "invalid-origin" };
  }
  if (permissions.some((permission) => input.stored?.[permission] === "deny")) {
    return { kind: "denied", reason: "stored-deny" };
  }
  if (permissions.every((permission) => input.stored?.[permission] === "allow")) {
    return { kind: "granted", reason: "stored-allow" };
  }
  if (permissions.every((permission) => input.isSessionAllowed(permission))) {
    return { kind: "granted", reason: "session-allow" };
  }
  return { kind: "prompt", permissions };
}

/** 四档动作里需要写 store 的两档；allow-session 只写内存 session 集，deny-once 什么都不写。 */
export function embeddedBrowserPermissionActionWritesStore(
  action: EmbeddedBrowserPermissionAction,
): EmbeddedBrowserSitePermissionDecision | null {
  if (action === "allow-always") return "allow";
  if (action === "block-always") return "deny";
  return null;
}

/** 未知/已结算的 requestId 按 deny-once 结算：不写任何存储（spec 验收 5）。 */
export function isEmbeddedBrowserPermissionAction(
  value: unknown,
): value is EmbeddedBrowserPermissionAction {
  return (
    value === "allow-always" ||
    value === "allow-session" ||
    value === "block-always" ||
    value === "deny-once"
  );
}

/** 请求 URL → origin；file:/about: 等无法给出可信 origin 的请求一律 null（fail-closed）。 */
export function resolveEmbeddedBrowserRequestOrigin(
  requestingUrl: string | undefined,
): string | null {
  if (!requestingUrl) return null;
  try {
    const origin = new URL(requestingUrl).origin;
    if (!origin || origin === "null" || !origin.startsWith("http")) return null;
    return origin;
  } catch {
    return null;
  }
}

interface PendingPromptEntry {
  key: string;
  permissions: string[];
  origin: string;
  settle: (allowed: boolean) => void;
}

export interface EmbeddedBrowserSitePermissionControllerOptions {
  store: EmbeddedBrowserSitePermissionStore;
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
  };
  /** 弹窗目标窗口解析；缺省 webview guest → 宿主窗口（与 CUA 权限面板同一解析规则）。 */
  resolveTargetWindow?: (webContents: WebContents) => BrowserWindowType | null;
  generateRequestId?: () => string;
}

export class EmbeddedBrowserSitePermissionController {
  private readonly sessionAllows = new Map<string, Set<string>>();
  private readonly pendingByRequest = new Map<string, PendingPromptEntry>();
  private readonly pendingByKey = new Map<string, Promise<boolean>>();

  constructor(private readonly options: EmbeddedBrowserSitePermissionControllerOptions) {}

  /**
   * 弹窗目标窗口 = 嵌入浏览器所在窗口（spec：与 CUA 权限面板同一窗口解析规则）。
   * 权限请求来自 `<webview>` guest webContents；fromWebContents 对 guest 会解析到
   * 承载它的宿主窗口，非 guest 场景则回到窗口自身。
   */
  private resolveTargetWindow(webContents: WebContents): BrowserWindowType | null {
    if (this.options.resolveTargetWindow) {
      return this.options.resolveTargetWindow(webContents);
    }
    try {
      return BrowserWindow.fromWebContents(webContents);
    } catch {
      return null;
    }
  }

  /**
   * setPermissionRequestHandler 的嵌入浏览器分支。
   * callback 可延迟调用（Electron 允许）；本方法自身不抛错，一切失败路径都收敛为 callback(false)。
   */
  handlePermissionRequest(
    webContents: WebContents,
    permission: string,
    callback: (permissionGranted: boolean) => void,
    details: { requestingUrl?: string; mediaTypes?: string[] },
  ): void {
    void this.resolvePermissionRequest(webContents, permission, callback, details).catch(() => {
      // 读取 store 等基础设施失败也必须结算 callback，绝不让 guest 永久挂起。
      callback(false);
    });
  }

  private async resolvePermissionRequest(
    webContents: WebContents,
    permission: string,
    callback: (permissionGranted: boolean) => void,
    details: { requestingUrl?: string; mediaTypes?: string[] },
  ): Promise<void> {
    const origin = resolveEmbeddedBrowserRequestOrigin(details.requestingUrl);
    // 快路径：优先用已加载的内存快照，让常见路径保持同步判定；
    // 首次加载前快照为 null（fail-closed 语义下与空表等价），再走完整读取。
    const cached = this.options.store.getCachedTable();
    const storedTable = cached ?? (await this.options.store.readTable());
    const outcome = resolveEmbeddedBrowserSitePermissionRequestOutcome({
      permission,
      mediaTypes: details.mediaTypes,
      origin,
      stored: origin ? storedTable[origin] : undefined,
      isSessionAllowed: (candidate) =>
        this.sessionAllows.get(origin ?? "")?.has(candidate) === true,
    });
    if (outcome.kind === "granted") {
      callback(true);
      return;
    }
    if (outcome.kind === "denied") {
      this.options.logger.info("[embedded-browser-permissions] denied permission request", {
        permission,
        reason: outcome.reason,
        requestingUrl: details.requestingUrl,
      });
      callback(false);
      return;
    }

    // outcome 为 prompt 时 origin 必然有效（invalid-origin 已在 denied 分支拦截）；
    // 这里再显式收窄一次，让类型与判定链共享同一条不变量。
    const promptOrigin = origin;
    if (!promptOrigin) {
      callback(false);
      return;
    }

    // 去重键用细分后的子权限集合而非原始 permission：否则并发 media(video)/media(audio)
    // 命中同一 `origin\0media`，后到者静默继承摄像头决策（fail-open；见 spec）。
    const key = `${promptOrigin}\0${[...outcome.permissions].sort().join(",")}`;
    const pendingExisting = this.pendingByKey.get(key);
    if (pendingExisting) {
      // 同一 (origin, 细分权限集合) 去重：并发请求共享同一个未决 Promise（spec 产品规则）。
      callback(await pendingExisting);
      return;
    }

    const targetWindow = this.resolveTargetWindow(webContents);
    if (!targetWindow || targetWindow.isDestroyed()) {
      // 弹窗目标窗口不可用：同步 denied 并 warn，不排队（spec 事件顺序）。
      this.options.logger.warn(
        "[embedded-browser-permissions] prompt target window unavailable; denying",
        { permission, origin },
      );
      callback(false);
      return;
    }

    const requestId = this.options.generateRequestId?.() ?? randomUUID();
    const entry: PendingPromptEntry = {
      key,
      origin: promptOrigin,
      permissions: outcome.permissions,
      settle: () => undefined,
    };
    const promise = new Promise<boolean>((resolve) => {
      entry.settle = resolve;
    });
    this.pendingByRequest.set(requestId, entry);
    this.pendingByKey.set(key, promise);

    // 弹窗窗口在应答前被关闭：按 deny-once 结算，绝不挂等一个再也不会来的 resolve。
    const onWindowClosed = () => {
      this.settlePrompt(requestId, false);
    };
    targetWindow.once("closed", onWindowClosed);

    const payload: EmbeddedBrowserPermissionPromptPayload = {
      requestId,
      origin: promptOrigin,
      permission,
      ...(details.mediaTypes && details.mediaTypes.length > 0
        ? { mediaTypes: details.mediaTypes }
        : {}),
    };
    targetWindow.webContents.send(PlatformChannels.EmbeddedBrowserPermissionPrompt, payload);

    const allowed = await promise;
    try {
      targetWindow.removeListener("closed", onWindowClosed);
    } catch {
      // 窗口已随销毁一并释放监听（Electron destroyed 对象访问即抛）；无需清理。
    }
    callback(allowed);
  }

  /** 弹窗应答（renderer → main）。未知/过期 requestId → warn + deny-once 语义结算。 */
  resolvePrompt(requestId: unknown, action: unknown): void {
    if (typeof requestId !== "string" || !isEmbeddedBrowserPermissionAction(action)) {
      this.options.logger.warn("[embedded-browser-permissions] invalid resolve payload; ignoring", {
        requestId,
      });
      return;
    }
    const entry = this.pendingByRequest.get(requestId);
    if (!entry) {
      // 已结算（过期）或伪造 id：warn 后按 deny-once 结算（不写任何存储，不抛错）。
      this.options.logger.warn(
        "[embedded-browser-permissions] resolve for unknown or settled requestId; settling as deny-once",
        { requestId, action },
      );
      return;
    }
    this.settlePrompt(requestId, this.applyAction(entry, action));
  }

  private applyAction(entry: PendingPromptEntry, action: EmbeddedBrowserPermissionAction): boolean {
    const storeDecision = embeddedBrowserPermissionActionWritesStore(action);
    if (storeDecision) {
      for (const permission of entry.permissions) {
        void this.options.store
          .setDecision(entry.origin, permission, storeDecision)
          .catch((error) => {
            this.options.logger.warn("[embedded-browser-permissions] persist decision failed", {
              origin: entry.origin,
              error: error instanceof Error ? error.message : String(error),
            });
          });
      }
    }
    if (action === "allow-session") {
      const permissions = this.sessionAllows.get(entry.origin) ?? new Set<string>();
      for (const permission of entry.permissions) permissions.add(permission);
      this.sessionAllows.set(entry.origin, permissions);
    }
    return action === "allow-always" || action === "allow-session";
  }

  private settlePrompt(requestId: string, allowed: boolean): void {
    const entry = this.pendingByRequest.get(requestId);
    if (!entry) return;
    this.pendingByRequest.delete(requestId);
    // 等待共享 Promise 的并发请求已持有 Promise 引用，同步删除 key 不影响它们拿到同一决策。
    this.pendingByKey.delete(entry.key);
    entry.settle(allowed);
  }

  /**
   * 同步探测（setPermissionCheckHandler）：只认 store "allow" 与 session-allow；
   * 静态矩阵放行项（fullscreen 等）镜像放行，其余一律 false。从不触发弹窗。
   */
  checkPermission(
    requestingOrigin: string | undefined,
    permission: string,
    mediaType?: string,
  ): boolean {
    if (
      resolveDesktopPermissionRequestDecision({
        permission,
        servesArbitraryWebPages: true,
      }) === "granted"
    ) {
      return true;
    }
    const origin =
      requestingOrigin && requestingOrigin.startsWith("http") ? requestingOrigin : null;
    if (!origin) return false;
    const permissions = splitEmbeddedBrowserPermissionRequest(
      permission,
      mediaType ? [mediaType] : undefined,
    );
    if (permissions.length === 0) return false;
    const stored = this.options.store.getCachedTable()?.[origin];
    const sessionAllowed = this.sessionAllows.get(origin);
    return permissions.every(
      (candidate) => stored?.[candidate] === "allow" || sessionAllowed?.has(candidate) === true,
    );
  }

  /** 设置页管理面：读取整表。 */
  async getPermissionTable() {
    return this.options.store.readTable();
  }

  /** 重置某 origin 的某权限记录：同时清 session-allow，下次请求重新弹窗（spec 验收 3）。 */
  async resetPermission(origin: string, permission: string): Promise<void> {
    const permissions = this.sessionAllows.get(origin);
    permissions?.delete(permission);
    if (permissions && permissions.size === 0) this.sessionAllows.delete(origin);
    await this.options.store.resetDecision(origin, permission);
  }

  /** 清空全部站点权限（含会话级允许）。 */
  async clearPermissions(): Promise<void> {
    this.sessionAllows.clear();
    await this.options.store.clearAll();
  }

  /** 退出屏障：等待所有已提交的 store mutation 完成。 */
  async whenIdle(): Promise<void> {
    await this.options.store.whenIdle();
  }
}
