import {
  isTasksStorageMigrated,
  isTasksStoragePrepared,
} from "#src/session/tasksDatabase/prepared.js";
/* off-peak 任务仓库：off_peak_tasks 的 sqlite schema、状态机守卫写入与调度认领。
   与 automation 共用 tasks-index.sqlite 与 Repo 模式，但表/状态机/常量全部独立，
   禁止往 automations 表或 ACodeAutomation 类型上加字段。
   2026-10-30 拆分（onboard-b3 例外偿还）：SQL 实现移到 off-peak/ 叶子
   （database/rows/crud/fields/scheduling），本体只留生命周期与委托包装。 */
import { type ACodeOffPeakTask, type ACodeOffPeakTaskCreateParams } from "@acode/shared";
import { getTasksIndexDatabasePath } from "#src/paths.js";
import { runTasksDatabaseMigrations } from "#src/session/tasksDatabase/migrations.js";
import {
  openOffPeakTasksDatabase,
  type DatabaseSyncInstance,
} from "#src/session/off-peak/offPeakTaskDatabase.js";
import {
  readOffPeakTaskRow,
  rowToTask,
} from "#src/session/off-peak/offPeakTaskRows.js";
import {
  countActiveOffPeakTasks,
  countNonTerminalOffPeakTasks,
  deleteOffPeakTask,
  hasActiveBoundOffPeakTask,
  insertOffPeakTask,
  listOffPeakTasks,
  markOffPeakHistoryDeleted,
  type OffPeakTaskInsertOptions,
  type OffPeakTaskListScope,
} from "#src/session/off-peak/offPeakTaskCrud.js";
import {
  invalidateOffPeakModelSelection,
  updateOffPeakEditableFields,
  updateOffPeakSchedulingSnapshot,
  type OffPeakEditableFieldsPatch,
  type OffPeakSchedulingSnapshotPatch,
} from "#src/session/off-peak/offPeakTaskFields.js";
import {
  claimDueOffPeakTasks,
  listNonTerminalOffPeakTasks,
  listUnsettledTerminalOffPeakTasks,
  markOffPeakTaskRunning,
  markOffPeakTaskSettled,
  markOffPeakTaskTerminal,
  recoverInterruptedOffPeakTasks,
  releaseOffPeakClaim,
  requeueOffPeakTaskForContinuation,
  setOffPeakTaskPaused,
  type OffPeakMarkRunningOptions,
  type OffPeakMarkTerminalOptions,
} from "#src/session/off-peak/offPeakTaskScheduling.js";

// 常量与冲突判别谓词的实现已迁入 off-peak/ 叶子；此处再导出保持对外导出面不变。
export { OFF_PEAK_CLAIM_STALE_MS } from "#src/session/off-peak/offPeakTaskScheduling.js";
export { isOffPeakBoundSessionConflict } from "#src/session/off-peak/offPeakTaskRows.js";

/**
 * 闲时任务存储仓库（tasks-index.sqlite，WAL、多进程安全）。
 *
 * 仓库只做存储与原子状态迁移，守卫两条不变量：
 * 终态不可逆出；单任务认领 single-flight（任务间并发不设本地上限）。
 * 排队/晋级语义在服务端，仓库不感知——schedulable 只是 host 轮询写回的快照。
 */
export class OffPeakTaskRepo {
  private db: DatabaseSyncInstance | null = null;
  private dbPath: string | null = null;
  private initializePromise: Promise<void> | null = null;
  // 同 AutomationRepo，db 路径不能依赖进程级全局 _dataBaseDir：
  // vitest threads 并发跑测试文件时全局值被互相覆盖，存在写进真实库的窗口。
  // 改为构造期固定 dbPath，测试通过依赖注入传入临时库路径，生产路径不传则回退默认。
  private readonly resolvedDbPath: string | null;

  constructor(
    dbPath?: string,
    private readonly startupBusyTimeoutMs = 5000,
  ) {
    this.resolvedDbPath = dbPath?.trim() || null;
  }

  private resolveDbPath(): string {
    return this.resolvedDbPath ?? getTasksIndexDatabasePath();
  }

  async ensureReady(): Promise<void> {
    const path = this.resolveDbPath();
    if (this.dbPath && this.dbPath !== path) {
      this.close();
    }
    if (!this.initializePromise) {
      this.initializePromise = this.initialize(path).catch((error) => {
        this.close();
        throw error;
      });
    }
    await this.initializePromise;
  }

  close(options?: { throwOnError?: boolean }): void {
    let closeError: unknown;
    try {
      this.db?.close();
    } catch (error) {
      closeError = error;
      // ignore
    }
    this.db = null;
    this.dbPath = null;
    this.initializePromise = null;
    if (options?.throwOnError && closeError) throw closeError;
  }

