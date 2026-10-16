import type { BrowserWindow } from "electron";
import type { ExternalWorkspaceOpenDialogCopy } from "./desktopOAuthDeepLink.js";
import {
  extractDeepLinkUrlFromArgs,
  extractDeepLinkUrlFromSingleInstanceData,
  extractOpenWorkspacePathFromArgs,
  extractOpenWorkspacePathFromSingleInstanceData,
} from "./desktopDeepLinkUrl.js";
import {
  createSecondInstanceArgvDedupe,
  inspectDeepLinkWorkspacePath,
  renderSafeUrlForLog,
} from "./deepLinkHardening.js";

interface SecondInstanceWorkspaceDeps {
  additionalData: unknown;
  argv: readonly string[];
  forceUpdateBlocked: boolean;
  focusForceUpdateGateWindow: () => void;
  handleDeepLink: (
    url: string,
    options: {
      canOpenWorkspace: () => boolean;
      confirmationCopy?: ExternalWorkspaceOpenDialogCopy;
      onWorkspaceOpenBlocked: () => void;
      resolveApplicationWindow?: () => BrowserWindow | null;
    },
  ) => boolean;
  handleOpenWorkspacePath: (
    path: string,
    options?: {
      allowWithoutReadyWindow?: boolean;
      resolveApplicationWindow?: () => BrowserWindow | null;
    },
  ) => boolean;
  logger: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void };
  workspaceConfirmationCopy?: ExternalWorkspaceOpenDialogCopy;
  resolveApplicationWindow?: () => BrowserWindow | null;
  /** second-instance 事件的工作目录；参与 500ms 去重键（argv+cwd）。 */
  workingDirectory?: string;
}

// 深链硬化 §4b：桌面环境/协议处理器可能对同一次深链点击连发多次 second-instance
// （Linux argv 重排同源），进程内单例去重槽跨事件生效。
const secondInstanceArgvDedupe = createSecondInstanceArgvDedupe();

export function handleSecondInstanceWorkspaceRequest(deps: SecondInstanceWorkspaceDeps): boolean {
  if (secondInstanceArgvDedupe.isDuplicate(deps.argv, deps.workingDirectory)) {
    // 重复事件整体抑制（含窗口聚焦回退）；argv 内容不进日志（可能含 OAuth code/state）。
    deps.logger.info("[second-instance] 500ms 去重窗口内抑制重复 argv");
    return true;
  }

  const url =
    // Linux 的 second-instance argv 可能被桌面环境重排或追加参数。
    // Electron 官方建议精确参数走 additionalData，这里优先读取第二实例预解析出的 deep link。
    extractDeepLinkUrlFromSingleInstanceData(deps.additionalData) ??
    extractDeepLinkUrlFromArgs(deps.argv);
  if (url) {
    const handled = deps.handleDeepLink(url, {
      canOpenWorkspace: () => !deps.forceUpdateBlocked,
      confirmationCopy: deps.workspaceConfirmationCopy,
      resolveApplicationWindow: deps.resolveApplicationWindow,
      onWorkspaceOpenBlocked: () => {
        deps.logger.warn(
          "[force-update] 已忽略强制升级期间的 second-instance workspace deep link 请求",
        );
        deps.focusForceUpdateGateWindow();
      },
    });
    if (handled) {
      return true;
    }
    // §4f：失败诊断只落安全渲染形态（query/hash 遮断），原始 URL 不进日志。
    deps.logger.warn("[second-instance] deep link 未处理:", renderSafeUrlForLog(url));
  }

  const openWorkspacePath =
    extractOpenWorkspacePathFromSingleInstanceData(deps.additionalData) ??
    extractOpenWorkspacePathFromArgs(deps.argv);
  if (openWorkspacePath && deps.forceUpdateBlocked) {
    deps.logger.warn("[force-update] 已忽略强制升级期间的 second-instance workspace 请求");
    deps.focusForceUpdateGateWindow();
    return true;
  }
  if (openWorkspacePath) {
    // §4c/§4d：外部路径先过形状与 UNC hop 安检，任何 statSync/SMB 触网之前拒绝。
    const inspection = inspectDeepLinkWorkspacePath(openWorkspacePath);
    if (!inspection.ok) {
      deps.logger.warn(
        `[second-instance] workspace 路径安检拒绝（${inspection.reason}），已忽略`,
        { path: openWorkspacePath },
      );
      return false;
    }
  }
  return Boolean(
    openWorkspacePath &&
    deps.handleOpenWorkspacePath(openWorkspacePath, {
      resolveApplicationWindow: deps.resolveApplicationWindow,
    }),
  );
}
