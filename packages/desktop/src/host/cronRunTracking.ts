import type { AutomationRepo } from "@acode/services/node";
import type { IACodeTaskService } from "@acode/services";
import {
  appendAutomationNoticeTail,
  parseAutomationNotice,
  type ACodeAutomationRunOutcome,
  type ACodeTaskMode,
  type ModelSelection,
  type TraceId,
} from "@acode/shared";
import {
  recordCronRunOutcomeBestEffort,
  startManualClaimHeartbeat,
  settleCronRunTerminalOutcome,
} from "./cronRunLifecycle.js";
import type { AutomationDispatchLogger } from "./automationDispatchContext.js";

/**
 * cron/manual run 的台账与订阅追踪（自 host/index.ts 抽出，2026-10-05 领域拆分）。
 * 订阅 Map 与 automation repo 由工厂闭包持有：run 终态解析、心跳与未读决策
 * 共享同一份状态，不允许第二处再建订阅表。
 */

export function cronRunSubscriptionKey(taskId: string, traceId: TraceId): string {
  return `${taskId}\u0000${traceId}`;
}

export function parseCronRunScheduledAt(runId: string, automationId: string): number | null {
  const prefix = `${automationId}:`;
  if (!runId.startsWith(prefix)) return null;
  const value = Number(runId.slice(prefix.length).split(":")[0]);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

export function createCronRunTracking(deps: {
  repo: AutomationRepo;
  logger: AutomationDispatchLogger;
}): {
  markRunOutcome: (params: {
    runId: string;
    automationId: string;
    workspaceKey: string;
    scheduledAt: number | null;
    trigger: "schedule" | "manual";
    outcome: ACodeAutomationRunOutcome;
    error?: string;
  }) => void;
  disposeSubscription: (key: string) => void;
  disposeAllSubscriptions: () => void;
  applyRunConfigToExistingTask: (params: {
    acodeTaskService: IACodeTaskService;
    taskId: string;
    traceId: TraceId;
    modelSelection?: ModelSelection;
    mode?: string;
  }) => Promise<void>;
  trackRunOutcome: (params: {
    acodeTaskService: IACodeTaskService;
    taskId: string;
    traceId: TraceId;
    workspacePath: string;
    workspaceIdentity?: string;
    runId: string;
    automationId: string;
    workspaceKey: string;
    scheduledAt: number | null;
    trigger: "schedule" | "manual";
  }) => void;
} {
  const { repo, logger } = deps;
  const subscriptions = new Map<string, { dispose(): void }>();

  function markRunOutcome(params: {
    runId: string;
    automationId: string;
    workspaceKey: string;
    scheduledAt: number | null;
    trigger: "schedule" | "manual";
    outcome: ACodeAutomationRunOutcome;
    error?: string;
  }): void {
    void recordCronRunOutcomeBestEffort({
      ...params,
      repo,
      logWarn: (message, error) => logger.warn(message, error),
    });
  }

  function disposeSubscription(key: string): void {
    const disposable = subscriptions.get(key);
    if (!disposable) return;
    subscriptions.delete(key);
    disposable.dispose();
  }

  async function applyRunConfigToExistingTask(params: {
    acodeTaskService: IACodeTaskService;
    taskId: string;
    traceId: TraceId;
    modelSelection?: ModelSelection;
    mode?: string;
  }): Promise<void> {
    let thoughtAppliedWithModel = false;
    let modeAppliedWithModel = false;
    if (params.modelSelection) {
      await params.acodeTaskService.setAutomationSessionConfig({
        taskId: params.taskId,
        traceId: params.traceId,
        modelSelection: params.modelSelection,
        thoughtLevel: params.modelSelection.options?.reasoningLevel,
        mode: params.mode?.trim() as ACodeTaskMode | undefined,
      });
      thoughtAppliedWithModel = true;
      modeAppliedWithModel = true;
    }
    if (!modeAppliedWithModel && params.mode?.trim()) {
      await params.acodeTaskService.setConfigOption({
        taskId: params.taskId,
        traceId: params.traceId,
        configId: "mode",
        value: params.mode.trim(),
      });
    }
    if (!thoughtAppliedWithModel && params.modelSelection?.options?.reasoningLevel) {
      await params.acodeTaskService.setConfigOption({
        taskId: params.taskId,
        traceId: params.traceId,
        configId: "thought_level",
        value: params.modelSelection.options.reasoningLevel,
      });
    }
  }

  function trackRunOutcome(params: {
    acodeTaskService: IACodeTaskService;
    taskId: string;
    traceId: TraceId;
    workspacePath: string;
    workspaceIdentity?: string;
    runId: string;
    automationId: string;
    workspaceKey: string;
    scheduledAt: number | null;
    trigger: "schedule" | "manual";
  }): void {
    const key = cronRunSubscriptionKey(params.taskId, params.traceId);
    disposeSubscription(key);
    markRunOutcome({ ...params, outcome: "running" });
    // heartbeat 协议 R2：订阅窗内累积本 run 主 agent 正文尾部（派发 prompt 的 traceId=runId，
    // adapter 已把事件 inputId 对齐到本轮 inputId），终态解析通知决策；滚动尾部有界。
    let automationNoticeTail = "";
    const streamSubscription = params.acodeTaskService.onDynamicStreamEvent(params.taskId)(
      (event) => {
        if (
          event.type !== "agent_message_chunk" ||
          event.parentToolUseId ||
          event.inputId !== params.traceId
        ) {
          return;
        }
        automationNoticeTail = appendAutomationNoticeTail(automationNoticeTail, event.content);
      },
    );
    const disposable = params.acodeTaskService.onDynamicTaskTerminalOutcome(params.taskId)(
      (result) => {
        if (result.inputId !== params.traceId) return;
        const notifyDecision = parseAutomationNotice(automationNoticeTail);
        void settleCronRunTerminalOutcome({
          ...params,
          outcome: result.outcome,
          error: result.error,
          notifyDecision,
          repo,
          logWarn: (message, error) => logger.warn(message, error),
        });
        // heartbeat 协议 R1：默认安静——触发完成本身不再是未读理由。仅 NOTIFY 决策或
        // 失败终态标未读（打开 task 时仍由导航链路 compare-and-clear 清除）。
        // absent 记 warn：模型没有按注入协议输出决策，按安静处理防刷屏回潮。
        if (notifyDecision === "notify" || result.outcome === "failed") {
          void params.acodeTaskService.setTaskUnread({
            taskId: params.taskId,
            workspacePath: params.workspacePath,
            ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
            unread: true,
          });
        } else if (notifyDecision === "absent") {
          logger.warn(
            `automation 通知决策缺失，按默认安静处理 automation=${params.automationId} runId=${params.runId}`,
          );
        }
        streamSubscription.dispose();
        disposeSubscription(key);
      },
    );
    const claimHeartbeat =
      params.trigger === "manual"
        ? startManualClaimHeartbeat({
            ...params,
            repo,
            logWarn: (message, error) => logger.warn(message, error),
          })
        : null;
    subscriptions.set(key, {
      dispose() {
        claimHeartbeat?.dispose();
        streamSubscription.dispose();
        disposable.dispose();
      },
    });
  }

  return {
    markRunOutcome,
    disposeSubscription,
    disposeAllSubscriptions() {
      for (const key of Array.from(subscriptions.keys())) {
        disposeSubscription(key);
      }
    },
    applyRunConfigToExistingTask,
    trackRunOutcome,
  };
}
