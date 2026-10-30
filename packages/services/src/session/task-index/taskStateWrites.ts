// task 壳状态写路径：seed 基线、unread CAS 清除、归档删除、状态补丁、agent 补丁。
// 原 taskIndexRepo.ts 对应方法的 enqueueWrite 回调体原样迁入，改为接收 sqlite 句柄；
// 调用方（本体）负责 ensureReady 与按 task 的写入串行链。
import type { DatabaseSync } from "node:sqlite";
import type { ACodeTaskMeta } from "@acode/shared";
import type { TaskIndexStatePatch } from "#src/session/task-index/taskIndexRows.js";
import { rowToMeta } from "#src/session/task-index/taskRowMapping.js";
import { getTaskRow, writeRecord } from "#src/session/task-index/taskRecordWrites.js";
import { deleteTaskGroupingReferences } from "#src/session/task-index/taskGroupingMemberships.js";

export function seedTaskMetaIfMissingReady(
  database: DatabaseSync,
  meta: ACodeTaskMeta,
): ACodeTaskMeta {
  const existing = getTaskRow(database, meta);
  if (existing) {
    return rowToMeta(existing);
  }
  return writeRecord(database, {
    meta,
    pinned: false,
    archived: false,
    deleted: false,
    titleOverridden: meta.titleOverridden ?? false,
  });
}

export function clearTaskUnreadIfMatchesReady(
  database: DatabaseSync,
  params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
    expectedUnreadAt: number;
  },
): { meta: ACodeTaskMeta; cleared: boolean } {
  database.exec("BEGIN IMMEDIATE");
  try {
    const row = getTaskRow(database, params);
    if (!row || row.deleted === 1) {
      throw new Error(`task index 中不存在 task: ${params.taskId}`);
    }
    const current = rowToMeta(row);
    if (current.unreadAt !== params.expectedUnreadAt) {
      database.exec("COMMIT");
      return { meta: current, cleared: false };
    }

    const nextMeta: ACodeTaskMeta = {
      ...current,
      unreadAt: undefined,
    };
    // 手机已读请求可能晚于新的终态未读到达。比较和写入必须持有同一
    // SQLite 写事务，否则旧点击会把随后产生的 unreadAt 无条件清掉。
    const persistedMeta = writeRecord(database, {
      meta: nextMeta,
      pinned: row.pinned === 1,
      archived: row.archived === 1,
      deleted: false,
      titleOverridden: row.title_overridden === 1,
      writeUnreadAt: true,
    });
    database.exec("COMMIT");
    return { meta: persistedMeta, cleared: true };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function deleteArchivedTaskReady(
  database: DatabaseSync,
  params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
  },
): ACodeTaskMeta | null {
  database.exec("BEGIN IMMEDIATE");
  try {
    const row = getTaskRow(database, params);
    // 确认框可能停留期间被另一端恢复；归档检查必须与 tombstone 写入同事务，
    // 不能先读后删。已删除/不存在也跳过，避免重试从 CLI seed 后复活。
    if (!row || row.deleted === 1 || row.archived !== 1) {
      database.exec("COMMIT");
      return null;
    }
    const meta = writeRecord(database, {
      meta: rowToMeta(row),
      pinned: row.pinned === 1,
      archived: true,
      deleted: true,
      titleOverridden: row.title_overridden === 1,
    });
    deleteTaskGroupingReferences(database, row.workspace_key, row.task_id);
    database.exec("COMMIT");
    return meta;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function updateTaskStateReady(
  database: DatabaseSync,
  params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
    patch: TaskIndexStatePatch;
  },
): ACodeTaskMeta {
  const deleting = params.patch.deleted === true;
  const requestedUnreadAt = params.patch.unreadAt;
  const allocatingUnreadAt = typeof requestedUnreadAt === "number";
  const mutatingUnreadAt = "unreadAt" in params.patch;
  const transactional = deleting || mutatingUnreadAt;
  if (transactional) {
    database.exec("BEGIN IMMEDIATE");
  }
  try {
    const row = getTaskRow(database, params);
    if (!row || row.deleted === 1) {
      throw new Error(`task index 中不存在 task: ${params.taskId}`);
    }
    const current = rowToMeta(row);
    // 毫秒时间戳可能让同一 task 的两个逻辑未读得到相同版本，
    // 且清除 unreadAt 后只看当前值会再次复用旧版本。必须在 SQLite 写锁内
    // 基于不会随清除重置的持久 watermark 分配严格递增 marker。
    const lastUnreadAt = Math.max(
      row.last_unread_at,
      row.unread_at ?? 0,
      current.unreadAt ?? 0,
    );
    const unreadAt = allocatingUnreadAt
      ? Math.max(requestedUnreadAt, lastUnreadAt + 1)
      : "unreadAt" in params.patch
        ? undefined
        : current.unreadAt;
    const nextMeta: ACodeTaskMeta = {
      ...current,
      title: params.patch.title ?? current.title,
      titleOverridden: params.patch.titleOverridden ?? current.titleOverridden,
      model: params.patch.model ?? current.model,
      updatedAt: params.patch.updatedAt ?? current.updatedAt,
      unreadAt,
      status: params.patch.status ?? current.status,
      lastError: "lastError" in params.patch ? params.patch.lastError : current.lastError,
      target: "target" in params.patch ? params.patch.target : current.target,
    };
    const persistedMeta = writeRecord(database, {
      meta: nextMeta,
      pinned: params.patch.pinned ?? row.pinned === 1,
      archived: params.patch.archived ?? row.archived === 1,
      deleted: params.patch.deleted ?? row.deleted === 1,
      titleOverridden: params.patch.titleOverridden ?? row.title_overridden === 1,
      writeUnreadAt: mutatingUnreadAt,
    });
    if (deleting) {
      // 删除标记和 grouped 引用必须原子提交；否则任一写入失败都会让
      // sessions-index 内容、task 可见性和 SQLite 分组归属长期处于互相矛盾的状态。
      deleteTaskGroupingReferences(database, row.workspace_key, row.task_id);
    }
    if (transactional) database.exec("COMMIT");
    return persistedMeta;
  } catch (error) {
    if (transactional) database.exec("ROLLBACK");
    throw error;
  }
}

export function applyAgentPatchReady(
  database: DatabaseSync,
  params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
    patch: Pick<TaskIndexStatePatch, "title" | "status" | "lastError" | "target" | "updatedAt">;
  },
): ACodeTaskMeta | null {
  const row = getTaskRow(database, params);
  if (!row || row.deleted === 1) {
    return null;
  }
  const current = rowToMeta(row);
  const canAcceptAgentTitle = row.title_overridden !== 1;
  const nextMeta: ACodeTaskMeta = {
    ...current,
    title: canAcceptAgentTitle && params.patch.title ? params.patch.title : current.title,
    titleOverridden: row.title_overridden === 1,
    updatedAt: params.patch.updatedAt ?? current.updatedAt,
    status: params.patch.status ?? current.status,
    lastError: "lastError" in params.patch ? params.patch.lastError : current.lastError,
    target: "target" in params.patch ? params.patch.target : current.target,
  };
  return writeRecord(database, {
    meta: nextMeta,
    pinned: row.pinned === 1,
    archived: row.archived === 1,
    deleted: row.deleted === 1,
    titleOverridden: row.title_overridden === 1,
  });
}
