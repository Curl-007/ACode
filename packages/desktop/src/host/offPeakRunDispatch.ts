import { randomUUID } from "node:crypto";
import { IACodeTaskService, IOffPeakTaskService } from "@acode/services";
import {
  getOffPeakRequestAuthBuilder,
  OffPeakTaskRepo,
  OffPeakTaskService,
  buildTaskChangeSummary,
  OffPeakModelUnavailableError,
  type OffPeakRequestAuthBuilder,
} from "@acode/services/node";
import {
  isOffPeakTicketExpiredError,
  type ACodeAutomationRunOutcome,
  type ACodeTaskMode,
  type ModelSelection,
  type TraceId,
} from "@acode/shared";
import {
  assertBoundSessionDispatchable,
  resolveOffPeakDispatchKind,
} from "./offPeakDispatchPlan.js";
import type { HostAutomationDispatchContext } from "./automationDispatchContext.js";

/**
 * 闲时任务（off-peak）派发（自 host/index.ts 抽出，2026-10-05 领域拆分第一批）：
 * 与 cron 并行的独立链路（表/消息/常量互不复用）。运行时装配（server client +
 * 进程内 mock 网关 + 编排服务）为 host 域属主。
 * ⚠ 多窗口=多 host 会各自跑一份 sync 轮询（批量接口幂等、写入同库同数据，重复仅多耗请求）；
 * mock 网关用固定端口单实例共享票据状态。若多窗口轮询放大成本，再加跨 host 选主。
 */

/**
 * 续跑提示词（"实现时定"的落地）：3h 时间盒到期 / app 重启恢复后 resume 同一
 * session 续发。不重发原始 prompt（会让模型从头再做一遍），而是指示接续未完成的工作。
 */
const OFF_PEAK_RESUME_PROMPT =
  "Continue the previous task from where it left off. The run was interrupted " +
  "(app restart or execution window expired). Do not start over; review what has " +
  "already been done and complete the remaining work.";

interface OffPeakRuntime {
  service: OffPeakTaskService;
  /** 派发时按本段票据构造逐请求鉴权；静态模型事实由 CLI Built-in Config 提供。 */
  buildRequestAuth: OffPeakRequestAuthBuilder;
  validateSelection: (selection: {
    providerId: string;
    modelId: string;
    options?: { reasoningLevel?: string };
  }) => Promise<boolean>;
}

export interface OffPeakRunDispatchRequest {
  offPeakTaskId: string;
  prompt: string;
  permissionMode: string;
  modelSelection: ModelSelection;
  conversationId?: string;
  sessionId?: string;
  serverTicketId?: string;
  workspacePath: string;
  workspaceIdentity?: string;
}

