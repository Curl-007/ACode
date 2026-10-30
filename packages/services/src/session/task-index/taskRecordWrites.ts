// tasks 表单行读写：getTaskRow 查询与 writeRecord upsert（含 unread CAS 与正文截断策略）。
// 原 taskIndexRepo.ts 私有方法原样迁入，改为接收 sqlite 句柄的独立函数。
import type { DatabaseSync } from "node:sqlite";
import type { ACodeTaskMeta } from "@acode/shared";
import type {
  TaskIndexRow,
  TaskIndexWriteRecord,
} from "#src/session/task-index/taskIndexRows.js";
import { rowToMeta, serializeMetaJson } from "#src/session/task-index/taskRowMapping.js";
import { workspaceKey } from "#src/session/task-index/taskGrouping.js";

// 关键业务逻辑：聊天内容搜索只需要可匹配文本，不需要把完整超长会话无限塞进 sqlite 索引。
// 这里做上限截断，避免长任务把 tasks-index.sqlite 放大到影响启动和列表查询。
const TASK_SEARCH_TEXT_MAX_CHARS = 200_000;

export function getTaskRow(
  database: DatabaseSync,
  params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
  },
): TaskIndexRow | null {
  const row = database
    .prepare(
      `SELECT
        workspace_key,
        workspace_path,
        workspace_identity,
        task_id,
        title,
        task_status,
        provider,
        mode,
        model,
        migration_source,
        forked_from_task_id,
        cron_automation_id,
        off_peak_task_id,
        created_at,
        updated_at,
        unread_at,
        last_unread_at,
        pinned,
        archived,
        deleted,
        title_overridden,
        searchable_text,
        meta_json
      FROM tasks
      WHERE workspace_key = ? AND task_id = ?`,
    )
    .get(workspaceKey(params), params.taskId) as TaskIndexRow | undefined;
  return row ?? null;
}

function isTerminalTaskStatus(status: ACodeTaskMeta["status"]): boolean {
  return status === "completed" || status === "error";
}

export function shouldPreserveNewerTerminalStatus(
  existingMeta: ACodeTaskMeta | null,
  incomingMeta: ACodeTaskMeta,
): boolean {
  if (!existingMeta || !isTerminalTaskStatus(existingMeta.status)) {
    return false;
  }
  if (incomingMeta.status && incomingMeta.status !== "running") {
    return false;
  }
  return existingMeta.updatedAt > incomingMeta.updatedAt;
}

export function writeRecord(database: DatabaseSync, record: TaskIndexWriteRecord): ACodeTaskMeta {
  // searchable_text 传 undefined 表示"不动现有值"。读一次 row 拿到当前值，
  // 否则 ON CONFLICT 时 excluded.searchable_text 会被赋成空字符串，把已索引正文清空。
  const existing =
    record.searchableText === undefined
      ? getTaskRow(database, {
          workspacePath: record.meta.workspacePath,
          workspaceIdentity: record.meta.workspaceIdentity,
          taskId: record.meta.taskId,
        })
      : null;
  const searchableText =
    record.searchableText !== undefined
      ? record.searchableText.slice(0, TASK_SEARCH_TEXT_MAX_CHARS)
      : (existing?.searchable_text ?? "");
  database
    .prepare(
      `INSERT INTO tasks (
        workspace_key,
        workspace_path,
        workspace_identity,
        task_id,
        title,
        task_status,
        provider,
        mode,
        model,
        migration_source,
        forked_from_task_id,
        cron_automation_id,
        off_peak_task_id,
        created_at,
        updated_at,
        unread_at,
        last_unread_at,
        pinned,
        archived,
        deleted,
        title_overridden,
        searchable_text,
        meta_json
      ) VALUES (
        @workspace_key,
        @workspace_path,
        @workspace_identity,
        @task_id,
        @title,
        @task_status,
        @provider,
        @mode,
        @model,
        @migration_source,
        @forked_from_task_id,
        @cron_automation_id,
        @off_peak_task_id,
        @created_at,
        @updated_at,
        @unread_at,
        @last_unread_at,
        @pinned,
        @archived,
        @deleted,
        @title_overridden,
        @searchable_text,
        @meta_json
      )
      ON CONFLICT(workspace_key, task_id) DO UPDATE SET
        workspace_path = excluded.workspace_path,
        workspace_identity = excluded.workspace_identity,
        title = excluded.title,
        task_status = excluded.task_status,
        provider = excluded.provider,
        mode = excluded.mode,
        model = excluded.model,
        migration_source = excluded.migration_source,
        forked_from_task_id = excluded.forked_from_task_id,
        cron_automation_id = excluded.cron_automation_id,
        off_peak_task_id = excluded.off_peak_task_id,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        unread_at = CASE
          WHEN @write_unread_at = 1 THEN excluded.unread_at
          ELSE tasks.unread_at
        END,
        last_unread_at = MAX(
          tasks.last_unread_at,
          COALESCE(tasks.unread_at, 0),
          CASE WHEN @write_unread_at = 1 THEN excluded.last_unread_at ELSE 0 END
        ),
        pinned = excluded.pinned,
        archived = excluded.archived,
        deleted = excluded.deleted,
        title_overridden = excluded.title_overridden,
        searchable_text = excluded.searchable_text,
        meta_json = excluded.meta_json`,
    )
    .run({
      workspace_key: workspaceKey(record.meta),
      workspace_path: record.meta.workspacePath,
      workspace_identity: record.meta.workspaceIdentity ?? null,
      task_id: record.meta.taskId,
      title: record.meta.title,
      task_status: record.meta.status ?? null,
      provider: record.meta.provider ?? null,
      mode: record.meta.mode,
      model: record.meta.model ?? null,
      migration_source: record.meta.migrationSource ?? null,
      forked_from_task_id: record.meta.forkedFromTaskId ?? null,
      // cron automation 身份从 meta 投影到索引列（meta_json 里也保留一份，见 serializeMetaJson）。
      cron_automation_id: record.meta.cronAutomationId ?? null,
      // off-peak 身份同款投影。
      off_peak_task_id: record.meta.offPeakTaskId ?? null,
      created_at: record.meta.createdAt,
      updated_at: record.meta.updatedAt,
      unread_at: record.meta.unreadAt ?? null,
      last_unread_at: record.meta.unreadAt ?? 0,
      write_unread_at: record.writeUnreadAt ? 1 : 0,
      pinned: record.pinned ? 1 : 0,
      archived: record.archived ? 1 : 0,
      deleted: record.deleted ? 1 : 0,
      title_overridden: record.titleOverridden ? 1 : 0,
      searchable_text: searchableText,
      meta_json: serializeMetaJson(record.meta),
    });
  const persisted = getTaskRow(database, record.meta);
  if (!persisted) {
    throw new Error(`task index 写入后缺少 task: ${record.meta.taskId}`);
  }
  return rowToMeta(persisted);
}
