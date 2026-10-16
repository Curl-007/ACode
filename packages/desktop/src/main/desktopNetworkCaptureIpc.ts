import { randomUUID } from "node:crypto";
import { BrowserWindow, ipcMain } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import { PlatformChannels } from "@acode/shared";
import type { V4NetworkCaptureRecordsNotification } from "@acode/shared/acode-protocol-v4";
import { z } from "zod";
import {
  getResourceManagerWebContentsId,
  getResourceManagerWindowId,
} from "./resourceManagerWindow.js";
import { asWebContentsId } from "./desktopWindowIds.js";
import { deriveIpcSyncLabel, wrapIpcHandle } from "./ipcSyncTiming.js";

/**
 * 运行时网络观测的 desktop main 侧（specs/runtime-network-capture.md）。
 *
 * main 是开关状态的唯一记忆者：renderer（资源管理器）经
 * NetworkCaptureSetEnabled/GetState 读写；agent 进程换代/新会话 attach 时由 main
 * 按记忆重发 networkCaptureSetEnabled。观测记录是 live 事实：资源管理器窗口未打开时
 * 直接丢弃，不缓存不回放（与 v4 通知「不进 snapshot/recovery」同一纪律）。
 */

interface NetworkCaptureState {
  enabled: boolean;
  /** 当前未决 capture 的对账 id；关闭即失效并清空。 */
  captureId: string | null;
}

let networkCaptureState: NetworkCaptureState = { enabled: false, captureId: null };

/**
 * main → host → v4 networkCaptureSetEnabled 的发送面。
 *
 * 按 ResourceUsageSnapshotRequest/Result 先例：每个 window Host utility process 在
 * desktopHostProcess 创建时把自己注册成一个发送目标（bindNetworkCaptureHostChild）。
 * 开关请求用同一个 requestId 扇出给全部已注册 host——每个 host 的转发器以 existing-only
 * 语义调自己名下的 agent runtime；任一 host 回 ok 即视为开启成功，全部回失败（如
 * runtime_unavailable / unsupported）才向上报错。观测记录（receive…Records）不做扇出
 * 合并，逐批直推资源管理器。
 */
interface NetworkCaptureHostChildTransport {
  postMessage(message: unknown): void;
}

const networkCaptureHostChildren = new Set<NetworkCaptureHostChildTransport>();

interface PendingSetEnabled {
  expected: number;
  failures: string[];
  resolve: () => void;
  reject: (reason: string) => void;
  timer: NodeJS.Timeout;
}

const pendingSetEnabledByRequestId = new Map<string, PendingSetEnabled>();

/** desktopHostProcess 在 host child 创建/退出时调用；exit 时必须解绑防泄漏。 */
export function bindNetworkCaptureHostChild(child: NetworkCaptureHostChildTransport): void {
  networkCaptureHostChildren.add(child);
}

export function unbindNetworkCaptureHostChild(child: NetworkCaptureHostChildTransport): void {
  networkCaptureHostChildren.delete(child);
}

/** host 回结算：任一 ok 即成功；全员回齐且无 ok 才失败。 */
export function receiveNetworkCaptureSetEnabledResult(result: {
  requestId: string;
  ok: boolean;
  error?: string;
}): void {
  const pending = pendingSetEnabledByRequestId.get(result.requestId);
  if (!pending) return;
  pending.expected -= 1;
  if (result.ok) {
    clearTimeout(pending.timer);
    pendingSetEnabledByRequestId.delete(result.requestId);
    pending.resolve();
    return;
  }
  pending.failures.push(result.error ?? "unknown");
  if (pending.expected <= 0) {
    clearTimeout(pending.timer);
    pendingSetEnabledByRequestId.delete(result.requestId);
    pending.reject(pending.failures[0] ?? "no_host");
  }
}

/** host 上报的观测批量：直推资源管理器（live 事实，不缓存不回放）。 */
export function receiveNetworkCaptureRecords(notification: {
  captureId: string;
  records: V4NetworkCaptureRecordsNotification["records"];
}): void {
  pushNetworkCaptureRecordsToResourceManager({
    captureId: notification.captureId,
    records: notification.records,
  });
}

/**
 * 发送方鉴权：必须是资源管理器窗口本身。
 * 修复依据（specs/runtime-network-capture.md 桌面链路）：event.sender.id 是 WebContents id，
 * 只能与 RM 窗口的 webContents.id 同空间比较；此前误比 getResourceManagerWindowId()
 * （BrowserWindow.id，另一套计数器），导致合法 RM 开关被 forbidden、且撞上该窗口 id 的
 * 无关 renderer 越权。取值口径与 resourceManagerWindow 的 setResourceUsageSamplingActive /
 * getResourceUsageSnapshot（均比 instance.webContents.id）一致。
 */
