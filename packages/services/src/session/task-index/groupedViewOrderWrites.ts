// grouped 视图排序保存：校验可见性 → 单事务重写 membership 与顶层顺序 → 回包最新视图。
// 原 taskIndexRepo.ts applyGroupedTaskViewOrder 实现体原样迁入，改为接收 sqlite 句柄。
import type { DatabaseSync } from "node:sqlite";
import type { ACodeProvider } from "@acode/shared";
import type {
  ACodeGroupedTaskRef,
  ACodeGroupedTaskView,
  ACodeGroupedTaskViewOrderInput,
  ACodeGroupedTaskViewTopLevelNodeRef,
} from "#src/session/acodeTaskListTypes.js";
import {
  GROUPED_TASK_ORDER_STEP,
  GROUPED_WORKSPACE_BOOTSTRAP_ONCE_KEY,
  normalizeWorkspaceKeys,
  taskOrderNodeKey,
  workspaceKey,
} from "#src/session/task-index/taskGrouping.js";
import { getTaskRow } from "#src/session/task-index/taskRecordWrites.js";
import { queryGroupedTaskViewReady } from "#src/session/task-index/groupedViewQueries.js";

export function applyGroupedTaskViewOrderReady(
  database: DatabaseSync,
  params: ACodeGroupedTaskViewOrderInput & { provider?: ACodeProvider },
): ACodeGroupedTaskView {
  const workspaceKeys = new Set(normalizeWorkspaceKeys(params.workspaceScopes));
  const now = Date.now();

  const groupIds = new Set(
    (
      database.prepare("SELECT group_id FROM task_groups").all() as Array<{
        group_id: string;
      }>
    ).map((row) => row.group_id),
  );
  const validateTaskRef = (task: ACodeGroupedTaskRef): string | null => {
    const key = workspaceKey(task);
    if (!workspaceKeys.has(key)) {
      throw new Error("Grouped task order 包含当前 scope 外的 task");
    }
    const row = getTaskRow(database, task);
    if (!row || row.deleted === 1 || row.archived === 1 || row.pinned === 1) {
      throw new Error("Grouped task order 包含不可见 task");
    }
    if (params.provider && row.provider !== params.provider) {
      // grouped 保存回包之前没有 provider 边界，旧 gemini/codex/claude 排序残留会在保存后重新展示。
      // 带 provider 的 ACode Agent 视图只接受当前 glm task；旧 provider 引用作为不可见遗留数据跳过。
      return null;
    }
    return key;
  };

  const topLevelTaskKeys = new Set<string>();
  const groupedTaskKeys = new Set<string>();
  const visibleTopLevelNodes: ACodeGroupedTaskViewTopLevelNodeRef[] = [];
  const visibleGroups: Array<{ groupId: string; taskRefs: ACodeGroupedTaskRef[] }> = [];
  for (const node of params.topLevelNodes) {
    if (node.type === "group") {
      if (!groupIds.has(node.groupId)) {
        throw new Error("Grouped task order 包含不存在的 group");
      }
      visibleTopLevelNodes.push(node);
      continue;
    }
    const workspaceKey = validateTaskRef(node.task);
    if (!workspaceKey) {
      continue;
    }
    const key = `${workspaceKey}\u0000${node.task.taskId}`;
    topLevelTaskKeys.add(key);
    visibleTopLevelNodes.push(node);
  }
  for (const group of params.groups) {
    if (!groupIds.has(group.groupId)) {
      throw new Error("Grouped task order 包含不存在的 group");
    }
    const visibleTaskRefs: ACodeGroupedTaskRef[] = [];
    for (const taskRef of group.taskRefs) {
      const workspaceKey = validateTaskRef(taskRef);
      if (!workspaceKey) {
        continue;
      }
      const key = `${workspaceKey}\u0000${taskRef.taskId}`;
      if (groupedTaskKeys.has(key)) {
        throw new Error("Grouped task order 不能让同一个 task 进入多个 group");
      }
      groupedTaskKeys.add(key);
      visibleTaskRefs.push(taskRef);
    }
    visibleGroups.push({ groupId: group.groupId, taskRefs: visibleTaskRefs });
  }

  const scopedTaskOrderKeys =
    workspaceKeys.size === 0
      ? []
      : (
          database
            .prepare(
              `SELECT workspace_key, task_id
            FROM tasks
            WHERE workspace_key IN (${[...workspaceKeys].map(() => "?").join(", ")})`,
            )
            .all(...workspaceKeys) as Array<{
            workspace_key: string;
            task_id: string;
          }>
        ).map((row) => `${row.workspace_key}\u0000${row.task_id}`);

  database.exec("BEGIN IMMEDIATE");
  try {
    const markWorkspaceBootstrapDisabled = database.prepare(
      `INSERT INTO task_group_workspace_bootstraps (
        workspace_key,
        group_id,
        created_at,
        updated_at
      ) VALUES (?, NULL, ?, ?)
      ON CONFLICT(workspace_key) DO UPDATE SET
        updated_at = excluded.updated_at`,
    );
    // 用户已经显式保存 grouped 排序时，后续查询不能再执行 workspace 自动初始化。
    // 这里写全局 marker，避免新 workspace 出现后又触发迁移式 workspace group 初始化。
    markWorkspaceBootstrapDisabled.run(GROUPED_WORKSPACE_BOOTSTRAP_ONCE_KEY, now, now);
    const deleteMembership = database.prepare(
      `DELETE FROM task_group_members
      WHERE workspace_key = ? AND task_id = ?`,
    );
    const upsertMembership = database.prepare(
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
    for (const key of topLevelTaskKeys) {
      const [targetWorkspaceKey, taskId] = key.split("\u0000");
      if (!targetWorkspaceKey || !taskId) {
        throw new Error("Grouped task order 顶层 task key 非法");
      }
      deleteMembership.run(targetWorkspaceKey, taskId);
    }
    for (const group of visibleGroups) {
      group.taskRefs.forEach((taskRef, index) => {
        const targetWorkspaceKey = workspaceKey(taskRef);
        upsertMembership.run(
          group.groupId,
          targetWorkspaceKey,
          taskRef.workspacePath,
          taskRef.workspaceIdentity ?? null,
          taskRef.taskId,
          (index + 1) * GROUPED_TASK_ORDER_STEP,
          now,
          now,
          now,
        );
      });
    }

    // 一次提交最终排序，避免菜单/草稿/取消分组等 grouped 视图变更留下部分写入状态。
    database.prepare("DELETE FROM task_group_view_node_orders WHERE node_type = 'group'").run();
    const deleteTaskOrder = database.prepare(
      `DELETE FROM task_group_view_node_orders
      WHERE node_type = 'task' AND (node_key = ? OR node_key = ?)`,
    );
    // 只清理当前 workspace scope 里的 task 排序；否则远端/未展开 workspace 的混排位置会被本次变更误删。
    for (const nodeKey of scopedTaskOrderKeys) {
      const [targetWorkspaceKey, taskId] = nodeKey.split("\u0000");
      if (!targetWorkspaceKey || !taskId) {
        continue;
      }
      deleteTaskOrder.run(JSON.stringify([targetWorkspaceKey, taskId]), targetWorkspaceKey);
    }
    const insertOrder = database.prepare(
      `INSERT INTO task_group_view_node_orders (
        node_type,
        node_key,
        sort_order,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?)`,
    );
    visibleTopLevelNodes.forEach((node, index) => {
      const nodeType = node.type;
      const nodeKey = node.type === "group" ? node.groupId : taskOrderNodeKey(node.task);
      insertOrder.run(nodeType, nodeKey, (index + 1) * GROUPED_TASK_ORDER_STEP, now, now);
    });
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }

  return queryGroupedTaskViewReady(database, {
    workspaceScopes: params.workspaceScopes,
    provider: params.provider,
  });
}
