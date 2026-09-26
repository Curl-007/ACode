import { DesktopCommandIds, buildLocalMediaPreviewUrl, type IPlatformService } from "@acode/shared";

import { desktopBrowserPlatformBridge } from "./desktopBrowserPlatformBridge.js";

export function createDesktopPlatform(options: {
  isLocalDevelopmentRuntime: boolean;
}): IPlatformService {
  return {
    canSelectFilePath: true,
    createLocalMediaPreviewUrl: buildLocalMediaPreviewUrl,
    isLocalDevelopmentRuntime: options.isLocalDevelopmentRuntime,
    selectDirectory: () => window.acode.selectDirectory(),
    selectFile: () => window.acode.selectFile(),
    selectFiles: () => window.acode.selectFiles?.() ?? Promise.resolve([]),
    createTempTextAttachment: (payload) => window.acode.createTempTextAttachment(payload),
    onRemoteConnectionLog: (handler) => window.acode.onRemoteConnectionLog(handler),
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
    onShareImport: (callback) => window.acode.onShareImport?.(callback) ?? (() => {}),
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
