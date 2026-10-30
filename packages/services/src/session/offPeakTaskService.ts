/* off-peak 任务编排服务（host 域，仿 automationService 形态）。
   职责：
   - 创建即取号（POST /ticket 成功才落库）；3103/3101 抛类型化错误给 UI
   - 取消/暂停/继续/删除/编辑 的状态守卫编排
   - offPeakTaskSync：有非终态任务才批量轮询 /ticket/status（轮询触发服务端晋级），
     写回 schedulable/位次/next_poll_at；expired 且非 paused → 同 task_id 自动重取号
   - 终态核销 outbox：终态即 settle、失败随轮询周期捎带补报、启动扫描
   - 3102 续跑：host 终态回写识别标记后调 handleTicketExpiredDuringRun → 回队重取号
   2026-10-30 拆分（onboard-b3 例外偿还）：创建校验、管理编排、票据操作与同步周期主体
   移到 off-peak/ 叶子（createValidation/adminOps/ticketOps/syncCycle），本体留状态与委托。 */
import {
  isOffPeakTerminalStatus,
  type OffPeakCodingPlanSupport,
  type OffPeakTaskCreateResult,
  type ACodeOffPeakTask,
  type ACodeOffPeakTaskCreateParams,
} from "@acode/shared";
import type { ServiceLogger } from "../logger/serviceLogger.js";
import type { OffPeakTaskRepo } from "./offPeakTaskRepo.js";
import type { IOffPeakTaskService, OffPeakUpdateTaskParams } from "./offPeakTask.js";
import type { OffPeakServerClient } from "./offPeakServerClient.js";
import type { ModelSelection, ModelSelectionValidation } from "@acode/provider";
import {
  continueOffPeakTask,
  createOffPeakTask,
  updateOffPeakTask,
  type OffPeakTaskAdminContext,
} from "#src/session/off-peak/offPeakTaskAdminOps.js";
import {
  retakeOffPeakTicket,
  settleOffPeakTask,
} from "#src/session/off-peak/offPeakTicketOps.js";
import {
  OFF_PEAK_SYNC_MAX_INTERVAL_MS,
  OFF_PEAK_SYNC_MIN_INTERVAL_MS,
  SYNC_FAILURE_BASE_MS,
  runOffPeakSyncCycle,
  type OffPeakSyncCycleContext,
} from "#src/session/off-peak/offPeakSyncCycle.js";

interface OffPeakTaskServiceDeps {
  repo: OffPeakTaskRepo;
  client: OffPeakServerClient;
  /** 与 ticket/runtime 共用 resolver 后的脱敏结果，供 renderer 创建门控。 */
  resolveCodingPlanSupport: () => Promise<OffPeakCodingPlanSupport>;
  /** 只返回安全 hostname；解析失败返回空串，不能影响创建业务结果。 */
  resolveTelemetryProviderName: () => Promise<string>;
  /** 用当前完整 Registry 解析并校验固定 Off-Peak Provider 的选择。 */
  resolveModelSelection: (input: {
    readonly modelId?: string;
    readonly reasoningLevel?: string;
  }) => Promise<
    | { readonly ok: true; readonly selection: ModelSelection }
    | { readonly ok: false; readonly validation: ModelSelectionValidation }
  >;
  logger: ServiceLogger;
  /** schedulable 翻 1 后立即唤醒 scheduler tick（缺省等 20s 轮询）。 */
  requestSchedulerWake?: () => void;
  /** 取消 running 任务时中止其 agent loop（host 注入；best-effort）。 */
  stopRunningTask?: (params: {
    conversationId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }) => Promise<void>;
  /** 列表变化广播钩子（UI 刷新）。 */
  onTasksChanged?: () => void;
  /** 测试注入时钟。 */
  now?: () => number;
  /** disposeAll 附加清理（如关闭 mock 网关）。 */
  onDispose?: () => void;
}

export class OffPeakTaskService implements IOffPeakTaskService {
  private syncTimer: ReturnType<typeof setTimeout> | null = null;
  private syncRunning = false;
  private syncStopped = true;
  private consecutiveSyncFailures = 0;
  /** 传给 off-peak/ 编排叶子的稳定上下文（回调经箭头函数绑定本实例）。 */
  private readonly opsContext: OffPeakTaskAdminContext & OffPeakSyncCycleContext;