export function createHostOffPeakRunDispatch(ctx: HostAutomationDispatchContext): {
  dispatchOffPeakRun: (
    request: OffPeakRunDispatchRequest,
  ) => Promise<{ conversationId: string; sessionId: string }>;
  disposeRunSubscriptions: () => void;
  disposeRuntime: () => void;
  closeRepository: () => void;
} {
  const { logger } = ctx;
  const offPeakTaskRepo = new OffPeakTaskRepo();
  const offPeakRunSubscriptions = new Map<string, { dispose(): void }>();
  let offPeakRuntime: OffPeakRuntime | null = null;

  async function ensureOffPeakRuntime(): Promise<OffPeakRuntime | null> {
    if (offPeakRuntime) return offPeakRuntime;
    const services = ctx.getActiveServices();
    if (!services) return null;
    const service = services.getOptional(IOffPeakTaskService);
    const buildRequestAuth = getOffPeakRequestAuthBuilder(services);
    if (!service || !buildRequestAuth) {
      logger.warn("off-peak runtime unavailable: missing host services");
      return null;
    }
    offPeakRuntime = {
      service: service as OffPeakTaskService,
      buildRequestAuth,
      validateSelection: (selection) =>
        (service as OffPeakTaskService).validateDispatchModelSelection(selection),
    };
    logger.info("off-peak runtime ready (service from local collection)");
    return offPeakRuntime;
  }

  function disposeOffPeakRuntime(): void {
    if (!offPeakRuntime) return;
    offPeakRuntime = null;
  }

  function offPeakRunSubscriptionKey(taskId: string, traceId: TraceId): string {
    return `${taskId}\u0000${traceId}`;
  }

  function disposeOffPeakRunSubscription(key: string): void {
    const disposable = offPeakRunSubscriptions.get(key);
    if (!disposable) return;
    offPeakRunSubscriptions.delete(key);
    disposable.dispose();
  }

  /** 终态回填 files_changed：复用现有 task diff 汇总（工具写盘型统计，Bash 改动不计入，接受）。 */
  async function resolveOffPeakFilesChanged(params: {
    acodeTaskService: IACodeTaskService;
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<number | undefined> {
    try {
      const snapshot = await params.acodeTaskService.getTaskSnapshot({
        taskId: params.taskId,
        workspacePath: params.workspacePath,
        ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
      });
      const fileChanges = snapshot?.fileChanges;
      if (!fileChanges) return undefined;
      // 汇总为空（无文件改动）按 0 计——"改了 0 个文件"对完成通知是真实信息。
      return buildTaskChangeSummary(fileChanges)?.fileCount ?? 0;
    } catch (error) {
      logger.warn("off-peak files_changed 汇总失败（不阻塞终态落库）:", error);
      return undefined;
    }
  }

  /** loop 终态 → off_peak_tasks 终态：succeeded→completed、stopped→cancelled（用户手动停止）、其余→failed。 */
  async function finalizeOffPeakRun(params: {
    acodeTaskService: IACodeTaskService;
    offPeakTaskId: string;
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    outcome: ACodeAutomationRunOutcome;
    error?: string;
  }): Promise<void> {
    // 自动续跑：票据过期（active 3h 到期 / ready 废票）不是失败——
    // 同 task_id 重取号回 queued，等下一个 ready 再 resume 同 session 续跑。
    if (params.outcome === "failed" && isOffPeakTicketExpiredError(params.error)) {
      const runtime = await ensureOffPeakRuntime();
      if (runtime) {
        await runtime.service.handleTicketExpiredDuringRun(params.offPeakTaskId);
        logger.info(
          `off-peak segment expired, requeued for continuation task=${params.offPeakTaskId}`,
        );
        return;
      }
      // 运行时不可用（服务缺失）时按普通失败落库，避免任务卡在 running。
    }
    const status =
      params.outcome === "succeeded"
        ? ("completed" as const)
        : params.outcome === "stopped"
          ? ("cancelled" as const)
          : ("failed" as const);
    const filesChanged = await resolveOffPeakFilesChanged(params);
    const updated = await offPeakTaskRepo.markTerminal(params.offPeakTaskId, {
      status,
      endedAt: Date.now(),
      ...(params.error ? { failureReason: params.error } : {}),
      ...(filesChanged !== undefined ? { filesChanged } : {}),
    });
    if (!updated) {
      // 终态不可逆出：任务已被用户先一步取消/删除等，丢弃迟到回写（幂等兜底）。
      logger.info(
        `off-peak terminal writeback dropped (already terminal) task=${params.offPeakTaskId}`,
      );
      return;
    }
    logger.info(
      `off-peak run finished task=${params.offPeakTaskId} status=${status} filesChanged=${filesChanged ?? "n/a"}`,
    );
    // 后台完成统一置未读，打开 task 时由导航链路清除（与 cron 同款）。
    void params.acodeTaskService.setTaskUnread({
      taskId: params.taskId,
      workspacePath: params.workspacePath,
      ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
      unread: true,
    });
  }

  function trackOffPeakRunOutcome(params: {
    acodeTaskService: IACodeTaskService;
    offPeakTaskId: string;
    taskId: string;
    traceId: TraceId;
    workspacePath: string;
    workspaceIdentity?: string;
  }): void {
    const key = offPeakRunSubscriptionKey(params.taskId, params.traceId);
    disposeOffPeakRunSubscription(key);
    const disposable = params.acodeTaskService.onDynamicTaskTerminalOutcome(params.taskId)(
      (result) => {
        if (result.inputId !== params.traceId) return;
        disposeOffPeakRunSubscription(key);
        void finalizeOffPeakRun({
          acodeTaskService: params.acodeTaskService,
          offPeakTaskId: params.offPeakTaskId,
          taskId: params.taskId,
          workspacePath: params.workspacePath,
          ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
          outcome: result.outcome,
          ...(result.error ? { error: result.error } : {}),
        }).catch((error) => logger.warn("off-peak 终态回写失败:", error));
      },
    );
    offPeakRunSubscriptions.set(key, disposable);
  }

  /**
   * 把一次闲时任务派发提交给当前 host 的 V4 task service。
   * 首跑（无 conversationId）createTask 新建专属 session；续跑/中断恢复 resume
   * 同一会话并以续跑提示词继续。闲时完整 Selection/鉴权仅注入本次执行。
   */
  async function dispatchOffPeakRun(request: OffPeakRunDispatchRequest): Promise<{
    conversationId: string;
    sessionId: string;
  }> {
    const acodeTaskService = ctx.getActiveServices()?.getOptional(IACodeTaskService);
    if (!acodeTaskService) {
      throw new Error("ACode task service is not initialized.");
    }
    const runtime = await ensureOffPeakRuntime();
    if (!runtime) {
      throw new Error("off-peak runtime is not available");
    }
    if (!request.serverTicketId) {
      // schedulable 必然已取号；无票派发说明快照失序，按 transient 回执等下轮（轮询会补票）。
      throw new Error("off-peak dispatch without server ticket");
    }
    // idle plan 使用普通 Selection；单次执行约束保证它不写入 Session Selection。
    const idleSelection = request.modelSelection;
    if (!(await runtime.validateSelection(idleSelection))) {
      throw new OffPeakModelUnavailableError("idlePlan");
    }
    const requestAuth = await runtime.buildRequestAuth(request.serverTicketId);
    // 首次派发与复用会话的恢复派发需要在轮次事实中可区分；该字段只描述
    // 当前自动 turn 的调度阶段，不改变稳定 task ID、独立 message ID 或手动消息语义。
    const dispatchKind = resolveOffPeakDispatchKind(request);
    const offPeakRunType = dispatchKind === "resume" ? "resume" : "init";
    let trackedKey: string | null = null;
    try {
      let taskId: string;
      let traceId: TraceId;
      let promptContent = request.prompt;
      if (dispatchKind === "bound-first-run") {
        // 绑定首跑：会话内创建的任务在创建它的会话里执行（对齐 dispatchCronRun 的 targetTaskId 路径）。
        // 先探测再写配置：绑定的是用户的工作会话，忙碌时直接 transient 交给调度器退避，
        // 不能先 setMode 再被 session/send 以 -32010 拒绝（那会悄悄改掉用户会话的权限模式）。
        taskId = request.sessionId!;
        traceId = `${request.offPeakTaskId}:bound:${randomUUID()}` as TraceId;
        const workspaceScope = {
          workspacePath: request.workspacePath,
          workspaceIdentity: request.workspaceIdentity,
        };
        const [deletedIds, tasks] = await Promise.all([
          acodeTaskService.listDeletedTaskIds(workspaceScope),
          acodeTaskService.listTasks(workspaceScope),
        ]);
        assertBoundSessionDispatchable({
          sessionId: taskId,
          deleted: deletedIds.includes(taskId),
          running: tasks.find((task) => task.taskId === taskId)?.status === "running",
        });
        await acodeTaskService.resumeTask({
          ...workspaceScope,
          taskId,
          // 绑定会话首次盖章归属标记，侧栏归入闲时分组（机制同 cron targetTaskId）。
          offPeakTaskId: request.offPeakTaskId,
        });
        await acodeTaskService.setConfigOption({
          taskId,
          traceId,
          configId: "mode",
          value: request.permissionMode,
        });
      } else if (dispatchKind === "resume") {
        // 续跑段：resume 同一 session（冷恢复水合历史；send 前必须先 resume）。
        taskId = request.conversationId!;
        // 原因：offPeakTaskId 只用于跨 talk 关联；每次自动轮必须生成独立消息身份，
        // 不能复用 task ID，也不能依赖同毫秒时间戳避免碰撞。
        traceId = `${request.offPeakTaskId}:resume:${randomUUID()}` as TraceId;
        promptContent = OFF_PEAK_RESUME_PROMPT;
        await acodeTaskService.resumeTask({
          taskId,
          workspacePath: request.workspacePath,
          workspaceIdentity: request.workspaceIdentity,
          // pre-打点会话续跑时补写归属标记（bootstrap 回填之外的双保险）。
          offPeakTaskId: request.offPeakTaskId,
        });
        // 权限模式随派发下发（resume 后显式设置，幂等）。
        await acodeTaskService.setConfigOption({
          taskId,
          traceId,
          configId: "mode",
          value: request.permissionMode,
        });
        // 档位是 idle Selection 的一部分，只在 sendPrompt 注入；单独写档位会污染用户会话。
      } else {
        const task = await acodeTaskService.createTask({
          workspacePath: request.workspacePath,
          workspaceIdentity: request.workspaceIdentity,
          // 空 Session 沿用普通初始化；idle Selection 只在下方执行中注入。
          // 在此写入会让闲时轮结束后的普通消息继续使用无票的隐藏 Provider。
          mode: request.permissionMode as ACodeTaskMode,
          // 闲时任务是无界面的 createTask + sendPrompt 连续派发；空 session 必须在首条
          // V4 admission 内先持久化，否则 session_input 外键会先于 session 主记录写入。
          deferPersistenceUntilFirstPrompt: true,
          // 创建时即盖章持久归属标记（月亮图标/后续系统分组只看该标记，不再反查 store）。
          offPeakTaskId: request.offPeakTaskId,
        });
        taskId = task.taskId;
        traceId = task.traceId;
      }
      trackedKey = offPeakRunSubscriptionKey(taskId, traceId);
      trackOffPeakRunOutcome({
        acodeTaskService,
        offPeakTaskId: request.offPeakTaskId,
        taskId,
        traceId,
        workspacePath: request.workspacePath,
        ...(request.workspaceIdentity ? { workspaceIdentity: request.workspaceIdentity } : {}),
      });
      await acodeTaskService.sendPrompt({
        taskId,
        traceId,
        content: promptContent,
        clientMode: "desktop-continuous",
        // Bug 原因：闲时自动 turn 以前只注入 idle plan，没有限制工具面，模型可在后台创建
        // 持久化定时任务。首跑与续跑在此收敛，显式隐藏 CronCreate 且不伪造 cron automation 归属。
        // 闲时轮同时隐藏 OffPeakCreate，OffPeakList 只读保留。
        toolDenylist: ["CronCreate", "OffPeakCreate"],
        modelSelection: idleSelection,
        modelExecution: {
          // 闲时执行凭据只服务主 Turn；完成后不再派生自动 Memory 请求。
          memoryExtraction: "skip",
          selectionScope: "execution",
          requestAuth,
          subagents: {
            foregroundModel: "submission",
            background: "deny",
          },
        },
        offPeakTaskId: request.offPeakTaskId,
        offPeakRunType,
      });
      // 2026-10-05 清理：此处原有「只有 init 实际新建」的 session_create 计数逻辑，
      // 随对话分享功能删净时只删了计数体、留下空 if 壳——死代码回归痕迹，抽取时一并移除。
      return { conversationId: taskId, sessionId: taskId };
    } catch (error) {
      if (trackedKey) disposeOffPeakRunSubscription(trackedKey);
      throw error;
    }
  }

  return {
    dispatchOffPeakRun,
    disposeRunSubscriptions() {
      for (const key of Array.from(offPeakRunSubscriptions.keys())) {
        disposeOffPeakRunSubscription(key);
      }
    },
    disposeRuntime: disposeOffPeakRuntime,
    closeRepository() {
      offPeakTaskRepo.close();
    },
  };
}
