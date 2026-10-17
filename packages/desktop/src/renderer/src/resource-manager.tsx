import { createRoot } from "react-dom/client";
import type { ResourceUsageSnapshot, StorageManagementBridge } from "@acode/shared";
import type { V4NetworkCaptureRecordsNotification } from "@acode/shared/acode-protocol-v4";
import "@acode/ui/styles.css";
import {
  ResourceManagerApp,
  ACodeIntlProvider,
  applyUiFontSizePx,
  loadUiFontSizePx,
  subscribeToUiFontSizeStorageChanges,
  applyPersistedAppearancePreferences,
  subscribeToAppearanceStorageChanges,
} from "@acode/ui";

/**
 * 网络观测桥（specs/runtime-network-capture.md；类型与 preload/resourceManager.ts 同形）。
 * TODO(整合方接线点)：packages/ui/src/resource-manager/ResourceManagerApp.tsx 的 props
 * 还没有 network 档；ui 侧补 `network?: ResourceManagerNetworkBridge` prop + network tab 后，
 * 在下方挂载处传 `network={window.resourceManager?.network}` 即可打通。
 */
export interface ResourceManagerNetworkBridge {
  setEnabled: (enabled: boolean) => Promise<{ success: boolean; error?: string }>;
  getState: () => Promise<{ enabled: boolean; captureId: string | null }>;
  subscribeRecords: (
    listener: (notification: V4NetworkCaptureRecordsNotification) => void,
  ) => () => void;
}

declare global {
  interface Window {
    resourceManager?: {
      getSnapshot: () => Promise<ResourceUsageSnapshot>;
      setSamplingActive: (active: boolean) => void;
      storage?: StorageManagementBridge;
      network?: ResourceManagerNetworkBridge;
    };
  }
}

type Theme = "light" | "dark" | "zai-light" | "zai-dark" | "system";

function resolveTheme(theme: Theme): "light" | "dark" {
  if (theme === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return theme === "dark" || theme === "zai-dark" ? "dark" : "light";
}

function applyResourceManagerTheme(): void {
  const savedTheme = (localStorage.getItem("acode-theme") as Theme | null) ?? "zai-dark";
  const resolvedTheme = resolveTheme(savedTheme);
  const appliedTheme =
    savedTheme === "system"
      ? resolvedTheme === "dark"
        ? "zai-dark"
        : "zai-light"
      : savedTheme === "dark"
        ? "zai-dark"
        : savedTheme === "light"
          ? "zai-light"
          : savedTheme;
  document.documentElement.classList.toggle("dark", resolvedTheme === "dark");
  document.documentElement.classList.toggle("theme-zai-light", appliedTheme === "zai-light");
  document.documentElement.classList.toggle("theme-zai-dark", appliedTheme === "zai-dark");
}

applyResourceManagerTheme();
// 资源管理器不创建主窗口的 Zustand store，text-ui-* 无法自动获得持久化基准。
// 首屏前显式应用，运行中再由 storage 事件同步，且不改变 html font-size 或接入业务 Host。
applyUiFontSizePx(loadUiFontSizePx());
subscribeToUiFontSizeStorageChanges();
// 三轴外观偏好同款（ui specs/appearance-preference-axes.md R5/R6）：无 store 即无
// applyTheme 收口点，首屏前显式应用根属性，运行中经 storage 事件跨窗同步。
applyPersistedAppearancePreferences();
subscribeToAppearanceStorageChanges();

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    // 语言沿用主窗口写入 localStorage 的偏好；不接 settingService，避免独立窗口再起一份 RPC。
    <ACodeIntlProvider>
      <ResourceManagerApp
        setSamplingActive={window.resourceManager?.setSamplingActive}
        getSnapshot={
          window.resourceManager ? () => window.resourceManager!.getSnapshot() : undefined
        }
        storage={window.resourceManager?.storage}
        // ui 侧 NetworkSection 的桥形状是 captureId?: string（undefined = 无未决 capture）；
        // preload 面是 string | null。在挂载点归一，不把 null 语义泄进 ui 包。
        network={
          window.resourceManager?.network
            ? {
                setEnabled: window.resourceManager.network.setEnabled,
                getState: async () => {
                  const state = await window.resourceManager!.network!.getState();
                  return {
                    enabled: state.enabled,
                    ...(state.captureId === null ? {} : { captureId: state.captureId }),
                  };
                },
                // preload 面推的是整包通知 {captureId, records}；ui 侧桥只吃 records 数组
                // （ui 的局部记录类型与 v4 schema 同形，status 含 null 档）。
                subscribeRecords: (
                  callback: (
                    records: readonly V4NetworkCaptureRecordsNotification["records"][number][],
                  ) => void,
                ) =>
                  window.resourceManager!.network!.subscribeRecords((notification) =>
                    callback(notification.records),
                  ),
              }
            : undefined
        }
      />
    </ACodeIntlProvider>,
  );
}
