import { DesktopCommandIds, PlatformChannels, buildLocalMediaPreviewUrl } from "@acode/shared";
import type { IPlatformService, PlatformChannelMap } from "@acode/shared";

import { desktopBrowserPlatformBridge } from "./desktopBrowserPlatformBridge.js";

// 载荷/决策类型在 shared/platform.ts，未从 @acode/shared 入口再导出；
// 经由已导出的 PlatformChannelMap 对同名通道索引派生（desktopMainIpcPlatform.ts 先例）。
type MaterializeWorkflowArtifactFilePayload =
  PlatformChannelMap[(typeof PlatformChannels)["MaterializeWorkflowArtifactFile"]]["request"];
type EmbeddedBrowserSitePermissionDecision =
  PlatformChannelMap[(typeof PlatformChannels)["GetEmbeddedBrowserSitePermissions"]]["response"]["permissions"][string][string];

/**
 * window.acode 的新增桌面面（workflow artifact 物化 + 站点权限管理）。
 * 桥类型权威在 packages/client/src/globals.d.ts，本任务无权修改 client 包；
 * 这里用结构化交集收窄（非 any 断言）承载类型，client 侧补齐声明后可整体删除该视图。
 */
type DesktopAcodeBridgeWithRecentSurface = typeof window.acode & {
  materializeWorkflowArtifactFile?: (
    payload: MaterializeWorkflowArtifactFilePayload,
  ) => Promise<{ localPath: string } | { error: string }>;
  getEmbeddedBrowserSitePermissions?: () => Promise<{
    permissions: Record<string, Record<string, EmbeddedBrowserSitePermissionDecision>>;
  }>;
  resetEmbeddedBrowserSitePermission?: (payload: {
    origin: string;
    permission: string;
  }) => Promise<{ success: boolean; error?: string }>;
  clearEmbeddedBrowserSitePermissions?: () => Promise<{ success: boolean; error?: string }>;
};

