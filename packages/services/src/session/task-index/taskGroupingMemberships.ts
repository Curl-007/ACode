// 分组成员关系与顶层排序写入：系统分组归属、顺序补全、grouped 引用清理。
// 原 taskIndexRepo.ts 私有方法原样迁入，改为接收 sqlite 句柄的独立函数。
import type { DatabaseSync } from "node:sqlite";
import {
  CRON_DEFAULT_GROUP_ID,
  OFF_PEAK_DEFAULT_GROUP_ID,
  isRemoteWorkspaceIdentity,
  type ACodeTaskMeta,
} from "@acode/shared";
import type {
  ACodeGroupedTaskRef,
  ACodeGroupedTaskViewNode,
  ACodeTaskListItem,
} from "#src/session/acodeTaskListTypes.js";
import type {
  TaskGroupMemberRow,
  TaskGroupViewNodeOrderRow,
} from "#src/session/task-index/taskIndexRows.js";
import {
  GROUPED_TASK_ORDER_STEP,
  groupedTopNodeOrderRef,
  taskNodeKey,
  taskOrderNodeKey,
  workspaceKey,
} from "#src/session/task-index/taskGrouping.js";
import { getTaskRow } from "#src/session/task-index/taskRecordWrites.js";

export function deleteTaskGroupingReferences(
  database: DatabaseSync,
  workspaceKeyValue: string,
  taskId: string,
): void {
  database
    .prepare(
      `DELETE FROM task_group_members
      WHERE workspace_key = ? AND task_id = ?`,
    )
    .run(workspaceKeyValue, taskId);
  database
    .prepare(
      `DELETE FROM task_group_view_node_orders
      WHERE node_type = 'task' AND (node_key = ? OR node_key = ?)`,
    )
    .run(JSON.stringify([workspaceKeyValue, taskId]), workspaceKeyValue);
}

export function getNextGroupedTopSortOrder(database: DatabaseSync): number {
  const row = database
    .prepare(
      `SELECT MIN(sort_order) AS min_sort_order
      FROM task_group_view_node_orders`,
    )
    .get() as { min_sort_order: number | null } | undefined;
  return (row?.min_sort_order ?? GROUPED_TASK_ORDER_STEP * 2) - GROUPED_TASK_ORDER_STEP;
}

export function upsertGroupedTopOrder(
  database: DatabaseSync,
  params: {
    nodeType: "group" | "task";
    nodeKey: string;
    sortOrder: number;
    now: number;
  },
): void {
  database
    .prepare(
      `INSERT INTO task_group_view_node_orders (
        node_type,
        node_key,
        sort_order,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(node_type, node_key) DO UPDATE SET
        sort_order = excluded.sort_order,
        updated_at = excluded.updated_at`,
    )
    .run(params.nodeType, params.nodeKey, params.sortOrder, params.now, params.now);
}

