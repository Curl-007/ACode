// grouped workspace 一次性 bootstrap、off-peak 存量回填与已删除 task 的分组引用收敛。
// 原 taskIndexRepo.ts 初始化路径相关私有方法原样迁入，改为接收 sqlite 句柄；
// 全部由本体 initialize / 查询路径在连接就绪后调用。
import type { DatabaseSync } from "node:sqlite";
import { isRemoteWorkspaceIdentity } from "@acode/shared";
import type {
  TaskIndexRow,
  WorkspaceBootstrapScope,
} from "#src/session/task-index/taskIndexRows.js";
import {
  GROUPED_TASK_ORDER_STEP,
  GROUPED_WORKSPACE_BOOTSTRAP_ONCE_KEY,
  taskOrderNodeKey,
  workspaceGroupColor,
  workspaceGroupId,
  workspaceGroupTitle,
} from "#src/session/task-index/taskGrouping.js";
import {
  deleteTaskGroupingReferences,
  ensureOffPeakGroupMembership,
} from "#src/session/task-index/taskGroupingMemberships.js";

/**
 * 存量回填（幂等，每次 bootstrap 自愈）：打点上线前产生的 off-peak 会话行没有
 * offPeakTaskId。off_peak_tasks 与 tasks 同库（tasks-index.sqlite），按 session 绑定
 * join 只补投影列——rowToMeta 以列兜底即可生效，下次 syncTaskMeta 会自动回填 meta_json。
 * 全新安装时 off_peak_tasks 可能尚未由 OffPeakTaskRepo 建表，需 guard。
 */
