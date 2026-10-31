// task 索引仓库本体（facade）：持有 tasks-index sqlite 连接、初始化/迁移编排与按 task 的写入串行链。
// 行映射、列表查询、分组写入等实现按职责拆到 ./task-index/ 叶子（接收 db 句柄的独立函数），
// 本类只做 ensureReady + 薄包装，对外导出面（仅此一个类）与方法签名保持不变。
import {
  isTasksStorageMigrated,
  isTasksStoragePrepared,
} from "#src/session/tasksDatabase/prepared.js";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type { ACodeProvider, ACodeTaskMeta } from "@acode/shared";
import type {
  ACodeGroupedTaskRef,
  ACodeGroupedTaskView,
  ACodeGroupedTaskViewOrderInput,
  ACodeGroupedTaskViewQuery,
  ACodeGroupedTaskViewStructure,
  ACodeTaskGroup,
  ACodeTaskGroupColor,
  ACodeTaskListQuery,
  ACodeTaskListResult,
} from "#src/session/acodeTaskListTypes.js";
import { getTasksIndexDatabasePath } from "#src/paths.js";
import { runTasksDatabaseMigrations } from "#src/session/tasksDatabase/migrations.js";
import type { TaskIndexStatePatch } from "#src/session/task-index/taskIndexRows.js";
import { workspaceKey } from "#src/session/task-index/taskGrouping.js";
import { rowToMeta } from "#src/session/task-index/taskRowMapping.js";
import { getTaskRow } from "#src/session/task-index/taskRecordWrites.js";
import {
  syncTaskMetaWithGroupedAdmissionReady,
  type TaskIndexSyncMetaParams,
} from "#src/session/task-index/taskMetaSync.js";
import {
  applyAgentPatchReady,
  clearTaskUnreadIfMatchesReady,
  deleteArchivedTaskReady,
  seedTaskMetaIfMissingReady,
  updateTaskStateReady,
} from "#src/session/task-index/taskStateWrites.js";
import { initializeGroupedTaskAtTopReady } from "#src/session/task-index/taskGroupingMemberships.js";
import {
  backfillOffPeakGroupMemberships,
  backfillOffPeakTaskMarkers,
  cleanupDeletedTaskGroupingReferences,
  hasGroupedWorkspaceBootstrapRunSync,
} from "#src/session/task-index/taskGroupBootstrap.js";
import {
  createTaskGroupReady,
  deleteTaskGroupReady,
  renameTaskGroupReady,
  updateTaskGroupColorReady,
} from "#src/session/task-index/taskGroupCrud.js";
import {
  listDeletedTaskIdsReady,
  listSessionsByAutomationReady,
  listTaskMetasReady,
  queryTaskListReady,
} from "#src/session/task-index/taskListQueries.js";
import { archiveStaleTasksReady } from "#src/session/task-index/archiveStaleTasks.js";
import {
  queryGroupedTaskViewReady,
  queryGroupedTaskViewStructureReady,
} from "#src/session/task-index/groupedViewQueries.js";
import { applyGroupedTaskViewOrderReady } from "#src/session/task-index/groupedViewOrderWrites.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

type DatabaseSyncInstance = InstanceType<typeof DatabaseSync>;

export class TaskIndexRepo {
  constructor(
    private readonly startupDbPath?: string,
    private readonly startupBusyTimeoutMs = 5000,
  ) {}
  private db: DatabaseSyncInstance | null = null;
  private dbPath: string | null = null;
  private initializePromise: Promise<void> | null = null;
  private readonly writeChains = new Map<string, Promise<void>>();

