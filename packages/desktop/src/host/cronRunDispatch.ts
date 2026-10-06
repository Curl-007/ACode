import {
  AUTOMATION_NOTICE_INSTRUCTION,
  isRemoteWorkspaceIdentity,
  resolveWorkspaceKey,
  formatModelPickerValue,
  type ACodeAutomation,
  type ACodeAutomationRun,
  type ACodeTaskMode,
  type ModelSelection,
  type TraceId,
} from "@acode/shared";
import { IBotsService, IModelSelectionService, IACodeTaskService, type ServiceCollection } from "@acode/services";
import { AutomationRepo } from "@acode/services/node";
import { watchCronRunBotDelivery } from "./cronBotDelivery.js";
import { settleManualDispatchFailureBestEffort } from "./cronRunLifecycle.js";
import { resolveAutomationSubmissionModelSelection } from "./automationModelSelection.js";
import {
  createCronRunTracking,
  cronRunSubscriptionKey,
  parseCronRunScheduledAt,
} from "./cronRunTracking.js";
import type { HostAutomationDispatchContext } from "./automationDispatchContext.js";

/**
 * cron/manual automation 派发（自 host/index.ts 抽出，2026-10-05 领域拆分第一批）。
 * 台账/订阅追踪在 cronRunTracking.ts；本模块持有 AutomationRepo 与目标 services 解析，
 * 把一次 run 直接提交给目标 host 的 V4 task service。
 */

export interface CronRunDispatchRequest {
  automationId: string;
  runId: string;
  prompt: string;
  targetTaskId?: string;
  modelSelection?: ModelSelection;
  mode?: ACodeTaskMode;
  workspacePath: string;
  workspaceIdentity?: string;
}