export function backfillOffPeakTaskMarkers(database: DatabaseSync): void {
  const hasOffPeakTable = database
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'off_peak_tasks'`)
    .get();
  if (!hasOffPeakTable) {
    return;
  }
  database
    .prepare(
      `UPDATE tasks SET off_peak_task_id = (
        SELECT o.off_peak_task_id FROM off_peak_tasks o
        WHERE o.session_id = tasks.task_id AND o.workspace_key = tasks.workspace_key
      )
      WHERE off_peak_task_id IS NULL
        AND EXISTS (
          SELECT 1 FROM off_peak_tasks o
          WHERE o.session_id = tasks.task_id AND o.workspace_key = tasks.workspace_key
        )`,
    )
    .run();
}

/**
 * 成员关系回填（幂等，每次 bootstrap 自愈）：历史回填只补了 off_peak_task_id
 * 投影列，syncTaskMeta 的"首次获得标记"钩子对这些存量永远不会再触发（existing 已带
 * 标记），必须在 bootstrap 里补一次系统分组归属。OR IGNORE 保证用户手动整理不被覆盖，
 * 也保证重复执行零副作用；无标记行时不创建空组（从未用过闲时的用户不会看到组）。
 */
export function backfillOffPeakGroupMemberships(database: DatabaseSync): void {
  const rows = database
    .prepare(
      `SELECT workspace_key, workspace_path, workspace_identity, task_id FROM tasks
       WHERE off_peak_task_id IS NOT NULL AND deleted = 0`,
    )
    .all() as Array<{
    workspace_key: string;
    workspace_path: string;
    workspace_identity: string | null;
    task_id: string;
  }>;
  for (const row of rows) {
    // 闲时任务暂不支持远程 workspace：远程存量行不归组。历史行的 workspace_identity
    // 列可能缺失，remote 判定必须看主键 workspace_key——否则 ensureSystemGroupMembership
    // 会用 workspacePath 重算出本地 key，把成员关系串写到同路径本地 workspace 上。
    if (isRemoteWorkspaceIdentity(row.workspace_key)) {
      continue;
    }
    ensureOffPeakGroupMembership(database, {
      workspacePath: row.workspace_path,
      workspaceIdentity: row.workspace_identity ?? undefined,
      taskId: row.task_id,
    });
  }
}

export function cleanupDeletedTaskGroupingReferences(database: DatabaseSync): void {
  const rows = database
    .prepare(
      `SELECT workspace_key, task_id
      FROM tasks
      WHERE deleted = 1`,
    )
    .all() as Array<{ workspace_key: string; task_id: string }>;
  if (rows.length === 0) {
    return;
  }

  database.exec("BEGIN IMMEDIATE");
  try {
    // 旧版本删除 task 时只写 tasks.deleted，membership/顶层顺序仍会被
    // sessions-index 历史摘要重新投影；初始化时幂等收敛已经落盘的脏引用。
    for (const row of rows) {
      deleteTaskGroupingReferences(database, row.workspace_key, row.task_id);
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function hasGroupedWorkspaceBootstrapRunSync(database: DatabaseSync): boolean {
  const row = database
    .prepare(
      `SELECT 1 AS found
      FROM task_group_workspace_bootstraps
      LIMIT 1`,
    )
    .get() as { found: number } | undefined;
  return Boolean(row);
}

export function bootstrapWorkspaceGroupsForActiveTasks(
  database: DatabaseSync,
  params: {
    scopes: WorkspaceBootstrapScope[];
    activeTasks: TaskIndexRow[];
  },
): void {
  if (params.scopes.length === 0 || hasGroupedWorkspaceBootstrapRunSync(database)) {
    return;
  }
  const candidateRowsByWorkspaceKey = new Map<string, TaskIndexRow[]>();
  for (const row of params.activeTasks) {
    const rows = candidateRowsByWorkspaceKey.get(row.workspace_key) ?? [];
    rows.push(row);
    candidateRowsByWorkspaceKey.set(row.workspace_key, rows);
  }
  const now = Date.now();
  const markBootstrapRun = database.prepare(
    `INSERT INTO task_group_workspace_bootstraps (
      workspace_key,
      group_id,
      created_at,
      updated_at
    ) VALUES (?, NULL, ?, ?)
    ON CONFLICT(workspace_key) DO UPDATE SET
      updated_at = excluded.updated_at`,
  );
  if (candidateRowsByWorkspaceKey.size === 0) {
    markBootstrapRun.run(GROUPED_WORKSPACE_BOOTSTRAP_ONCE_KEY, now, now);
    return;
  }
  const existingGroupOrderKeys = new Set(
    (
      database
        .prepare(
          `SELECT node_key
          FROM task_group_view_node_orders
          WHERE node_type = 'group'`,
        )
        .all() as Array<{ node_key: string }>
    ).map((row) => row.node_key),
  );
  const maxOrderRow = database
    .prepare(
      `SELECT MAX(sort_order) AS max_sort_order
      FROM task_group_view_node_orders`,
    )
    .get() as { max_sort_order: number | null } | undefined;
  let nextGroupSortOrder = maxOrderRow?.max_sort_order ?? 0;
  const insertGroup = database.prepare(
    `INSERT OR IGNORE INTO task_groups (
      group_id,
      title,
      color,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?)`,
  );
  const insertGroupOrder = database.prepare(
    `INSERT OR IGNORE INTO task_group_view_node_orders (
      node_type,
      node_key,
      sort_order,
      created_at,
      updated_at
    ) VALUES ('group', ?, ?, ?, ?)`,
  );
  const deleteExistingMember = database.prepare(
    `DELETE FROM task_group_members
    WHERE workspace_key = ? AND task_id = ?`,
  );
  const insertMember = database.prepare(
    `INSERT INTO task_group_members (
      group_id,
      workspace_key,
      workspace_path,
      workspace_identity,
      task_id,
      sort_order,
      added_at,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(workspace_key, task_id) DO UPDATE SET
      group_id = excluded.group_id,
      workspace_path = excluded.workspace_path,
      workspace_identity = excluded.workspace_identity,
      sort_order = excluded.sort_order,
      updated_at = excluded.updated_at`,
  );
  const deleteTopTaskOrder = database.prepare(
    `DELETE FROM task_group_view_node_orders
    WHERE node_type = 'task' AND node_key = ?`,
  );
  const insertBootstrap = database.prepare(
    `INSERT INTO task_group_workspace_bootstraps (
      workspace_key,
      group_id,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?)
    ON CONFLICT(workspace_key) DO UPDATE SET
      group_id = excluded.group_id,
      updated_at = excluded.updated_at`,
  );
  const deleteEmptyGroups = database.prepare(
    `DELETE FROM task_groups
    WHERE group_id NOT IN (
      SELECT DISTINCT group_id
      FROM task_group_members
    )`,
  );
  const deleteDanglingGroupOrders = database.prepare(
    `DELETE FROM task_group_view_node_orders
    WHERE node_type = 'group'
      AND node_key NOT IN (
        SELECT group_id
        FROM task_groups
      )`,
  );

  database.exec("BEGIN IMMEDIATE");
  try {
    // grouped workspace bootstrap 是迁移期的一次性初始化。记录全局 marker，
    // 避免后续新 workspace 出现时再次自动生成 workspace group。
    markBootstrapRun.run(GROUPED_WORKSPACE_BOOTSTRAP_ONCE_KEY, now, now);
    for (const scope of params.scopes) {
      const rows = candidateRowsByWorkspaceKey.get(scope.workspaceKey);
      if (!rows) {
        continue;
      }
      // 初始化按没有分组功能时的 workspace 视角重建 membership，
      // 旧 group 不参与归属判断，避免历史分组把 task 留在非 workspace group 里。
      const groupedRows = rows.sort((left, right) => {
        if (right.updated_at !== left.updated_at) {
          return right.updated_at - left.updated_at;
        }
        if (right.created_at !== left.created_at) {
          return right.created_at - left.created_at;
        }
        return left.task_id.localeCompare(right.task_id);
      });
      if (groupedRows.length === 0) {
        continue;
      }
      const groupId = workspaceGroupId(scope.workspaceKey);
      const title = workspaceGroupTitle(scope.workspacePath);
      insertGroup.run(groupId, title, workspaceGroupColor(scope.workspaceKey), now, now);
      if (!existingGroupOrderKeys.has(groupId)) {
        nextGroupSortOrder += GROUPED_TASK_ORDER_STEP;
        insertGroupOrder.run(groupId, nextGroupSortOrder, now, now);
        existingGroupOrderKeys.add(groupId);
      }
      groupedRows.forEach((row, index) => {
        deleteExistingMember.run(row.workspace_key, row.task_id);
        insertMember.run(
          groupId,
          row.workspace_key,
          row.workspace_path,
          row.workspace_identity,
          row.task_id,
          (index + 1) * GROUPED_TASK_ORDER_STEP,
          now,
          now,
          now,
        );
        deleteTopTaskOrder.run(
          taskOrderNodeKey({
            workspacePath: row.workspace_path,
            workspaceIdentity: row.workspace_identity ?? undefined,
            taskId: row.task_id,
          }),
        );
      });
      insertBootstrap.run(scope.workspaceKey, groupId, now, now);
    }
    deleteEmptyGroups.run();
    deleteDanglingGroupOrders.run();
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