  private async initialize(path: string): Promise<void> {
    if (!this.db) {
      this.db = await openOffPeakTasksDatabase(path, this.startupBusyTimeoutMs);
      this.dbPath = path;
    }
    // Worker 已完成该路径的原始准备，业务连接不再重复全表修复。
    if (isTasksStoragePrepared(path, this.db)) return;
    if (!isTasksStorageMigrated(path, this.db)) runTasksDatabaseMigrations(this.db);
    // 早期预留了 awaiting_approval，但生产链路从未写入，UI 却把它包装成可用能力。
    // 当前确认只走普通 session；迁移遗留行回 running，随后由启动回收按真实进程状态处理。
    this.getDatabase()
      .prepare(
        `UPDATE off_peak_tasks
        SET status = 'running', updated_at = @now
        WHERE status = 'awaiting_approval'`,
      )
      .run({ now: Date.now() });
  }

  private getDatabase(): DatabaseSyncInstance {
    if (!this.db) {
      throw new Error("OffPeakTaskRepo 未初始化：请先 await ensureReady()");
    }
    return this.db;
  }

  // ---- 管理 CRUD ----

  /**
   * 创建即入队（status=queued）。取号在 service 层先行（POST /ticket 成功才落库），
   * 取号结果经 options 一并写入；mock 先行阶段允许不带服务端字段。
   */
  async create(
    params: ACodeOffPeakTaskCreateParams,
    options?: OffPeakTaskInsertOptions,
  ): Promise<ACodeOffPeakTask> {
    await this.ensureReady();
    return insertOffPeakTask(this.getDatabase(), params, options);
  }

  async list(scope?: OffPeakTaskListScope): Promise<ACodeOffPeakTask[]> {
    await this.ensureReady();
    return listOffPeakTasks(this.getDatabase(), scope);
  }

  async get(offPeakTaskId: string): Promise<ACodeOffPeakTask | null> {
    await this.ensureReady();
    const row = readOffPeakTaskRow(this.getDatabase(), offPeakTaskId);
    return row ? rowToTask(row) : null;
  }

  /**
   * Registry 变化使已保存 Selection 失效时，保留原模型与档位供用户修复或后续可靠恢复，
   * 同时清空正式 Selection 并撤销可调度状态，避免旧配置继续被 scheduler 认领。
   */
  async invalidateModelSelection(
    offPeakTaskId: string,
    modelSelection: NonNullable<ACodeOffPeakTask["modelSelection"]>,
    options?: { now?: number },
  ): Promise<ACodeOffPeakTask | null> {
    await this.ensureReady();
    return invalidateOffPeakModelSelection(this.getDatabase(), offPeakTaskId, modelSelection, options);
  }

  /** 卡片 Delete：任何状态均可删（非终态删除的服务端核销由 service 层先行取消处理）。 */
  async delete(offPeakTaskId: string): Promise<void> {
    await this.ensureReady();
    deleteOffPeakTask(this.getDatabase(), offPeakTaskId);
  }

  /**
   * 仅隐藏 History 行：任务必须已经实际启动；重复调用幂等。
   * 不修改状态、session、started/ended/filesChanged 或服务端核销字段。
   */
  async markHistoryDeleted(
    offPeakTaskId: string,
    options?: { now?: number },
  ): Promise<ACodeOffPeakTask | null> {
    await this.ensureReady();
    return markOffPeakHistoryDeleted(this.getDatabase(), offPeakTaskId, options);
  }

  /** 创建上限的本地预判用（权威是服务端取号 429/3103）。 */
  async countNonTerminal(): Promise<number> {
    await this.ensureReady();
    return countNonTerminalOffPeakTasks(this.getDatabase());
  }

  /** 本会话是否已有未终态绑定任务（创建前预检；索引 idx_off_peak_bound_active 同条件）。 */
  async hasActiveBoundTask(workspaceKey: string, sessionId: string): Promise<boolean> {
    await this.ensureReady();
    return hasActiveBoundOffPeakTask(this.getDatabase(), workspaceKey, sessionId);
  }

  /** 执行中计数：keep-awake powerSaveBlocker 判据。 */
  async countActive(): Promise<number> {
    await this.ensureReady();
    return countActiveOffPeakTasks(this.getDatabase());
  }

  /**
   * 编辑窗口期字段：仅 queued/paused 可编辑；票只锁队列身份，prompt 派发时才读。
   * modelSelection 只能替换为另一份明确 Selection；undefined = 不改。
   */
  async updateEditableFields(
    offPeakTaskId: string,
    params: OffPeakEditableFieldsPatch,
    options?: { now?: number },
  ): Promise<ACodeOffPeakTask | null> {
    await this.ensureReady();
    return updateOffPeakEditableFields(this.getDatabase(), offPeakTaskId, params, options);
  }

  // ---- 服务端同步快照（host offPeakTaskSync 写 / scheduler 读）----

  /** 轮询/重新取号写回：仅覆盖显式传入的字段。 */
  async updateSchedulingSnapshot(
    offPeakTaskId: string,
    patch: OffPeakSchedulingSnapshotPatch,
  ): Promise<void> {
    await this.ensureReady();
    updateOffPeakSchedulingSnapshot(this.getDatabase(), offPeakTaskId, patch);
  }

