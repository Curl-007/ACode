import type { IACodeAgentService } from "@acode/services";
import {
  HostResponseTypes,
  type HostOvernightCompletionNotifyResponse,
} from "@acode/shared";

interface CreateHostOvernightCompletionForwarderOptions {
  getAgentService: () =>
    | Pick<IACodeAgentService, "onDynamicOvernightCompletion">
    | undefined;
  postMessage: (message: HostOvernightCompletionNotifyResponse) => void;
  logger: { warn: (message: string, detail?: unknown) => void };
}

export interface HostOvernightCompletionForwarder {
  /**
   * 订阅 agent 的 overnight 完成事件并镜像给 main。返回退订函数（host dispose / 服务换代时调用）。
   */
  startForwarding(): () => void;
}

/**
 * Overnight（K3）完成信号的 Host 侧转发器（specs/overnight-completion-notify.md §7 的 agent→host→main 一跳）。
 *
 * 与 hostNetworkCapture 的转发段同款职责、同款纪律：把 agent 子进程经 v4 通知上报的
 * `onDynamicOvernightCompletion` 事件**原样镜像**成 `HostResponseTypes.OvernightCompletionNotify`
 * 交给 main。信号不落 host、不缓存、不去重、不改写——host 只是转发载体；幂等（一 run 一通知）
 * 与焦点闸等裁决全部在 main 侧 overnightCompletionNotify（消费端唯一裁决者），host 不持有第二份状态。
 *
 * agent 服务不可用（远程 attach 未就绪/已断开）或旧 CLI 不发该 v4 通知时：静默不转发，
 * 不重试、不排队——完成事实的权威仍在 CLI supervisor，桌面通知缺席只是降级，不影响 run 本身。
 */
export function createHostOvernightCompletionForwarder(
  options: CreateHostOvernightCompletionForwarderOptions,
): HostOvernightCompletionForwarder {
  return {
    startForwarding() {
      const agentService = options.getAgentService();
      if (!agentService) return () => {};
      try {
        // Event<T> = (listener) => IDisposable（@acode/rpc 约定，同 hostNetworkCapture）。
        const disposable = agentService.onDynamicOvernightCompletion()((signal) => {
          options.postMessage({
            type: HostResponseTypes.OvernightCompletionNotify,
            runId: signal.runId,
            parentTaskId: signal.parentTaskId,
            outcome: signal.outcome,
            morningReportReady: signal.morningReportReady,
          });
        });
        return () => disposable.dispose();
      } catch (error) {
        options.logger.warn("[host-overnight-completion] subscribe failed", {
          message: error instanceof Error ? error.message : String(error),
        });
        return () => {};
      }
    },
  };
}