export function createDesktopPlatform(options: {
  isLocalDevelopmentRuntime: boolean;
}): IPlatformService {
  const acodeBridge = window.acode as DesktopAcodeBridgeWithRecentSurface;
  // 先捕获再判存：方法存在性在窗口生命周期内不变（contextBridge 冻结），避免回调里重复判空。
  const materializeWorkflowArtifactFile = acodeBridge.materializeWorkflowArtifactFile;
  const getEmbeddedBrowserSitePermissions = acodeBridge.getEmbeddedBrowserSitePermissions;
  const resetEmbeddedBrowserSitePermission = acodeBridge.resetEmbeddedBrowserSitePermission;
  const clearEmbeddedBrowserSitePermissions = acodeBridge.clearEmbeddedBrowserSitePermissions;
  return {
    canSelectFilePath: true,
    createLocalMediaPreviewUrl: buildLocalMediaPreviewUrl,
    isLocalDevelopmentRuntime: options.isLocalDevelopmentRuntime,
    selectDirectory: () => window.acode.selectDirectory(),
    selectFile: () => window.acode.selectFile(),
    selectFiles: () => window.acode.selectFiles?.() ?? Promise.resolve([]),
    createTempTextAttachment: (payload) => window.acode.createTempTextAttachment(payload),
    onRemoteConnectionLog: (handler) => window.acode.onRemoteConnectionLog(handler),
    onRemoteSSHHostKeyChallenge: (handler) => window.acode.onRemoteSSHHostKeyChallenge(handler),
    respondSSHHostKeyChallenge: (payload) => window.acode.respondSSHHostKeyChallenge(payload),
    onRemoteSessionClosed: (handler) => window.acode.onRemoteSessionClosed(handler),
    onBotRemoteWorkspaceReconnected: (handler) =>
      window.acode.onBotRemoteWorkspaceReconnected(handler),
    activateOrSetWorkspace: (path) =>
      window.acode.activateOrSetWorkspace?.(path) ?? Promise.resolve({ activated: false }),
    connectRemote: (remoteOptions, requestId, context) =>
      window.acode.connectRemote(remoteOptions, requestId, context),
    cancelPendingRemoteConnection: (requestId) =>
      window.acode.cancelPendingRemoteConnection?.(requestId) ?? Promise.resolve(),
    bindRemoteWorkspaceSessionContext: (context) =>
      window.acode.bindRemoteWorkspaceSessionContext?.(context) ?? Promise.resolve(),
    disposeRemoteSession: (sessionId) => window.acode.disposeRemoteSession(sessionId),
    isDockerAvailable: () => window.acode.isDockerAvailable(),
    listWSLDistros: () => window.acode.listWSLDistros(),
    listDockerContainers: () => window.acode.listDockerContainers(),
    listSSHConfigAliases: () => window.acode.listSSHConfigAliases(),
    loadMcpFromUserDirectory: (payload) => window.acode.loadMcpFromUserDirectory(payload),
    saveMcpToUserDirectory: (payload) => window.acode.saveMcpToUserDirectory(payload),
    migrateLegacyCommonMcp: (payload) => window.acode.migrateLegacyCommonMcp(payload),
    openExternal: (url) => window.acode.openExternal(url),
    openFeedback: () => window.acode.executeDesktopCommand(DesktopCommandIds.OpenFeedback),
    openCommunity: () => window.acode.executeDesktopCommand(DesktopCommandIds.OpenCommunity),
    canOpenCommunity: (locale) => window.acode.canOpenCommunity(locale),
    openInFileManager: (path) => window.acode.openInFileManager(path),
    openExternalFile: (path) => window.acode.openExternalFile(path),
    // 物化 + 站点权限管理面：preload 桥缺席（旧 preload）时保持 undefined，
    // UI 按 IPlatformService 可选方法缺席隐藏入口（AGENTS.md UI 边界）。
    materializeWorkflowArtifactFile: materializeWorkflowArtifactFile
      ? (payload) => materializeWorkflowArtifactFile(payload)
      : undefined,
    getEmbeddedBrowserSitePermissions: getEmbeddedBrowserSitePermissions
      ? () => getEmbeddedBrowserSitePermissions()
      : undefined,
    resetEmbeddedBrowserSitePermission: resetEmbeddedBrowserSitePermission
      ? (origin, permission) => resetEmbeddedBrowserSitePermission({ origin, permission })
      : undefined,
    clearEmbeddedBrowserSitePermissions: clearEmbeddedBrowserSitePermissions
      ? () => clearEmbeddedBrowserSitePermissions()
      : undefined,
    openCuaPermissionOnboarding: window.acode.openCuaPermissionOnboarding
      ? (permissionOptions) =>
          window.acode.openCuaPermissionOnboarding?.(permissionOptions) ??
          Promise.resolve({ success: false, error: "not_supported" })
      : undefined,
    prepareCuaHelperPermissionDrag: window.acode.prepareCuaHelperPermissionDrag
      ? () =>
          window.acode.prepareCuaHelperPermissionDrag?.() ??
          Promise.resolve({ success: false, error: "not_supported" })
      : undefined,
    startCuaHelperPermissionDrag: window.acode.startCuaHelperPermissionDrag
      ? () => window.acode.startCuaHelperPermissionDrag?.()
      : undefined,
    registerOAuthState: (payload) => window.acode.registerOAuthState(payload),
    onOAuthCallback: (callback) => window.acode.onOAuthCallback(callback),
    onPaymentCallback: (callback) => window.acode.onPaymentCallback(callback),
    notifyRendererReady: () => window.acode.notifyRendererReady(),
    showTaskNotification: (payload) => window.acode.showTaskNotification(payload),
    syncWindowTabs: (paths) => window.acode.syncWindowTabs(paths),
    syncWindowUnreadCount: (count) => window.acode.syncWindowUnreadCount(count),
    syncActiveTaskSession: (sessionId) => window.acode.syncActiveTaskSession(sessionId),
    syncAppSettings: (patch) => window.acode.syncAppSettings?.(patch),
    setShortcutRecordingActive: (active) => window.acode.setShortcutRecordingActive?.(active),
    onFocusTab: (handler) => window.acode.onFocusTab(handler),
    onNewTab: (handler) => window.acode.onNewTab(handler),
    onCloseActiveContextRequest: (handler) =>
      window.acode.onCloseActiveContextRequest?.(handler) ?? (() => {}),
    onOpenBrowserUrl: (handler) => window.acode.onOpenBrowserUrl?.(handler) ?? (() => {}),
    onBrowserViewScreenshotSurfacePrepare: (handler) =>
      window.acode.onBrowserViewScreenshotSurfacePrepare?.(handler) ?? (() => {}),
    onBrowserViewScreenshotSurfaceRelease: (handler) =>
      window.acode.onBrowserViewScreenshotSurfaceRelease?.(handler) ?? (() => {}),
    browserViewScreenshotSurfaceReady: (payload) =>
      window.acode.browserViewScreenshotSurfaceReady?.(payload),
    ...desktopBrowserPlatformBridge,
    onNewTask: (handler) => window.acode.onNewTask(handler),
    onOpenWorkspace: (handler) => {
      // 开发态或升级后的旧窗口可能仍运行未暴露 onOpenWorkspace 的 preload，
      // renderer 直接调用会在启动时崩溃。这里和 activateOrSetWorkspace 一样做兼容兜底，
      // 缺少该 bridge 时只禁用原生菜单回调，不影响应用继续打开。
      return window.acode.onOpenWorkspace?.(handler) ?? (() => {});
    },
    onOpenWorkspacePath: (handler) => window.acode.onOpenWorkspacePath?.(handler) ?? (() => {}),
    onOpenFeedbackDialog: (handler) => window.acode.onOpenFeedbackDialog?.(handler) ?? (() => {}),
    onOpenTicketsPanel: (handler) => window.acode.onOpenTicketsPanel?.(handler) ?? (() => {}),
    onWindowFullscreenChanged: (handler) => window.acode.onWindowFullscreenChanged(handler),
    getDesktopWindowChromeState: window.acode.getDesktopWindowChromeState
      ? () => window.acode.getDesktopWindowChromeState!()
      : undefined,
    onDesktopWindowChromeStateChanged: window.acode.onDesktopWindowChromeStateChanged
      ? (handler) => window.acode.onDesktopWindowChromeStateChanged!(handler)
      : undefined,
    getWindowControlsOverlayMetrics: () => window.acode.getWindowControlsOverlayMetrics?.() ?? null,
    onWindowControlsOverlayChanged: (handler) =>
      window.acode.onWindowControlsOverlayChanged?.(handler) ?? (() => {}),
    getDesktopZoomLevel: () =>
      window.acode.getDesktopZoomLevel?.() ?? Promise.resolve({ zoomLevel: 0 }),
    onDesktopZoomLevelChanged: (handler) =>
      window.acode.onDesktopZoomLevelChanged?.(handler) ?? (() => {}),
    onTaskNotificationClick: (handler) => window.acode.onTaskNotificationClick(handler),
    exportLogs: () => window.acode.exportLogs(),
    captureWindowScreenshot: () =>
      window.acode.captureWindowScreenshot?.() ?? Promise.resolve(null),
    onUpdateReady: (callback) => window.acode.onUpdateReady(callback),
    onUpdateCheckResult: (callback) => window.acode.onUpdateCheckResult(callback),
    onUpdateStateChanged: (callback) => window.acode.onUpdateStateChanged?.(callback) ?? (() => {}),
    getUpdateState: () =>
      window.acode.getUpdateState?.() ?? Promise.resolve({ kind: "idle", enabled: true }),
    downloadUpdate: () => window.acode.downloadUpdate?.() ?? Promise.resolve(),
    cancelUpdateDownload: () => window.acode.cancelUpdateDownload?.() ?? Promise.resolve(),
    openUpdateStatusWindow: () => window.acode.openUpdateStatusWindow?.() ?? Promise.resolve(),
    getAutoUpdatePreferences: () =>
      window.acode.getAutoUpdatePreferences?.() ??
      Promise.resolve({ autoDownloadAndInstallUpdates: false }),
    setAutoDownloadAndInstallUpdates: (enabled) =>
      window.acode.setAutoDownloadAndInstallUpdates?.(enabled) ?? Promise.resolve(),
    getDesktopSessionActivity: () =>
      window.acode.getDesktopSessionActivity?.() ??
      Promise.resolve({ runningAgentSessionCount: 0 }),
    getACodeStdioTapDevState: () =>
      window.acode.getACodeStdioTapDevState?.() ??
      Promise.resolve({ enabled: false, visible: false, logDir: "", statePath: "" }),
    onSettingsChanged: (callback) => window.acode.onSettingsChanged?.(callback) ?? (() => {}),
    onApplicationLocaleChanged: (callback) =>
      window.acode.onApplicationLocaleChanged?.(callback) ?? (() => {}),
    onPostUpdateReleaseNotes: (callback) => window.acode.onPostUpdateReleaseNotes(callback),
    acknowledgePostUpdateReleaseNotes: (version) =>
      window.acode.acknowledgePostUpdateReleaseNotes(version),
    skipUpdateVersion: (version) => window.acode.skipUpdateVersion?.(version) ?? Promise.resolve(),
    quitAndInstallUpdate: () => window.acode.quitAndInstallUpdate(),
    getInstalledEditors: () => window.acode.getInstalledEditors(),
    getApplicationIcon: (bundleId) =>
      window.acode.getApplicationIcon?.(bundleId) ?? Promise.resolve(null),
    openInEditor: (editorId, path, editorOptions) =>
      window.acode.openInEditor(editorId, path, editorOptions),
    executeDesktopCommand: (command) => window.acode.executeDesktopCommand(command),
    setApplicationLocale: (locale) => window.acode.setApplicationLocale(locale),
    getSystemLocale: () =>
      window.acode.getSystemLocale?.() ??
      Promise.resolve(navigator.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en-US"),
    setTitleBarTheme: (theme) => window.acode.setTitleBarTheme(theme),
    getDeviceId: () =>
      (window as Window & { __ACODE_DEVICE_ID__?: string }).__ACODE_DEVICE_ID__ ?? "",
    // 共享平台协议仍要求这两个方法；审计版不采集、不转发，避免业务 hook 调用失败。
  };
}
