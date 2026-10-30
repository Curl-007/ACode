/* off-peak 任务管理 CRUD 的 SQL 实现：创建入队、列表联查、删除、History 隐藏
   与各类计数预检。原为 OffPeakTaskRepo 的方法体，拆分后由本体包装方法委托调用。 */
import { randomUUID } from "node:crypto";
import {
  resolveWorkspaceKey,
  type ACodeOffPeakTask,
  type ACodeOffPeakTaskCreateParams,
} from "@acode/shared";
import type { DatabaseSyncInstance } from "#src/session/off-peak/offPeakTaskDatabase.js";
import {
  TERMINAL_SQL_LIST,
  readOffPeakTaskRow,
  rowToTask,
  serializeOffPeakModelSelection,
  type OffPeakTaskRow,
} from "#src/session/off-peak/offPeakTaskRows.js";

/** create 的附加写入选项（原 Repo.create 的 options 参数）。 */
export interface OffPeakTaskInsertOptions {
  /** 测试注入用；缺省 Date.now()。 */
  now?: number;
  /** service 层先取号后落库时外部指定主键（取号需先有 task_id）；缺省内部生成。 */
  offPeakTaskId?: string;
  serverTicketId?: string;
  queuePosition?: number;
  registeredAt?: number;
  /** 取号即 ready（低峰空闲时服务端可直接晋级）时随建随派。 */
  schedulable?: boolean;
}

export interface OffPeakTaskListScope {
  workspacePath?: string;
  workspaceIdentity?: string;
}

function hasTasksIndexTable(db: DatabaseSyncInstance): boolean {
  return Boolean(
    db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tasks'`).get(),
  );
}

/** 创建即入队（status=queued）的 INSERT；取号结果经 options 一并写入。 */
export function insertOffPeakTask(
  db: DatabaseSyncInstance,
  params: ACodeOffPeakTaskCreateParams,
  options?: OffPeakTaskInsertOptions,
): ACodeOffPeakTask {
  const now = options?.now ?? Date.now();
  const offPeakTaskId = options?.offPeakTaskId ?? `offpeak-${randomUUID()}`;
  const workspaceKey = resolveWorkspaceKey({
    workspacePath: params.workspacePath,
    workspaceIdentity: params.workspaceIdentity,
  });
  db.prepare(
    `INSERT INTO off_peak_tasks (
      off_peak_task_id, server_ticket_id, title, conversation_id, session_id,
      prompt, permission_mode, model, thought_level, model_selection,
      workspace_key, workspace_path, workspace_identity,
      status, queued_at, registered_at, schedulable, queue_position,
      claim_running, attempt_count, created_at, updated_at
    ) VALUES (
      @off_peak_task_id, @server_ticket_id, @title, NULL, @session_id,
      @prompt, @permission_mode, @model, @thought_level, @model_selection,
      @workspace_key, @workspace_path, @workspace_identity,
      'queued', @queued_at, @registered_at, @schedulable, @queue_position,
      0, 0, @now, @now
    )`,
  ).run({
    off_peak_task_id: offPeakTaskId,
    server_ticket_id: options?.serverTicketId ?? null,
    title: params.title,
    // 会话内创建绑定当前会话；conversation_id 仍等首跑回填（非空 = 已跑过）。
    session_id: params.boundSessionId ?? null,
    prompt: params.prompt,
    permission_mode: params.permissionMode,
    model: null,
    thought_level: null,
    model_selection: serializeOffPeakModelSelection(params.modelSelection),
    workspace_key: workspaceKey,
    workspace_path: params.workspacePath,
    workspace_identity: params.workspaceIdentity ?? null,
    queued_at: now,
    registered_at: options?.registeredAt ?? null,
    schedulable: options?.schedulable ? 1 : 0,
    queue_position: options?.queuePosition ?? null,
    now,
  });
  return rowToTask(readOffPeakTaskRow(db, offPeakTaskId)!);
}

export function listOffPeakTasks(
  db: DatabaseSyncInstance,
  scope?: OffPeakTaskListScope,
): ACodeOffPeakTask[] {
  const workspaceKey = scope?.workspacePath
    ? resolveWorkspaceKey({
        workspacePath: scope.workspacePath,
        workspaceIdentity: scope.workspaceIdentity,
      })
    : null;
  // 绑定会话标题联查 tasks-index 同库 tasks 表（卡片展示）；独立库（测试/迁移前）无该表则不联。
  const withSessionTitle = hasTasksIndexTable(db);
  const rows = db
    .prepare(
      withSessionTitle
        ? `SELECT t.*, s.title AS session_title FROM off_peak_tasks t
          LEFT JOIN tasks s ON s.workspace_key = t.workspace_key AND s.task_id = t.session_id
          WHERE (@workspace_key IS NULL OR t.workspace_key = @workspace_key)
          ORDER BY t.created_at DESC`
        : `SELECT * FROM off_peak_tasks
          WHERE (@workspace_key IS NULL OR workspace_key = @workspace_key)
          ORDER BY created_at DESC`,
    )
    .all({ workspace_key: workspaceKey }) as unknown as OffPeakTaskRow[];
  return rows.map(rowToTask);
}

/** 卡片 Delete 的删行（任何状态均可删）。 */
export function deleteOffPeakTask(db: DatabaseSyncInstance, offPeakTaskId: string): void {
  db.prepare(`DELETE FROM off_peak_tasks WHERE off_peak_task_id = ?`).run(offPeakTaskId);
}

/**
 * 仅隐藏 History 行：任务必须已经实际启动；重复调用幂等。
 * 不修改状态、session、started/ended/filesChanged 或服务端核销字段。
 */
export function markOffPeakHistoryDeleted(
  db: DatabaseSyncInstance,
  offPeakTaskId: string,
  options?: { now?: number },
): ACodeOffPeakTask | null {
  const row = readOffPeakTaskRow(db, offPeakTaskId);
  if (!row || row.started_at === null) return row ? rowToTask(row) : null;
  if (row.history_deleted_at !== null) return rowToTask(row);
  const now = options?.now ?? Date.now();
  db.prepare(
    `UPDATE off_peak_tasks
    SET history_deleted_at = @now, updated_at = @now
    WHERE off_peak_task_id = @id AND started_at IS NOT NULL`,
  ).run({ id: offPeakTaskId, now });
  return rowToTask(readOffPeakTaskRow(db, offPeakTaskId)!);
}

/** 创建上限的本地预判用（权威是服务端取号 429/3103）。 */
export function countNonTerminalOffPeakTasks(db: DatabaseSyncInstance): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM off_peak_tasks WHERE status NOT IN (${TERMINAL_SQL_LIST})`)
    .get() as { n: number };
  return row.n;
}

/** 本会话是否已有未终态绑定任务（创建前预检；索引 idx_off_peak_bound_active 同条件）。 */
export function hasActiveBoundOffPeakTask(
  db: DatabaseSyncInstance,
  workspaceKey: string,
  sessionId: string,
): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS hit FROM off_peak_tasks
       WHERE workspace_key = @workspace_key AND session_id = @session_id
         AND status NOT IN (${TERMINAL_SQL_LIST})
       LIMIT 1`,
    )
    .get({ workspace_key: workspaceKey, session_id: sessionId }) as { hit: number } | undefined;
  return row !== undefined;
}

/** 执行中计数：keep-awake powerSaveBlocker 判据。 */
export function countActiveOffPeakTasks(db: DatabaseSyncInstance): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM off_peak_tasks WHERE status = 'running'`)
    .get() as { n: number };
  return row.n;
}