export function normalizeGroupedTopNodeOrders(
  database: DatabaseSync,
  nodes: ACodeGroupedTaskViewNode[],
  orderByNodeKey: Map<string, TaskGroupViewNodeOrderRow>,
): void {
  const missingNodes = nodes
    .filter((node) => !orderByNodeKey.has(groupedTopNodeOrderRef(node).mapKey))
    .sort((left, right) => {
      const leftCreated = left.type === "group" ? left.group.createdAt : left.task.createdAt;
      const rightCreated = right.type === "group" ? right.group.createdAt : right.task.createdAt;
      if (rightCreated !== leftCreated) {
        return rightCreated - leftCreated;
      }
      return groupedTopNodeOrderRef(left).mapKey.localeCompare(
        groupedTopNodeOrderRef(right).mapKey,
      );
    });
  if (missingNodes.length === 0) {
    return;
  }
  const row = database
    .prepare(
      `SELECT MAX(sort_order) AS max_sort_order
      FROM task_group_view_node_orders`,
    )
    .get() as { max_sort_order: number | null } | undefined;
  let nextSortOrder = row?.max_sort_order ?? 0;
  const now = Date.now();
  const insertOrder = database.prepare(
    `INSERT INTO task_group_view_node_orders (
      node_type,
      node_key,
      sort_order,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?)`,
  );
  database.exec("BEGIN IMMEDIATE");
  try {
    for (const node of missingNodes) {
      nextSortOrder += GROUPED_TASK_ORDER_STEP;
      const ref = groupedTopNodeOrderRef(node);
      insertOrder.run(ref.nodeType, ref.nodeKey, nextSortOrder, now, now);
      const rowValue: TaskGroupViewNodeOrderRow = {
        node_type: ref.nodeType,
        node_key: ref.nodeKey,
        sort_order: nextSortOrder,
        created_at: now,
        updated_at: now,
      };
      orderByNodeKey.set(ref.mapKey, rowValue);
      node.sortOrder = nextSortOrder;
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function normalizeGroupMemberOrders(
  database: DatabaseSync,
  groupId: string,
  tasks: ACodeTaskListItem[],
  memberByTaskKey: Map<string, TaskGroupMemberRow>,
): void {
  const missingTasks = tasks
    .filter((task) => {
      const member = memberByTaskKey.get(taskNodeKey(task));
      return Boolean(member) && member?.sort_order === null;
    })
    .sort((left, right) => {
      const leftMember = memberByTaskKey.get(taskNodeKey(left));
      const rightMember = memberByTaskKey.get(taskNodeKey(right));
      const leftAdded = leftMember?.added_at ?? left.createdAt;
      const rightAdded = rightMember?.added_at ?? right.createdAt;
      if (rightAdded !== leftAdded) {
        return rightAdded - leftAdded;
      }
      return taskNodeKey(left).localeCompare(taskNodeKey(right));
    });
  if (missingTasks.length === 0) {
    return;
  }
  const row = database
    .prepare(
      `SELECT MAX(sort_order) AS max_sort_order
      FROM task_group_members
      WHERE group_id = ?`,
    )
    .get(groupId) as { max_sort_order: number | null } | undefined;
  let nextSortOrder = row?.max_sort_order ?? 0;
  const now = Date.now();
  const updateMemberOrder = database.prepare(
    `UPDATE task_group_members
    SET sort_order = ?, updated_at = ?
    WHERE workspace_key = ? AND task_id = ?`,
  );
  database.exec("BEGIN IMMEDIATE");
  try {
    for (const task of missingTasks) {
      const memberKey = taskNodeKey(task);
      const member = memberByTaskKey.get(memberKey);
      if (!member) {
        continue;
      }
      nextSortOrder += GROUPED_TASK_ORDER_STEP;
      updateMemberOrder.run(nextSortOrder, now, member.workspace_key, member.task_id);
      member.sort_order = nextSortOrder;
      member.updated_at = now;
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

/**
 * 把一条 cron session 归入固定的 cron 系统分组（见 CRON_DEFAULT_GROUP_ID）。
 * 幂等：分组行、视图排序、成员关系都用 INSERT OR IGNORE，绝不覆盖用户手动整理的结果。
 * 仅在 session 首次获得 cronAutomationId 时由 syncTaskMeta 调用一次。
 */
export function ensureCronGroupMembership(database: DatabaseSync, meta: ACodeTaskMeta): void {
  ensureSystemGroupMembership(database, meta, {
    groupId: CRON_DEFAULT_GROUP_ID,
    title: "cron",
    color: "blue",
  });
}

/**
 * 把一条闲时会话归入固定的闲时系统分组（见 OFF_PEAK_DEFAULT_GROUP_ID）。
 * 机制与 cron 完全同构；仅在首次获得 offPeakTaskId 时由 syncTaskMeta 调用，
 * 或由 bootstrap 为存量回填补齐。
 */
export function ensureOffPeakGroupMembership(
  database: DatabaseSync,
  meta: Pick<ACodeTaskMeta, "workspacePath" | "workspaceIdentity" | "taskId">,
): void {
  // 闲时任务暂不支持远程 workspace：远程会话即使带标记也不归入闲时系统分组。
  if (meta.workspaceIdentity && isRemoteWorkspaceIdentity(meta.workspaceIdentity)) {
    return;
  }
  ensureSystemGroupMembership(database, meta, {
    groupId: OFF_PEAK_DEFAULT_GROUP_ID,
    title: "off-peak",
    color: "purple",
  });
}

function ensureSystemGroupMembership(
  database: DatabaseSync,
  meta: Pick<ACodeTaskMeta, "workspacePath" | "workspaceIdentity" | "taskId">,
  params: { groupId: string; title: string; color: string },
): void {
  const now = Date.now();
  database
    .prepare(
      `INSERT OR IGNORE INTO task_groups (group_id, title, color, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)`,
    )
    .run(params.groupId, params.title, params.color, now, now);
  // 分组视图排序：不存在才插入（OR IGNORE），避免每次新建系统分组 session 都把该组顺序打乱。
  database
    .prepare(
      `INSERT OR IGNORE INTO task_group_view_node_orders (node_type, node_key, sort_order, created_at, updated_at)
      VALUES ('group', ?, ?, ?, ?)`,
    )
    .run(params.groupId, getNextGroupedTopSortOrder(database), now, now);
  // OR IGNORE：若该 task 已有成员关系（用户已手动分组），保持不动。
  database
    .prepare(
      `INSERT OR IGNORE INTO task_group_members (
        group_id,
        workspace_key,
        workspace_path,
        workspace_identity,
        task_id,
        sort_order,
        added_at,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
    )
    .run(
      params.groupId,
      workspaceKey(meta),
      meta.workspacePath,
      meta.workspaceIdentity ?? null,
      meta.taskId,
      now,
      now,
      now,
    );
}

export function initializeGroupedTaskAtTopReady(
  database: DatabaseSync,
  params: ACodeGroupedTaskRef,
): boolean {
  const row = getTaskRow(database, params);
  if (!row || row.deleted === 1 || row.archived === 1 || row.pinned === 1) {
    return false;
  }
  const existingMember = database
    .prepare(
      `SELECT 1 AS found
      FROM task_group_members
      WHERE workspace_key = ? AND task_id = ?
      LIMIT 1`,
    )
    .get(workspaceKey(params), params.taskId) as { found: number } | undefined;
  const nodeKey = taskOrderNodeKey(params);
  const existingTopOrder = database
    .prepare(
      `SELECT 1 AS found
      FROM task_group_view_node_orders
      WHERE node_type = 'task' AND node_key = ?
      LIMIT 1`,
    )
    .get(nodeKey) as { found: number } | undefined;
  if (existingMember || existingTopOrder) {
    return false;
  }
  const now = Date.now();
  // session 可见与首标题缺行都可能并发触发完整 snapshot 回源。
  // 顶层顺序只能在第一次出现时初始化；重复回源若再次分配最小 sort_order，
  // 较慢完成的旧任务会越过之后创建的新任务，使最终顺序依赖异步完成时序。
  upsertGroupedTopOrder(database, {
    nodeType: "task",
    nodeKey,
    sortOrder: getNextGroupedTopSortOrder(database),
    now,
  });
  return true;
}
