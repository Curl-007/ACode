import type { BrowserWindow } from "electron";
import {
  type ExternalWorkspaceOpenDialogCopy,
  confirmExternalWorkspaceOpen,
  isValidLocalWorkspaceDirectory,
} from "./desktopOAuthDeepLink.js";
import { inspectDeepLinkWorkspacePath } from "./deepLinkHardening.js";
import {
  createOpenWorkspaceStartupBootstrap,
  type StartupWindowBootstrap,
} from "./startupWorkspace.js";

export type ExplicitStartupWorkspaceSource = "open-workspace-arg" | "deep-link";

export interface ExplicitStartupWorkspaceRequest {
  path: string;
  source: ExplicitStartupWorkspaceSource;
}

interface StartupDeepLinkConsumptionGate {
  markStartupRequestConsumed: (request: ExplicitStartupWorkspaceRequest) => void;
  /**
   * 返回 true 即代表 protocolUrl 非空且未被冷启动消费过；声明为类型谓词让调用方
   * （index.ts 的 whenReady deep link 重放）在 if 分支内直接拿到 string，无需重复判空。
   */
  shouldHandleReadyProtocolUrl: (protocolUrl: string | null) => protocolUrl is string;
}

interface ResolveExplicitStartupWorkspaceBootstrapDeps {
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
  };
  confirmationCopy?: ExternalWorkspaceOpenDialogCopy;
  parentWindow?: BrowserWindow | null;
}

export function createStartupDeepLinkConsumptionGate(
  startupProtocolUrl: string | null,
): StartupDeepLinkConsumptionGate {
  let startupDeepLinkConsumed = false;

  return {
    markStartupRequestConsumed: (request) => {
      if (request.source !== "deep-link") {
        return;
      }

      // 冷启动 argv deep link 在 startup bootstrap 中无论确认、取消或校验失败，
      // 都必须形成一次性消费，避免 app.whenReady 再从 process.argv 重放同一个外部 URL。
      startupDeepLinkConsumed = true;
    },
    shouldHandleReadyProtocolUrl: (protocolUrl): protocolUrl is string => {
      if (!protocolUrl) {
        return false;
      }

      return !(startupDeepLinkConsumed && protocolUrl === startupProtocolUrl);
    },
  };
}

export function resolveExplicitStartupWorkspaceBootstrap(
  request: ExplicitStartupWorkspaceRequest,
  deps: ResolveExplicitStartupWorkspaceBootstrapDeps,
): StartupWindowBootstrap | null {
  if (request.source === "deep-link") {
    // 冷启动 deep link 不能绕过运行中 deep link 的路径安检；升级为与 open-url /
    // second-instance 同一条 UNC hop 断言（specs/desktop-startup-hardening.md §4d）：
    // 除 UNC/设备/盘符相对形状外，还拒绝符号链接指向 UNC 的 hop（防 SMB NTLM
    // 外泄），且全部判定在任何 statSync 等 filesystem probe 之前完成。
    const inspection = inspectDeepLinkWorkspacePath(request.path);
    if (!inspection.ok) {
      deps.logger.warn("[deep-link] 冷启动路径安检已拒绝", {
        path: request.path,
        reason: inspection.reason,
      });
      return null;
    }

    // 首窗 bootstrap 发生在 renderer ready 前，不能走后续 IPC gate；
    // deep link 来源仍必须先让用户确认，取消后回退默认启动。
    if (
      !confirmExternalWorkspaceOpen(
        request.path,
        deps.logger,
        deps.parentWindow ?? null,
        deps.confirmationCopy,
      )
    ) {
      return null;
    }
  }

  if (!isValidLocalWorkspaceDirectory(request.path)) {
    deps.logger.warn("[startup-workspace] open-workspace argv invalid, falling back", {
      path: request.path,
    });
    return null;
  }

  deps.logger.info("[startup-workspace] using explicit open workspace:", request.path);
  return createOpenWorkspaceStartupBootstrap(request.path);
}