  async ensureReady(): Promise<void> {
    const path = this.startupDbPath ?? getTasksIndexDatabasePath();
    if (this.dbPath && this.dbPath !== path) {
      this.close();
    }
    if (!this.initializePromise) {
      this.initializePromise = this.initialize(path).catch((error) => {
        // 释放失败连接；迁移后修复可能已部分提交，重试仍走原幂等初始化。
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
      // ignore close errors
    }
    this.db = null;
    this.dbPath = null;
    this.initializePromise = null;
    this.writeChains.clear();
    if (options?.throwOnError && closeError) throw closeError;
  }

  private async initialize(path: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    if (!this.db) {
      this.db = new DatabaseSync(path);
      this.dbPath = path;
      // 多窗口 Host 共用 tasks-index；写事务和首次 schema 升级应短暂等待，而不是立即 SQLITE_BUSY。
      this.db.exec(`PRAGMA busy_timeout = ${this.startupBusyTimeoutMs}`);
      this.db.exec("PRAGMA foreign_keys = ON");
      this.db.exec("PRAGMA journal_mode = WAL");
      this.db.exec("PRAGMA synchronous = NORMAL");
    }
    // Worker 已完成该路径的原始准备，业务连接不再重复全表修复。
    if (isTasksStoragePrepared(path, this.db)) return;
    if (!isTasksStorageMigrated(path, this.db)) runTasksDatabaseMigrations(this.db);
    backfillOffPeakTaskMarkers(this.getDatabase());
    backfillOffPeakGroupMemberships(this.getDatabase());
    cleanupDeletedTaskGroupingReferences(this.getDatabase());
  }

  private getDatabase(): DatabaseSyncInstance {
    if (!this.db) {
      throw new Error("task index sqlite 尚未初始化");
    }
    return this.db;
  }

  private writeKey(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
  }): string {
    return `${workspaceKey(params)}\u0000${params.taskId}`;
  }

  private enqueueWrite<T>(
    params: { workspacePath: string; workspaceIdentity?: string; taskId: string },
    operation: () => Promise<T> | T,
  ): Promise<T> {
    const key = this.writeKey(params);
    const previous = this.writeChains.get(key) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const completion = result.then(
      () => undefined,
      () => undefined,
    );
    this.writeChains.set(key, completion);
    void completion.finally(() => {
      if (this.writeChains.get(key) === completion) {
        this.writeChains.delete(key);
      }
    });
    return result;
  }

  async hasGroupedWorkspaceBootstrapRun(): Promise<boolean> {
    await this.ensureReady();
    return hasGroupedWorkspaceBootstrapRunSync(this.getDatabase());
  }

  async archiveStaleTasks(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    olderThanDays: number;
    provider?: ACodeProvider;
  }): Promise<ACodeTaskMeta[]> {
    await this.ensureReady();
    return archiveStaleTasksReady(this.getDatabase(), params);
  }

  async syncTaskMeta(params: TaskIndexSyncMetaParams): Promise<ACodeTaskMeta> {
    const result = await this.syncTaskMetaWithGroupedAdmission(params, false);
    return result.meta;
  }

  /** 首次公开 root task 时，原子提交 task row 与 grouped 顶层顺序。 */
  async syncTaskMetaAtGroupedTop(
    params: TaskIndexSyncMetaParams,
  ): Promise<{ meta: ACodeTaskMeta; initializedGroupedOrder: boolean }> {
    return this.syncTaskMetaWithGroupedAdmission(params, true);
  }

  private async syncTaskMetaWithGroupedAdmission(
    params: TaskIndexSyncMetaParams,
    initializeGroupedAtTop: boolean,
  ): Promise<{ meta: ACodeTaskMeta; initializedGroupedOrder: boolean }> {
    await this.ensureReady();
    return this.enqueueWrite(params.meta, () =>
      syncTaskMetaWithGroupedAdmissionReady(this.getDatabase(), params, initializeGroupedAtTop),
    );
  }

  /**
   * 只在索引行不存在时写入基线元数据；已存在（含已删除）的产品壳状态原样保留。
   *
   * 远端 workspace 的 V4 会话路径可能晚于会话创建才建立 sessions-index
   * 订阅。首次 snapshot 必须能补齐全新的 tasks-index.sqlite，但不能用摘要默认值
   * 覆盖已有的 pin/archive/unread/手动标题，也不能与随后到达的完整 snapshot 竞态回写。
   */
  async seedTaskMetaIfMissing(meta: ACodeTaskMeta): Promise<ACodeTaskMeta> {
    await this.ensureReady();
    return this.enqueueWrite(meta, () => seedTaskMetaIfMissingReady(this.getDatabase(), meta));
  }