export function createHostCronRunDispatch(ctx: HostAutomationDispatchContext): {
  dispatchCronRun: (request: CronRunDispatchRequest) => Promise<{ taskId: string; sessionId: string }>;
  dispatchManualAutomationRun: (params: {
    automation: ACodeAutomation;
    run: ACodeAutomationRun;
  }) => Promise<void>;
  disposeRunSubscriptions: () => void;
  closeRepository: () => void;
} {
  const { logger } = ctx;
  const cronAutomationRepo = new AutomationRepo();
  const tracking = createCronRunTracking({ repo: cronAutomationRepo, logger });

  function resolveAutomationTargetServices(request: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): ServiceCollection {
    const remoteSession = ctx.getRemoteConnectionRegistry().findSessionForWorkspace(request);
    if (remoteSession) {
      if (!remoteSession.workspaceIdentity) {
        throw new Error("Automation 目标 Remote Host 缺少 workspaceIdentity");
      }
      return ctx.getRemoteConnectionRegistry().resolveScopedServices({
        kind: "remote",
        remoteSessionId: remoteSession.remoteSessionId,
        workspacePath: request.workspacePath,
        workspaceIdentity: remoteSession.workspaceIdentity,
      });
    }
    // 远程 Automation 找不到目标 logical session 时，旧派发会静默落到 Local Host，
    // 从而使用本地模型首选与 Registry。远程身份只能失败，不能跨 Environment fallback。
    if (request.workspaceIdentity && isRemoteWorkspaceIdentity(request.workspaceIdentity)) {
      throw new Error("Automation 目标 Remote Host 当前不可用");
    }
    const activeServices = ctx.getActiveServices();
    if (!activeServices) {
      throw new Error("Local Host services are not initialized.");
    }
    return activeServices;
  }

  /**
   * 把一次 cron/manual run 直接提交给当前 host 的 V4 task service。
   * 会话内 automation 可能绑定到未激活 session，必须先恢复再应用保存的运行参数。
   */
  async function dispatchCronRun(request: CronRunDispatchRequest): Promise<{
    taskId: string;
    sessionId: string;
  }> {
    const targetServices = resolveAutomationTargetServices(request);
    const acodeTaskService = targetServices.getOptional(IACodeTaskService);
    if (!acodeTaskService) {
      throw new Error("ACode task service is not initialized.");
    }
    const modelSelectionService = targetServices.getOptional(IModelSelectionService);
    if (!modelSelectionService) {
      throw new Error("目标 Host Model Selection service is not initialized.");
    }
    // 长期配置是原意图；首次派发在目标 Host 解析后固定。已有 run 必须直接复用，
    // 不能因账号变化或本次 Registry 读取失败重新解释历史执行选择。
    const existingRun = await cronAutomationRepo.getRun(request.runId);
    const resolvedSubmissionModelSelection = await resolveAutomationSubmissionModelSelection({
      selection: request.modelSelection,
      fixedSelection: existingRun?.modelSelection,
      modelSelectionService,
      // Repo 已在读取前完成离线导入；不再为迁移绕行 Agent/账号服务。
      // 未迁入或损坏的新值仍由此入口明确拒绝，不能当成跟随 Workspace。
      readSelection: () =>
        cronAutomationRepo.getModelSelectionForDispatch(
          request.automationId,
          resolveWorkspaceKey(request),
        ),
    });
    const submissionModelSelection = await cronAutomationRepo.fixRunModelSelection(
      request.runId,
      resolvedSubmissionModelSelection,
    );
    let trackedKey: string | null = null;
    const workspaceKey = resolveWorkspaceKey(request);
    const trigger = request.runId.includes(":manual:") ? "manual" : "schedule";
    const scheduledAt = parseCronRunScheduledAt(request.runId, request.automationId);
    try {
      const task = request.targetTaskId
        ? { taskId: request.targetTaskId }
        : await acodeTaskService.createTask({
            workspacePath: request.workspacePath,
            workspaceIdentity: request.workspaceIdentity,
            model: formatModelPickerValue(submissionModelSelection),
            mode: request.mode,
            thoughtLevel: submissionModelSelection.options?.reasoningLevel,
            automationId: request.automationId,
          });
      // 未绑定会话时不能沿用 createTask 的 session trace 作为首条 prompt trace：
      // CLI 无法从 inputId 还原 manual/schedule admission。
      // 建会话 trace 与执行 runId 是两种身份；两条派发路径的 prompt 都必须统一使用 runId。
      const promptTraceId = request.runId as TraceId;
      if (request.targetTaskId) {
        // 绑定会话在 app 重启或切换 workspace 后通常不处于 active；旧实现直接
        // setConfig/sendPrompt 会立即报 Session is not active，看起来像「立即运行」没有触发。
        await acodeTaskService.resumeTask({
          taskId: task.taskId,
          workspacePath: request.workspacePath,
          workspaceIdentity: request.workspaceIdentity,
          model: formatModelPickerValue(submissionModelSelection),
          thoughtLevel: submissionModelSelection.options?.reasoningLevel,
          automationId: request.automationId,
        });
        await tracking.applyRunConfigToExistingTask({
          acodeTaskService,
          taskId: task.taskId,
          traceId: promptTraceId,
          modelSelection: submissionModelSelection,
          mode: request.mode,
        });
      }
      const botsService = targetServices.getOptional(IBotsService);
      if (botsService) {
        try {
          await watchCronRunBotDelivery({
            automationId: request.automationId,
            workspaceKey,
            workspacePath: request.workspacePath,
            ...(request.workspaceIdentity ? { workspaceIdentity: request.workspaceIdentity } : {}),
            taskId: task.taskId,
            runId: request.runId,
            repo: cronAutomationRepo,
            botsService,
          });
        } catch (error) {
          // Bot 回推是 best-effort 辅助通道；配置/凭据/订阅失败不能阻断 automation 派发与结算。
          logger.warn(
            `automation Bot delivery subscription failed automation=${request.automationId} provider=unknown`,
            error,
          );
        }
      }
      trackedKey = cronRunSubscriptionKey(task.taskId, promptTraceId);
      tracking.trackRunOutcome({
        acodeTaskService,
        taskId: task.taskId,
        traceId: promptTraceId,
        workspacePath: request.workspacePath,
        workspaceIdentity: request.workspaceIdentity,
        runId: request.runId,
        automationId: request.automationId,
        workspaceKey,
        scheduledAt,
        trigger,
      });
      await acodeTaskService.sendPrompt({
        taskId: task.taskId,
        traceId: promptTraceId,
        // heartbeat 协议 R2 注入点（Q3 裁决：后缀拼接）——作者 prompt 原文在前、语义不改写；
        // 指令段是 host 常量（@acode/shared automation-notice），不是可被作者覆写的第二指令源。
        content: request.prompt + AUTOMATION_NOTICE_INSTRUCTION,
        clientMode: "desktop-continuous",
        automationId: request.automationId,
      });
      // 2026-10-05 清理：sendPrompt 之后原有 session_create 计数逻辑（「prompt 创建的
      // 定时任务带 targetTaskId，追加原会话不能计成 session_create」），随对话分享功能
      // 删净时只删了计数体、留下空 if 壳——死代码回归痕迹，抽取时一并移除。
      return { taskId: task.taskId, sessionId: task.taskId };
    } catch (error) {
      if (trackedKey) tracking.disposeSubscription(trackedKey);
      tracking.markRunOutcome({
        runId: request.runId,
        automationId: request.automationId,
        workspaceKey,
        scheduledAt,
        trigger,
        outcome: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async function dispatchManualAutomationRun(params: {
    automation: ACodeAutomation;
    run: ACodeAutomationRun;
  }): Promise<void> {
    logger.info(
      `direct manual automation dispatch started automation=${params.automation.automationId} runId=${params.run.runId}`,
    );
    let result: Awaited<ReturnType<typeof dispatchCronRun>>;
    try {
      result = await dispatchCronRun({
        automationId: params.automation.automationId,
        runId: params.run.runId,
        prompt: params.automation.prompt,
        targetTaskId: params.automation.targetTaskId,
        modelSelection: params.run.modelSelection ?? params.automation.modelSelection,
        mode: params.automation.mode,
        workspacePath: params.automation.workspacePath,
        workspaceIdentity: params.automation.workspaceIdentity,
      });
    } catch (error) {
      logger.warn(
        `direct manual automation dispatch failed automation=${params.automation.automationId} runId=${params.run.runId}:`,
        error,
      );
      await settleManualDispatchFailureBestEffort({
        repo: cronAutomationRepo,
        automationId: params.automation.automationId,
        runId: params.run.runId,
        workspaceKey: params.automation.workspaceKey,
        scheduledAt: params.run.scheduledAt ?? null,
        trigger: "manual",
        dispatchError: error,
        logWarn: (message, releaseError) => logger.warn(message, releaseError),
      });
      throw error;
    }

    try {
      await cronAutomationRepo.markManualRunDispatched({
        runId: params.run.runId,
        sessionId: result.sessionId,
        dispatchedAt: Date.now(),
      });
    } catch (error) {
      // prompt 已经 accepted/queued，台账和累计次数回写失败不能伪装成派发失败并提前释放锁；
      // 真实终态仍由 trackRunOutcome 收口，避免同一 automation 重复排队。
      logger.warn(
        `回写 manual automation dispatched 状态与运行次数失败 automation=${params.automation.automationId} runId=${params.run.runId}`,
        error,
      );
    }
    // sendPrompt ACK 可能只表示进入 busy queue；manual claim 必须保留到对应 turn 终态。
    logger.info(
      `direct manual automation dispatch accepted automation=${params.automation.automationId} runId=${params.run.runId} taskId=${result.taskId}`,
    );
  }

  return {
    dispatchCronRun,
    dispatchManualAutomationRun,
    disposeRunSubscriptions: tracking.disposeAllSubscriptions,
    closeRepository() {
      cronAutomationRepo.close();
    },
  };
}