  constructor(private readonly deps: OffPeakTaskServiceDeps) {
    this.opsContext = {
      repo: deps.repo,
      client: deps.client,
      logger: deps.logger,
      resolveTelemetryProviderName: deps.resolveTelemetryProviderName,
      resolveModelSelection: deps.resolveModelSelection,
      requestSchedulerWake: deps.requestSchedulerWake,
      now: () => this.now(),
      emitChanged: () => this.emitChanged(),
      ensureSyncScheduled: (delayMs) => this.ensureSyncScheduled(delayMs),
      projectTasks: (tasks) => this.projectModelSelectionIssues(tasks),
    };
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private emitChanged(): void {
    try {
      this.deps.onTasksChanged?.();
    } catch (error) {
      this.deps.logger.warn(undefined, "off-peak onTasksChanged 回调失败:", error);
    }
  }

  // ---- 管理操作 ----

  async getCodingPlanSupport(): Promise<OffPeakCodingPlanSupport> {
    return this.deps.resolveCodingPlanSupport();
  }

  /** Host 派发前的窄检查；最终执行仍由目标 Agent ModelFactory 重新校验。 */
  async validateDispatchModelSelection(selection: ModelSelection): Promise<boolean> {
    const resolved = await this.deps.resolveModelSelection({
      modelId: selection.modelId,
      ...(selection.options?.reasoningLevel
        ? { reasoningLevel: selection.options.reasoningLevel }
        : {}),
    });
    return (
      resolved.ok &&
      resolved.selection.providerId === selection.providerId &&
      resolved.selection.modelId === selection.modelId
    );
  }

  async getTakeNumberAvailability() {
    return this.deps.client.getTakeNumberAvailability();
  }

  /** 创建即取号（取号成功才落库）；失败只返回稳定分类，绝不跨 RPC 返回 raw error。 */
  async createTask(params: ACodeOffPeakTaskCreateParams): Promise<OffPeakTaskCreateResult> {
    return createOffPeakTask(this.opsContext, params);
  }

  /**
   * 取消（任意非终态）：先落终态再停 loop——顺序保证 loop 的 stopped 迟到回写
   * 被终态守卫丢弃，不会覆盖 cancelled（幂等）。
   */
  async cancelTask(offPeakTaskId: string): Promise<ACodeOffPeakTask | null> {
    const existing = await this.deps.repo.get(offPeakTaskId);
    if (!existing || isOffPeakTerminalStatus(existing.status)) return existing;
    const cancelled = await this.deps.repo.markTerminal(offPeakTaskId, {
      status: "cancelled",
      endedAt: this.now(),
    });
    if (!cancelled) return this.deps.repo.get(offPeakTaskId);
    if (existing.status === "running" && existing.conversationId && this.deps.stopRunningTask) {
      try {
        await this.deps.stopRunningTask({
          conversationId: existing.conversationId,
          workspacePath: existing.workspacePath,
          ...(existing.workspaceIdentity ? { workspaceIdentity: existing.workspaceIdentity } : {}),
        });
      } catch (error) {
        this.deps.logger.warn(undefined, `off-peak cancel stop loop failed task=${offPeakTaskId}:`, error);
      }
    }
    this.emitChanged();
    void this.settleOne(cancelled);
    return cancelled;
  }

  /** Pause：停止本地派发，票留服务端队列继续排。 */
  async pauseTask(offPeakTaskId: string): Promise<ACodeOffPeakTask | null> {
    const paused = await this.deps.repo.setPaused(offPeakTaskId, true, {
      now: this.now(),
    });
    if (paused) this.emitChanged();
    return paused;
  }

  /**
   * Continue：票活着 = 恢复派发（零成本）；票已废（expired/not_found/无票）= 此刻手动
   * 重取号回队尾（额度消耗必须由用户显式动作触发）。
   */
  async continueTask(offPeakTaskId: string): Promise<ACodeOffPeakTask | null> {
    return continueOffPeakTask(this.opsContext, offPeakTaskId);
  }

  /** 删除：非终态先按取消处理（停 loop + settle），再删行；终态直接删。 */
  async deleteTask(offPeakTaskId: string): Promise<void> {
    const existing = await this.deps.repo.get(offPeakTaskId);
    if (!existing) return;
    if (!isOffPeakTerminalStatus(existing.status)) {
      await this.cancelTask(offPeakTaskId);
    }
    await this.deps.repo.delete(offPeakTaskId);
    this.emitChanged();
  }

  /** Delete history：仅写本地可见性标记，任务与会话继续保留。 */
  async deleteHistory(offPeakTaskId: string): Promise<ACodeOffPeakTask | null> {
    const updated = await this.deps.repo.markHistoryDeleted(offPeakTaskId, {
      now: this.now(),
    });
    if (updated) this.emitChanged();
    return updated;
  }

  /** 编辑（queued/paused 全字段可编辑；票只锁队列身份，prompt 派发时才读）。 */
  async updateTask(
    offPeakTaskId: string,
    params: OffPeakUpdateTaskParams,
  ): Promise<ACodeOffPeakTask | null> {
    return updateOffPeakTask(this.opsContext, offPeakTaskId, params);
  }

  async list(): Promise<ACodeOffPeakTask[]> {
    return this.projectModelSelectionIssues(await this.deps.repo.list());
  }

  async get(offPeakTaskId: string): Promise<ACodeOffPeakTask | null> {
    const task = await this.deps.repo.get(offPeakTaskId);
    if (!task) return null;
    return (await this.projectModelSelectionIssues([task]))[0] ?? null;
  }

  /**
   * 只派生当前配置诊断，不写数据库；旧字段仅由 migration 处理。
   */
  private async projectModelSelectionIssues(
    tasks: readonly ACodeOffPeakTask[],
  ): Promise<ACodeOffPeakTask[]> {
    const repaired: ACodeOffPeakTask[] = [];
    for (const task of tasks) {
      if (task.modelSelection) {
        // 读取时把当前账号不可用写成 NULL，会永久丢掉原选择并诱发旧字段重绑。
        // 新结构只派生诊断，不写任务或 Ticket；终态不再使用模型，无需重新检查。
        const usable =
          isOffPeakTerminalStatus(task.status) ||
          (await this.validateDispatchModelSelection(task.modelSelection));
        repaired.push(
          usable
            ? task
            : {
                ...task,
                schedulable: false,
                modelSelectionIssue: {
                  code: "repair-required",
                  legacyModelId: task.modelSelection.modelId,
                  legacyReasoningLevel: task.modelSelection.options?.reasoningLevel,
                },
              },
        );
        continue;
      }
      // 数据库迁移无法确定旧 Provider 时保持缺失；读取不补迁、不重绑 Ticket。
      repaired.push({ ...task, schedulable: false });
    }
    return repaired;
  }

  // ---- 3102 续跑（host 终态回写识别标记后调用）----

  /** 票据过期（active 3h 到期/ready 废票）：回队保 session → 同 task_id 重取号。 */
  async handleTicketExpiredDuringRun(offPeakTaskId: string): Promise<void> {
    const requeued = await this.deps.repo.requeueForContinuation(offPeakTaskId, {
      now: this.now(),
    });
    if (!requeued) {
      this.deps.logger.info(
        undefined,
        `off-peak ticket-expired requeue dropped (not running) task=${offPeakTaskId}`,
      );
      return;
    }
    await this.retakeTicket(offPeakTaskId);
    this.emitChanged();
    this.ensureSyncScheduled(0);
  }

  /** 同 task_id 重新取号（已确认允许多次），失败留给轮询周期重试。 */
  private async retakeTicket(offPeakTaskId: string): Promise<void> {
    return retakeOffPeakTicket(this.opsContext, offPeakTaskId);
  }

  // ---- offPeakTaskSync：批量轮询 + 晋级写回 + 核销 outbox ----

  startSync(): void {
    if (!this.syncStopped) return;
    this.syncStopped = false;
    // 启动即扫一次未核销终态（host 启动扫描）。
    this.ensureSyncScheduled(0);
  }

  stopSync(): void {
    this.syncStopped = true;
    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
      this.syncTimer = null;
    }
  }