  async clearTaskUnreadIfMatches(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
    expectedUnreadAt: number;
  }): Promise<{ meta: ACodeTaskMeta; cleared: boolean }> {
    await this.ensureReady();
    return this.enqueueWrite(params, () =>
      clearTaskUnreadIfMatchesReady(this.getDatabase(), params),
    );
  }

  async deleteArchivedTask(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
  }): Promise<ACodeTaskMeta | null> {
    await this.ensureReady();
    return this.enqueueWrite(params, () => deleteArchivedTaskReady(this.getDatabase(), params));
  }

  async updateTaskState(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
    patch: TaskIndexStatePatch;
  }): Promise<ACodeTaskMeta> {
    await this.ensureReady();
    return this.enqueueWrite(params, () => updateTaskStateReady(this.getDatabase(), params));
  }

  async applyAgentPatch(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
    patch: Pick<TaskIndexStatePatch, "title" | "status" | "lastError" | "target" | "updatedAt">;
  }): Promise<ACodeTaskMeta | null> {
    await this.ensureReady();
    return this.enqueueWrite(params, () => applyAgentPatchReady(this.getDatabase(), params));
  }

  async listTaskMetas(params: {
    workspacePath?: string;
    workspaceIdentity?: string;
    provider?: ACodeProvider;
    pinned?: boolean;
    archived?: boolean;
    includeDeleted?: boolean;
  }): Promise<ACodeTaskMeta[]> {
    await this.ensureReady();
    return listTaskMetasReady(this.getDatabase(), params);
  }

  /**
   * 读取 workspace 下的删除 tombstone。
   *
   * CLI session store 会继续保留会话内容；如果列表 join 只读取 active/pinned/archived，
   * deleted task 会因“不在 archived 集合”被误判成普通 task，并在冷启动后重新出现。
   */
  async listDeletedTaskIds(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    provider?: ACodeProvider;
  }): Promise<string[]> {
    await this.ensureReady();
    return listDeletedTaskIdsReady(this.getDatabase(), params);
  }

  /**
   * 列出某条 automation 产生的所有 cron session（用于 automation 详情展开、关联查询）。
   * 走 cron_automation_id 索引列，只返回未删除的 session，按创建时间倒序。
   */
  async listSessionsByAutomation(automationId: string): Promise<ACodeTaskMeta[]> {
    await this.ensureReady();
    return listSessionsByAutomationReady(this.getDatabase(), automationId);
  }

  async queryTaskList(
    params: ACodeTaskListQuery & { provider?: ACodeProvider },
  ): Promise<ACodeTaskListResult> {
    await this.ensureReady();
    return queryTaskListReady(this.getDatabase(), params);
  }

  async createTaskGroup(params?: {
    title?: string;
    color?: ACodeTaskGroupColor;
  }): Promise<ACodeTaskGroup> {
    await this.ensureReady();
    return createTaskGroupReady(this.getDatabase(), params);
  }

  async renameTaskGroup(params: { groupId: string; title: string }): Promise<ACodeTaskGroup> {
    await this.ensureReady();
    return renameTaskGroupReady(this.getDatabase(), params);
  }

  async updateTaskGroupColor(params: {
    groupId: string;
    color: ACodeTaskGroupColor;
  }): Promise<ACodeTaskGroup> {
    await this.ensureReady();
    return updateTaskGroupColorReady(this.getDatabase(), params);
  }

  async deleteTaskGroup(params: { groupId: string }): Promise<void> {
    await this.ensureReady();
    deleteTaskGroupReady(this.getDatabase(), params);
  }

  async initializeGroupedTaskAtTop(params: ACodeGroupedTaskRef): Promise<boolean> {
    await this.ensureReady();
    return initializeGroupedTaskAtTopReady(this.getDatabase(), params);
  }

  // 过渡面：grouped 列表消费已切 sessions-index + queryGroupedTaskViewStructure，
  // 本方法仅剩 applyGroupedTaskViewOrder 的回包复用（UI 已不采信该回包），
  // 随 applyGroupedTaskViewOrder 返回面收敛一并收口。
  async queryGroupedTaskView(
    params: ACodeGroupedTaskViewQuery & { provider?: ACodeProvider },
  ): Promise<ACodeGroupedTaskView> {
    await this.ensureReady();
    return queryGroupedTaskViewReady(this.getDatabase(), params);
  }

  /**
   * grouped 原始结构读取（不 join tasks 表、无 bootstrap / normalize 写回）。
   * 任务内容改由 sessions-index 提供，客户端 join；这里只回 group / member / 顶层排序三张表。
   * 组可见性沿用 queryGroupedTaskView 口径：bootstrap workspace group 只在其 workspace 可见。
   */
  async queryGroupedTaskViewStructure(params: {
    workspaceScopes: Array<{ workspacePath: string; workspaceIdentity?: string }>;
  }): Promise<ACodeGroupedTaskViewStructure> {
    await this.ensureReady();
    return queryGroupedTaskViewStructureReady(this.getDatabase(), params);
  }

  async applyGroupedTaskViewOrder(
    params: ACodeGroupedTaskViewOrderInput & { provider?: ACodeProvider },
  ): Promise<ACodeGroupedTaskView> {
    await this.ensureReady();
    return applyGroupedTaskViewOrderReady(this.getDatabase(), params);
  }

  async getTaskMeta(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
  }): Promise<ACodeTaskMeta | null> {
    await this.ensureReady();
    const row = getTaskRow(this.getDatabase(), params);
    if (!row || row.deleted === 1) {
      return null;
    }
    return rowToMeta(row);
  }
}
