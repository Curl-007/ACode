import { lazy, Suspense, useEffect } from "react";
import { ServiceProvider } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";
import type { WorkspaceSettingsLayerProps } from "@/root/types.js";

// 解链让 lazy 分包生效（spec：renderer-memory-budget 规则 7）：SettingsPage 不再静态 import
// （静态链会把设置页模块并回主包，使 Root.tsx 的 React.lazy 边界失效）。
// 懒加载声明与 Root.tsx 保持同一来源与写法；该层是条件设置浮层，null fallback 无跳动。
const SettingsPage = lazy(() =>
  import("@/SettingsPage.js").then((module) => ({ default: module.SettingsPage })),
);

export function WorkspaceSettingsLayer({
  workspaceScopedServices,
  isDesktop,
  isMacDesktop,
  isWindowsDesktop,
  windowsWindowControlsRightPaddingPx,
  captionWorkspacePath,
  onBack,
  onCreateTask,
  onOpenWorkspace,
  allowOpenWorkspace,
  onLogin,
  onLogout,
  user,
}: WorkspaceSettingsLayerProps) {
  useEffect(() => {
    logger.info("[Root] settings layer mounted");
    return () => {
      logger.info("[Root] settings layer unmounted");
    };
  }, []);

  return (
    <div className="absolute inset-0 z-10">
      {/* 懒加载边界（规则 7）：设置浮层按需挂载；模块已解析时 React 不提交 fallback，零视觉差异。 */}
      <Suspense fallback={null}>
        {workspaceScopedServices ? (
          <ServiceProvider services={workspaceScopedServices}>
            <SettingsPage
              isDesktop={isDesktop}
              isMacDesktop={isMacDesktop}
              isWindowsDesktop={isWindowsDesktop}
              windowsWindowControlsRightPaddingPx={windowsWindowControlsRightPaddingPx}
              captionWorkspacePath={captionWorkspacePath}
              onBack={onBack}
              onCreateTask={onCreateTask}
              onOpenWorkspace={onOpenWorkspace}
              allowOpenWorkspace={allowOpenWorkspace}
              onLogin={onLogin}
              onLogout={onLogout}
              user={user}
            />
          </ServiceProvider>
        ) : (
          <SettingsPage
            isDesktop={isDesktop}
            isMacDesktop={isMacDesktop}
            isWindowsDesktop={isWindowsDesktop}
            windowsWindowControlsRightPaddingPx={windowsWindowControlsRightPaddingPx}
            captionWorkspacePath={captionWorkspacePath}
            onBack={onBack}
            onCreateTask={onCreateTask}
            onOpenWorkspace={onOpenWorkspace}
            allowOpenWorkspace={allowOpenWorkspace}
            onLogin={onLogin}
            onLogout={onLogout}
            user={user}
          />
        )}
      </Suspense>
    </div>
  );
}
