// 定期归档扫描：把超过 N 天未更新、未读、未 pin 的已完成 task 批量置 archived。
// 原 taskIndexRepo.ts archiveStaleTasks 实现体原样迁入，改为接收 sqlite 句柄。
import type { DatabaseSync } from "node:sqlite";
import type { ACodeProvider, ACodeTaskMeta } from "@acode/shared";
import type { TaskIndexRow } from "#src/session/task-index/taskIndexRows.js";
import { rowToMeta } from "#src/session/task-index/taskRowMapping.js";
import { workspaceKey } from "#src/session/task-index/taskGrouping.js";
import { appendACodeAgentIndexedProviderFilter } from "#src/session/task-index/taskListQueries.js";

export function archiveStaleTasksReady(
  database: DatabaseSync,
  params: {
    workspacePath: string;
    workspaceIdentity?: string;
    olderThanDays: number;
    provider?: ACodeProvider;
  },
): ACodeTaskMeta[] {
  const normalizedDays = Math.max(1, Math.floor(params.olderThanDays));
  const cutoff = Date.now() - normalizedDays * 24 * 60 * 60 * 1000;
  const where = [
    "workspace_key = ?",
    "deleted = 0",
    "archived = 0",
    "pinned = 0",
    "unread_at IS NULL",
    "updated_at < ?",
    "task_status = 'completed'",
  ];
  const args: Array<string | number> = [workspaceKey(params), cutoff];
  if (params.provider) {
    appendACodeAgentIndexedProviderFilter(where, args, params.provider);
  }
  const rows = database
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
      WHERE ${where.join(" AND ")}
      ORDER BY updated_at DESC, created_at DESC, task_id DESC`,
    )
    .all(...args) as unknown as TaskIndexRow[];
  if (rows.length === 0) {
    return [];
  }

  const archiveTask = database.prepare(
    `UPDATE tasks
    SET archived = 1
    WHERE workspace_key = ? AND task_id = ?`,
  );
  database.exec("BEGIN IMMEDIATE");
  try {
    for (const row of rows) {
      archiveTask.run(row.workspace_key, row.task_id);
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return rows.map(rowToMeta);
}
