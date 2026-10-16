/**
 * 桌面启动骨架采样的 shell 挂载（specs/boot-placeholder.md §9.5）。
 *
 * 采样器本体在 bootSkeletonSampler.ts（纯逻辑 + 可注入 DOM/定时器面）；本 hook 只负责
 * 装配三件接线事实：
 * - persist：本地 host 的 settingService.update({ desktopBootPlaceholder }) + platform
 *   .syncAppSettings(同 patch) 双写——setting.json 是 main bootstrap 的唯一读取源，
 *   syncAppSettings 让已运行窗口的 main 侧 payload 缓存与磁盘不分叉；
 * - readZoomFactor：复用 useDesktopZoomFactor（platform.getDesktopZoomLevel /
 *   onDesktopZoomLevelChanged 维护 1.1^level），zoom 变化进 effect deps，
 *   重启采样器后首采即带上新的 zoomFactor（frame 去重键含 zoomFactor，会持久化一次）；
 * - onError：只 warn，采样失败不影响 shell。
 *
 * 必须挂在渲染 `[data-workspace-shell="true"]` 与 `#sidebar` 的组件里（WorkspaceShellLayout）：
 * 采样器按这两个标记取几何，effect 在 DOM commit 后运行，标记此时已存在。
 * 开关 `bootPlaceholderEnabled` 只门控 main 侧首帧绘制（spec §4），采样保持常开，
 * 重新打开时立即有可用骨架。
 */
import { useEffect } from "react";
import { useDesktopZoomFactor } from "@/browser-use/useDesktopZoomFactor.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { logger } from "@/logger.js";
import { startBootSkeletonReporting, type BootSkeletonFrame } from "./bootSkeletonSampler.js";

export function useBootSkeletonReporting(options: { enabled: boolean }): void {
  const { enabled } = options;
  const services = useBaseWorkspaceServices();
  const platform = usePlatform();
  const zoomFactor = useDesktopZoomFactor();
  const settingService = services.settingService;

  useEffect(() => {
    if (!enabled) {
      return;
    }
    return startBootSkeletonReporting({
      readZoomFactor: () => zoomFactor,
      persist: async (frame: BootSkeletonFrame) => {
        const patch = { desktopBootPlaceholder: frame };
        await settingService.update(patch);
        platform.syncAppSettings?.(patch);
      },
      onError: (error: unknown) => {
        logger.warn("[boot-skeleton] 采样或持久化失败", {
          error: error instanceof Error ? error.message : String(error),
        });
      },
    });
  }, [enabled, platform, settingService, zoomFactor]);
}
