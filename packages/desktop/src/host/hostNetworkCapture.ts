import type { IACodeAgentService } from "@acode/services";
import {
  HostResponseTypes,
  type HostNetworkCaptureRecordsResponse,
  type HostNetworkCaptureSetEnabledRequestMessage,
  type HostNetworkCaptureSetEnabledResultResponse,
} from "@acode/shared";

interface CreateHostNetworkCaptureForwarderOptions {
  getAgentService: () =>
    | Pick<IACodeAgentService, "networkCaptureSetEnabledV4" | "onDynamicNetworkCaptureRecords">
    | undefined;
  /** 本 host 的 workspace 目标（InitLocal 携带）；路由 v4 命令到名下 agent runtime 用。 */
  getWorkspaceTarget: () =>
    | { workspacePath: string; workspaceIdentity?: string; remoteSessionId?: string }
    | null;
  postMessage: (
    message: HostNetworkCaptureRecordsResponse | HostNetworkCaptureSetEnabledResultResponse,
  ) => void;
  logger: { warn: (message: string, detail?: unknown) => void };
}

export interface HostNetworkCaptureForwarder {
  /** 处理 main 的开关请求：转成 v4 命令发给 agent runtime，按 requestId 回结算。 */
  handleSetEnabled(message: HostNetworkCaptureSetEnabledRequestMessage): Promise<void>;
  /** 订阅 agent 的批量观测并镜像给 main。返回退订函数（host dispose 时调用）。 */
  startForwarding(): () => void;
}

/**
 * 网络抓包的 Host 侧转发器（specs/runtime-network-capture.md 的 main↔host 一跳）。
 *
 * 职责刻意只有两条：把 main 的开关请求转成 `networkCaptureSetEnabledV4`；把 agent 的
 * `onDynamicNetworkCaptureRecords` 批量镜像给 main。观测数据不落 host、不缓存、不去
 * 重——main 的资源管理器是唯一消费者，窗口没开时 main 侧丢弃即可（那边已有该语义）。
 *
 * agent 服务不可用（远程 attach 未就绪/已断开）或旧 CLI 不支持该 v4 方法时：开关回
 * `ok:false` 并带 reason，观测静默不转发——不重试、不排队（开关状态由 main 记忆，
 * agent 进程 ready 后 main 会按记忆重发，见 desktopNetworkCaptureIpc.ts）。
 */
export function createHostNetworkCaptureForwarder(
  options: CreateHostNetworkCaptureForwarderOptions,
): HostNetworkCaptureForwarder {
  return {
    async handleSetEnabled(message) {
      const agentService = options.getAgentService();
      const reply = (ok: boolean, reason?: string) => {
        options.postMessage({
          type: HostResponseTypes.NetworkCaptureSetEnabledResult,
          requestId: message.requestId,
          ok,
          ...(reason === undefined ? {} : { error: reason.slice(0, 512) }),
        });
      };
      if (!agentService) {
        reply(false, "agent service unavailable");
        return;
      }
      const workspaceTarget = options.getWorkspaceTarget();
      if (!workspaceTarget) {
        // host 尚未 InitLocal（无 workspace 可路由）：诚实失败，main 的记忆会随 agent ready 重发。
        reply(false, "workspace unavailable");
        return;
      }
      try {
        const result = await agentService.networkCaptureSetEnabledV4({
          ...workspaceTarget,
          enabled: message.enabled,
          ...(message.captureId === null ? {} : { captureId: message.captureId }),
        });
        reply(result.ok, result.ok ? undefined : result.reason);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        options.logger.warn("[host-network-capture] set enabled failed", { message: detail });
        reply(false, detail);
      }
    },
    startForwarding() {
      const agentService = options.getAgentService();
      if (!agentService) return () => {};
      try {
        // Event<T> = (listener) => IDisposable（@acode/rpc 约定）。
        const disposable = agentService.onDynamicNetworkCaptureRecords()((notification) => {
          options.postMessage({
            type: HostResponseTypes.NetworkCaptureRecords,
            captureId: notification.captureId,
            records: notification.records,
          });
        });
        return () => disposable.dispose();
      } catch (error) {
        options.logger.warn("[host-network-capture] subscribe failed", {
          message: error instanceof Error ? error.message : String(error),
        });
        return () => {};
      }
    },
  };
}