  /** disposeServiceResources 钩子：host 退出统一回收（停轮询 + 附加清理）。 */
  disposeAll(): void {
    this.stopSync();
    try {
      this.deps.onDispose?.();
    } catch (error) {
      this.deps.logger.warn(undefined, "off-peak onDispose 清理失败:", error);
    }
  }

  private ensureSyncScheduled(delayMs: number): void {
    if (this.syncStopped) return;
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => {
      this.syncTimer = null;
      void this.runSyncCycle();
    }, delayMs);
    // Node 定时器不阻止进程退出（host 生命周期由外部管理）。
    this.syncTimer.unref?.();
  }

  /** 单次同步周期；显式调用（测试/启动扫描）不受 stopSync 影响，仅自动重排循环受控。 */
  async runSyncCycle(): Promise<void> {
    if (this.syncRunning) return;
    this.syncRunning = true;
    let nextDelay = OFF_PEAK_SYNC_MAX_INTERVAL_MS;
    try {
      // 周期主体（核销补报/批量轮询/晋级写回）在 off-peak/offPeakSyncCycle 叶子。
      nextDelay = await runOffPeakSyncCycle(this.opsContext);
      this.consecutiveSyncFailures = 0;
    } catch (error) {
      // 轮询失败退避重试：期间不派发、在跑不受影响。
      this.consecutiveSyncFailures += 1;
      nextDelay = Math.min(
        SYNC_FAILURE_BASE_MS * 2 ** Math.max(0, this.consecutiveSyncFailures - 1),
        OFF_PEAK_SYNC_MAX_INTERVAL_MS,
      );
      this.deps.logger.warn(
        undefined,
        `off-peak sync cycle failed (attempt ${this.consecutiveSyncFailures}):`,
        error,
      );
    } finally {
      this.syncRunning = false;
      const clamped = Math.min(
        Math.max(nextDelay, OFF_PEAK_SYNC_MIN_INTERVAL_MS),
        OFF_PEAK_SYNC_MAX_INTERVAL_MS,
      );
      this.ensureSyncScheduled(clamped);
    }
  }

  /** 终态未核销任务补报（幂等，永远失败也无害——服务端静默超时回收兜底）。 */
  private async settleOne(task: ACodeOffPeakTask): Promise<void> {
    return settleOffPeakTask(this.opsContext, task);
  }
}
