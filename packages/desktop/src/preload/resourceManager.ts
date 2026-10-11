import { contextBridge, ipcRenderer } from "electron";
import { PlatformChannels, formatACodeRendererProcessName } from "@acode/shared";
import type { V4NetworkCaptureRecordsNotification } from "@acode/shared/acode-protocol-v4";
import type {
  ResourceUsageSnapshot,
  StorageCleanRequest,
  StorageCleanResult,
  StorageManagementBridge,
  StorageUsageSnapshot,
} from "@acode/shared";

process.title = formatACodeRendererProcessName("Resource Manager");

const storage: StorageManagementBridge = {
  startScan: (): Promise<{ jobId: string }> =>
    ipcRenderer.invoke(PlatformChannels.StorageStartScan),
  cancelScan: (jobId: string): Promise<void> =>
    ipcRenderer.invoke(PlatformChannels.StorageCancelScan, jobId),
  getSnapshot: (): Promise<StorageUsageSnapshot | null> =>
    ipcRenderer.invoke(PlatformChannels.StorageGetSnapshot),
  clean: (request: StorageCleanRequest): Promise<StorageCleanResult> =>
    ipcRenderer.invoke(PlatformChannels.StorageClean, request),
  revealPath: (absolutePath: string): Promise<void> =>
    ipcRenderer.invoke(PlatformChannels.StorageRevealPath, absolutePath),
  subscribeScanProgress: (listener) => {
    const handler = (_event: unknown, snapshot: StorageUsageSnapshot) => listener(snapshot);
    ipcRenderer.on(PlatformChannels.StorageScanProgress, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.StorageScanProgress, handler);
  },
};

/**
 * 网络观测桥（specs/runtime-network-capture.md）：开关走 invoke（main 记忆状态并转发
 * host→agent v4 命令），记录批量推送与 StorageScanProgress 同一 subscribe 模式。
 * 观测是 live 事实：窗口未订阅/未打开期间 main 不缓存不回放。
 */
const network = {
  setEnabled: (enabled: boolean): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke(PlatformChannels.NetworkCaptureSetEnabled, { enabled }),
  getState: (): Promise<{ enabled: boolean; captureId: string | null }> =>
    ipcRenderer.invoke(PlatformChannels.NetworkCaptureGetState),
  subscribeRecords: (listener: (notification: V4NetworkCaptureRecordsNotification) => void) => {
    const handler = (_event: unknown, payload: unknown) =>
      listener(payload as V4NetworkCaptureRecordsNotification);
    ipcRenderer.on(PlatformChannels.NetworkCaptureRecords, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.NetworkCaptureRecords, handler);
  },
};

/**
 * 资源管理器窗口专用 preload —— 资源快照拉取 + 存储管理命令面 + 网络观测命令面。
 * 不需要 MessagePort 转发，因为资源管理器窗口不使用 RPC 服务，也不接入桌面 continuous 主链路；
 * 存储服务由 main 持有，这里只是 ipc 桥。
 */
contextBridge.exposeInMainWorld("resourceManager", {
  setSamplingActive: (active: boolean): void =>
    ipcRenderer.send(PlatformChannels.SetResourceUsageSamplingActive, active),
  getSnapshot: (): Promise<ResourceUsageSnapshot> =>
    ipcRenderer.invoke(PlatformChannels.GetResourceUsageSnapshot),
  storage,
  network,
});