function isResourceManagerSender(event: IpcMainInvokeEvent): boolean {
  const resourceManagerWebContentsId = getResourceManagerWebContentsId();
  return (
    resourceManagerWebContentsId !== null &&
    asWebContentsId(event.sender.id) === resourceManagerWebContentsId
  );
}

async function forwardNetworkCaptureEnabledToHosts(logger: {
  warn: (...args: unknown[]) => void;
}): Promise<{ success: boolean; error?: string }> {
  if (networkCaptureHostChildren.size === 0) {
    // 尚无 host child（启动极早期）：状态已记忆，agent ready 重发时会补上；不算错误。
    logger.warn("[network-capture] no host child bound yet; state remembered only");
    return { success: true };
  }
  const requestId = randomUUID();
  const settled = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingSetEnabledByRequestId.delete(requestId);
      reject("timeout");
    }, 10_000);
    pendingSetEnabledByRequestId.set(requestId, {
      expected: networkCaptureHostChildren.size,
      failures: [],
      resolve,
      reject,
      timer,
    });
  });
  const request = {
    type: "network-capture-set-enabled-request" as const,
    requestId,
    enabled: networkCaptureState.enabled,
    captureId: networkCaptureState.captureId,
  };
  for (const child of networkCaptureHostChildren) {
    try {
      child.postMessage(request);
    } catch (error) {
      // host 已退出：按一次失败回结算，避免 pending 永远等不齐。
      logger.warn(
        "[network-capture] post setEnabled to host failed",
        error instanceof Error ? error.message : String(error),
      );
      receiveNetworkCaptureSetEnabledResult({ requestId, ok: false, error: "post_failed" });
    }
  }
  try {
    await settled;
    return { success: true };
  } catch (error) {
    const reason = typeof error === "string" ? error : "forward_failed";
    return { success: false, error: reason };
  }
}

const networkCaptureSetEnabledPayloadSchema = z.object({ enabled: z.boolean() }).strict();

/**
 * registrar：NetworkCaptureSetEnabled / NetworkCaptureGetState。
 * SetEnabled 是变更操作，发送方 webContents 必须是资源管理器窗口
 * （resourceManagerWindow 校验先例）；GetState 是纯读取，不限制发送方。
 */
export function registerNetworkCaptureIpc(logger: { warn: (...args: unknown[]) => void }): void {
  ipcMain.handle(
    PlatformChannels.NetworkCaptureSetEnabled,
    wrapIpcHandle(
      deriveIpcSyncLabel(PlatformChannels.NetworkCaptureSetEnabled),
      async (event, payload: unknown): Promise<{ success: boolean; error?: string }> => {
        if (!isResourceManagerSender(event)) {
          return { success: false, error: "forbidden" };
        }
        const parsed = networkCaptureSetEnabledPayloadSchema.safeParse(payload);
        if (!parsed.success) {
          return { success: false, error: "invalid_payload" };
        }
        // 开启生成新的对账 captureId；关闭即失效（spec：关闭后 captureId 不再被接受）。
        networkCaptureState = parsed.data.enabled
          ? { enabled: true, captureId: randomUUID() }
          : { enabled: false, captureId: null };
        return forwardNetworkCaptureEnabledToHosts(logger);
      },
    ),
  );
  ipcMain.handle(
    PlatformChannels.NetworkCaptureGetState,
    wrapIpcHandle(deriveIpcSyncLabel(PlatformChannels.NetworkCaptureGetState), () => ({
      enabled: networkCaptureState.enabled,
      captureId: networkCaptureState.captureId,
    })),
  );
}

/**
 * host → main 的记录上报终点：只推给资源管理器窗口。
 * 窗口未开/已销毁时丢弃（live 事实，不缓存不回放）。
 */
export function pushNetworkCaptureRecordsToResourceManager(
  notification: V4NetworkCaptureRecordsNotification,
): void {
  const windowId = getResourceManagerWindowId();
  if (windowId === null) return;
  const win = BrowserWindow.fromId(windowId);
  if (!win || win.isDestroyed()) return;
  win.webContents.send(PlatformChannels.NetworkCaptureRecords, notification);
}

/**
 * agent 进程换代/新会话 attach 后由 main 按记忆重发开关
 * （spec 验收 4：agent 重启后开关保持，新请求继续出现）。
 * 由 desktopHostProcess 的 onAgentProcessReady 依赖回调触发。
 */
export function handleNetworkCaptureAgentRuntimeReady(logger: {
  warn: (...args: unknown[]) => void;
}): void {
  if (!networkCaptureState.enabled) return;
  void forwardNetworkCaptureEnabledToHosts(logger);
}

/** 仅供测试复位模块级状态；生产代码不得调用。 */
export function resetNetworkCaptureStateForTest(): void {
  networkCaptureState = { enabled: false, captureId: null };
  networkCaptureHostChildren.clear();
  for (const pending of pendingSetEnabledByRequestId.values()) {
    clearTimeout(pending.timer);
    pending.reject("reset");
  }
  pendingSetEnabledByRequestId.clear();
}