  // ---- 调度状态机 ----

  /**
   * single-flight 认领可派发任务：status=queued 且 schedulable=1 且无在途认领，
   * 原子 claim_running 0→1。FIFO 序按 queued_at（权威序由服务端取号顺序保证）。
   * 同时回收认领超时（claimed_at 过期）的僵尸认领。
   */
  async claimDue(now: number): Promise<ACodeOffPeakTask[]> {
    await this.ensureReady();
    return claimDueOffPeakTasks(this.getDatabase(), now);
  }

  /**
   * 派发成功（网关 admitted）：queued→running，回填首跑产生的 conversation/session 与
   * 本段 ticket，释放认领。守卫：仅 queued 可入 running（终态不可逆出；paused 竞态下
   * 派发结果作废，返回 null 由调用方处理）。续跑段保留首段 started_at（用户视角单任务）。
   */
  async markRunning(
    offPeakTaskId: string,
    options: OffPeakMarkRunningOptions,
  ): Promise<ACodeOffPeakTask | null> {
    await this.ensureReady();
    return markOffPeakTaskRunning(this.getDatabase(), offPeakTaskId, options);
  }

  /**
   * 终态落库（completed/failed/cancelled）。守卫：终态不可逆出——已终态的行拒绝二次迁移，
   * 返回 null（OffPeakRunResult 迟到兜底时调用方据此丢弃）。settled_at 由核销单独回填。
   */
  async markTerminal(
    offPeakTaskId: string,
    options: OffPeakMarkTerminalOptions,
  ): Promise<ACodeOffPeakTask | null> {
    await this.ensureReady();
    return markOffPeakTaskTerminal(this.getDatabase(), offPeakTaskId, options);
  }

  /**
   * 用户 Pause / Continue：queued ⇄ paused。
   * Pause 只停本地派发（票留服务端队列）；Continue 的票有效性判断与重取号在 service 层。
   * 已被认领派发在途（claim_running=1）的任务不可 Pause，返回 null。
   */
  async setPaused(
    offPeakTaskId: string,
    paused: boolean,
    options?: { now?: number },
  ): Promise<ACodeOffPeakTask | null> {
    await this.ensureReady();
    return setOffPeakTaskPaused(this.getDatabase(), offPeakTaskId, paused, options);
  }

  /**
   * 释放认领（派发失败/关机退出）：复位 single-flight 锁；带 error 时累计 attempt_count
   * 并记 last_error（供派发退避与诊断）。不改 status——任务留在 queued 等下轮认领（无 skip）。
   */
  async releaseClaim(
    offPeakTaskId: string,
    options?: { error?: string; now?: number },
  ): Promise<void> {
    await this.ensureReady();
    releaseOffPeakClaim(this.getDatabase(), offPeakTaskId, options);
  }

  /**
   * 启动回收（app 级启动时调用一次，先于任何派发）：进程死亡时残留的
   * running 置回 queued（保留 queued_at，天然仍在队首附近；保留 session_id 供 resume
   * 续跑），并清理超时认领。返回回收的任务数。
   * ⚠ 调用方必须保证调用时无在跑 off-peak loop（属主应为 app 单例进程，非每个 host）。
   */
  async recoverInterrupted(now: number): Promise<number> {
    await this.ensureReady();
    return recoverInterruptedOffPeakTasks(this.getDatabase(), now);
  }

  /**
   * 3h 时间盒到期 / ready 废票的续跑回队：running → queued，保留
   * session/conversation/started_at 供 resume 接续；清 schedulable 与位次等待重新取号后由轮询刷新。
   * 终态/paused 不可回队，返回 null（如用户已抢先取消）。
   */
  async requeueForContinuation(
    offPeakTaskId: string,
    options?: { now?: number },
  ): Promise<ACodeOffPeakTask | null> {
    await this.ensureReady();
    return requeueOffPeakTaskForContinuation(this.getDatabase(), offPeakTaskId, options);
  }

  /** 全部非终态任务（offPeakTaskSync 轮询输入：有非终态才轮）。 */
  async listNonTerminal(): Promise<ACodeOffPeakTask[]> {
    await this.ensureReady();
    return listNonTerminalOffPeakTasks(this.getDatabase());
  }

  // ---- 终态核销 outbox----

  /** settle 服务端 ack 后回填；仅终态行可核销（幂等，重复回填覆盖为最新 ack 时间）。 */
  async markSettled(offPeakTaskId: string, settledAt: number): Promise<void> {
    await this.ensureReady();
    markOffPeakTaskSettled(this.getDatabase(), offPeakTaskId, settledAt);
  }

  /** 未核销的终态任务：poll 周期捎带补报 + host 启动扫描（不新增计时器）。 */
  async listUnsettledTerminal(): Promise<ACodeOffPeakTask[]> {
    await this.ensureReady();
    return listUnsettledTerminalOffPeakTasks(this.getDatabase());
  }
}
