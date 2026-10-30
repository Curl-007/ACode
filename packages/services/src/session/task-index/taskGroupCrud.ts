// task_groups 表的用户分组 CRUD。原 taskIndexRepo.ts 对应公开方法的实现体原样迁入，
// 改为接收 sqlite 句柄；调用方（本体）负责 ensureReady。
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ACodeTaskGroup, ACodeTaskGroupColor } from "#src/session/acodeTaskListTypes.js";
import type { TaskGroupRow } from "#src/session/task-index/taskIndexRows.js";
import {
  DEFAULT_TASK_GROUP_COLOR,
  isTaskGroupColor,
  rowToTaskGroup,
} from "#src/session/task-index/taskGrouping.js";
import {
  getNextGroupedTopSortOrder,
  upsertGroupedTopOrder,
} from "#src/session/task-index/taskGroupingMemberships.js";

export function createTaskGroupReady(
  database: DatabaseSync,
  params?: {
    title?: string;
    color?: ACodeTaskGroupColor;
  },
): ACodeTaskGroup {
  const now = Date.now();
  const id = `task-group-${randomUUID()}`;
  const title = params?.title?.trim() || "New Group";
  const color = params?.color ?? DEFAULT_TASK_GROUP_COLOR;
  database
    .prepare(
      `INSERT INTO task_groups (
        group_id,
        title,
        color,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(id, title, color, now, now);
  // 新建内容必须立即进入用户排序，并插到当前混排列表顶部；
  // 不能依赖 created_at 和已有 sort_order 混排，否则两套坐标量级不同会导致刷新后位置漂移。
  upsertGroupedTopOrder(database, {
    nodeType: "group",
    nodeKey: id,
    sortOrder: getNextGroupedTopSortOrder(database),
    now,
  });
  return {
    id,
    title,
    color,
    createdAt: now,
    updatedAt: now,
  };
}

export function renameTaskGroupReady(
  database: DatabaseSync,
  params: { groupId: string; title: string },
): ACodeTaskGroup {
  const title = params.title.trim() || "New Group";
  const now = Date.now();
  const result = database
    .prepare(
      `UPDATE task_groups
      SET title = ?, updated_at = ?
      WHERE group_id = ?`,
    )
    .run(title, now, params.groupId);
  if (result.changes === 0) {
    throw new Error("Task group 不存在，无法重命名");
  }
  const row = database
    .prepare(
      `SELECT
        group_id,
        title,
        color,
        created_at,
        updated_at
      FROM task_groups
      WHERE group_id = ?`,
    )
    .get(params.groupId) as TaskGroupRow | undefined;
  if (!row) {
    throw new Error("Task group 重命名后读取失败");
  }
  return rowToTaskGroup(row);
}

export function updateTaskGroupColorReady(
  database: DatabaseSync,
  params: {
    groupId: string;
    color: ACodeTaskGroupColor;
  },
): ACodeTaskGroup {
  if (!isTaskGroupColor(params.color)) {
    throw new Error("Task group 颜色无效");
  }
  const now = Date.now();
  const result = database
    .prepare(
      `UPDATE task_groups
      SET color = ?, updated_at = ?
      WHERE group_id = ?`,
    )
    .run(params.color, now, params.groupId);
  if (result.changes === 0) {
    throw new Error("Task group 不存在，无法更新颜色");
  }
  const row = database
    .prepare(
      `SELECT
        group_id,
        title,
        color,
        created_at,
        updated_at
      FROM task_groups
      WHERE group_id = ?`,
    )
    .get(params.groupId) as TaskGroupRow | undefined;
  if (!row) {
    throw new Error("Task group 更新颜色后读取失败");
  }
  return rowToTaskGroup(row);
}

export function deleteTaskGroupReady(database: DatabaseSync, params: { groupId: string }): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = database
      .prepare("DELETE FROM task_groups WHERE group_id = ?")
      .run(params.groupId);
    if (result.changes === 0) {
      throw new Error("Task group 不存在，无法删除");
    }
    database
      .prepare(
        `DELETE FROM task_group_view_node_orders
        WHERE node_type = 'group' AND node_key = ?`,
      )
      .run(params.groupId);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
