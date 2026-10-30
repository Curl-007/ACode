// grouped 视图读取：queryGroupedTaskView（join tasks + bootstrap + 顺序补全）与
// queryGroupedTaskViewStructure（原始三张表，不 join tasks）。
// 原 taskIndexRepo.ts 对应公开方法的实现体原样迁入，改为接收 sqlite 句柄。
import type { DatabaseSync } from "node:sqlite";
import { CRON_DEFAULT_GROUP_ID, type ACodeProvider } from "@acode/shared";
import type {
  ACodeGroupedTaskView,
  ACodeGroupedTaskViewNode,
  ACodeGroupedTaskViewQuery,
  ACodeGroupedTaskViewStructure,
  ACodeGroupedTaskViewStructureMember,
  ACodeGroupedTaskViewStructureTopOrder,
  ACodeTaskListItem,
} from "#src/session/acodeTaskListTypes.js";
import type {
  TaskGroupMemberRow,
  TaskGroupRow,
  TaskGroupViewNodeOrderRow,
  TaskGroupWorkspaceBootstrapRow,
  TaskIndexRow,
} from "#src/session/task-index/taskIndexRows.js";
import { rowToTaskListItem } from "#src/session/task-index/taskRowMapping.js";
import {
  compareCronGroupTasks,
  compareGroupTasks,
  compareGroupedNodes,
  normalizeWorkspaceBootstrapScopes,
  normalizeWorkspaceKeys,
  rowToTaskGroup,
  taskNodeKey,
  taskOrderNodeKey,
} from "#src/session/task-index/taskGrouping.js";
import {
  normalizeGroupMemberOrders,
  normalizeGroupedTopNodeOrders,
} from "#src/session/task-index/taskGroupingMemberships.js";
import { bootstrapWorkspaceGroupsForActiveTasks } from "#src/session/task-index/taskGroupBootstrap.js";
import { appendACodeAgentIndexedProviderFilter } from "#src/session/task-index/taskListQueries.js";

export function queryGroupedTaskViewReady(
  database: DatabaseSync,
  params: ACodeGroupedTaskViewQuery & { provider?: ACodeProvider },
): ACodeGroupedTaskView {
  const includeAllWorkspaces = params.includeAllWorkspaces === true;
  const requestedWorkspaceScopes = normalizeWorkspaceBootstrapScopes(params.workspaceScopes);
  const workspaceKeys = normalizeWorkspaceKeys(params.workspaceScopes);
  const activeTaskWhere = [
    "deleted = 0",
    "archived = 0",
    "pinned = 0",
    ...(includeAllWorkspaces
      ? []
      : [`workspace_key IN (${workspaceKeys.map(() => "?").join(", ")})`]),
  ];
  const activeTaskArgs: Array<string | number> = includeAllWorkspaces ? [] : [...workspaceKeys];
  if (params.provider) {
    // grouped 和 workspace 都是 ACode Agent 任务列表入口，必须共享旧 provider
    // 残留过滤口径；否则历史 claude/codex/gemini 索引行会只在 grouped 里冒出来。
    appendACodeAgentIndexedProviderFilter(activeTaskWhere, activeTaskArgs, params.provider);
  }
  const activeTasks =
    !includeAllWorkspaces && workspaceKeys.length === 0
      ? []
      : (database
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
              created_at,
              updated_at,
              unread_at,
              pinned,
              archived,
              deleted,
              title_overridden,
              searchable_text,
              meta_json
            FROM tasks
            WHERE ${activeTaskWhere.join(" AND ")}`,
          )
          .all(...activeTaskArgs) as unknown as TaskIndexRow[]);
  const workspaceScopes = includeAllWorkspaces
    ? normalizeWorkspaceBootstrapScopes(
        activeTasks.map((row) => ({
          workspacePath: row.workspace_path,
          workspaceIdentity: row.workspace_identity ?? undefined,
        })),
      )
    : requestedWorkspaceScopes;
  bootstrapWorkspaceGroupsForActiveTasks(database, {
    scopes: workspaceScopes,
    activeTasks,
  });
  const bootstrapRows = database
    .prepare(
      `SELECT workspace_key, group_id
      FROM task_group_workspace_bootstraps
      WHERE group_id IS NOT NULL`,
    )
    .all() as unknown as TaskGroupWorkspaceBootstrapRow[];
  const bootstrapWorkspaceKeyByGroupId = new Map(
    bootstrapRows
      .filter((row) => row.group_id)
      .map((row) => [row.group_id as string, row.workspace_key]),
  );
  const visibleWorkspaceKeys = new Set(
    includeAllWorkspaces ? activeTasks.map((task) => task.workspace_key) : workspaceKeys,
  );
  const groupRows = database
    .prepare(
      `SELECT
        group_id,
        title,
        color,
        created_at,
        updated_at
      FROM task_groups`,
    )
    .all() as unknown as TaskGroupRow[];
  const groups = groupRows
    .filter((row) => {
      const bootstrapWorkspaceKey = bootstrapWorkspaceKeyByGroupId.get(row.group_id);
      return !bootstrapWorkspaceKey || visibleWorkspaceKeys.has(bootstrapWorkspaceKey);
    })
    .map(rowToTaskGroup);
  const members = database
    .prepare(
      `SELECT
        group_id,
        workspace_key,
        workspace_path,
        workspace_identity,
        task_id,
        sort_order,
        added_at,
        created_at,
        updated_at
      FROM task_group_members`,
    )
    .all() as unknown as TaskGroupMemberRow[];
  const orderRows = database
    .prepare(
      `SELECT
        node_type,
        node_key,
        sort_order,
        created_at,
        updated_at
      FROM task_group_view_node_orders`,
    )
    .all() as unknown as TaskGroupViewNodeOrderRow[];
  const orderByNodeKey = new Map(
    orderRows.map((row) => [`${row.node_type}:${row.node_key}`, row]),
  );
  const memberByTaskKey = new Map(
    members.map((member) => [`${member.workspace_key}\u0000${member.task_id}`, member]),
  );
  const membersByGroupId = new Map<string, TaskGroupMemberRow[]>();
  for (const member of members) {
    const groupMembers = membersByGroupId.get(member.group_id) ?? [];
    groupMembers.push(member);
    membersByGroupId.set(member.group_id, groupMembers);
  }

  const activeTaskByKey = new Map(
    activeTasks.map((row) => [
      `${row.workspace_key}\u0000${row.task_id}`,
      rowToTaskListItem(row, null),
    ]),
  );
  const groupedVisibleTaskKeys = new Set<string>();
  const nodes: ACodeGroupedTaskViewNode[] = groups.map((group) => {
    const groupTasks = (membersByGroupId.get(group.id) ?? [])
      .map((member) => activeTaskByKey.get(`${member.workspace_key}\u0000${member.task_id}`))
      .filter((task): task is ACodeTaskListItem => Boolean(task));
    if (group.id === CRON_DEFAULT_GROUP_ID) {
      // cron 系统分组不走用户手动排序，固定按创建时间倒序展示最新结果。
      groupTasks.sort(compareCronGroupTasks);
    } else {
      normalizeGroupMemberOrders(database, group.id, groupTasks, memberByTaskKey);
      groupTasks.sort((left, right) => compareGroupTasks(left, right, memberByTaskKey));
    }
    for (const task of groupTasks) {
      groupedVisibleTaskKeys.add(taskNodeKey(task));
    }
    const order = orderByNodeKey.get(`group:${group.id}`);
    return {
      type: "group",
      group,
      tasks: groupTasks,
      ...(order ? { sortOrder: order.sort_order } : {}),
    };
  });

  for (const task of activeTaskByKey.values()) {
    const key = taskNodeKey(task);
    if (memberByTaskKey.has(key) || groupedVisibleTaskKeys.has(key)) {
      continue;
    }
    const order = orderByNodeKey.get(`task:${taskOrderNodeKey(task)}`);
    nodes.push({
      type: "task",
      task,
      ...(order ? { sortOrder: order.sort_order } : {}),
    });
  }

  // 首次查询时把当前可见顶层节点全部补齐成用户排序，之后展示只认 sort_order。
  normalizeGroupedTopNodeOrders(database, nodes, orderByNodeKey);
  nodes.sort(compareGroupedNodes);
  return { nodes };
}

export function queryGroupedTaskViewStructureReady(
  database: DatabaseSync,
  params: {
    workspaceScopes: Array<{ workspacePath: string; workspaceIdentity?: string }>;
  },
): ACodeGroupedTaskViewStructure {
  const visibleWorkspaceKeys = new Set(normalizeWorkspaceKeys(params.workspaceScopes));
  const bootstrapRows = database
    .prepare(
      `SELECT workspace_key, group_id
      FROM task_group_workspace_bootstraps
      WHERE group_id IS NOT NULL`,
    )
    .all() as unknown as TaskGroupWorkspaceBootstrapRow[];
  const bootstrapWorkspaceKeyByGroupId = new Map(
    bootstrapRows
      .filter((row) => row.group_id)
      .map((row) => [row.group_id as string, row.workspace_key]),
  );
  const groupRows = database
    .prepare(
      `SELECT
        group_id,
        title,
        color,
        created_at,
        updated_at
      FROM task_groups`,
    )
    .all() as unknown as TaskGroupRow[];
  const groups = groupRows
    .filter((row) => {
      const bootstrapWorkspaceKey = bootstrapWorkspaceKeyByGroupId.get(row.group_id);
      return !bootstrapWorkspaceKey || visibleWorkspaceKeys.has(bootstrapWorkspaceKey);
    })
    .map(rowToTaskGroup);
  const memberRows = database
    .prepare(
      `SELECT
        group_id,
        workspace_key,
        workspace_path,
        workspace_identity,
        task_id,
        sort_order,
        added_at,
        created_at,
        updated_at
      FROM task_group_members`,
    )
    .all() as unknown as TaskGroupMemberRow[];
  const members: ACodeGroupedTaskViewStructureMember[] = memberRows.map((row) => ({
    groupId: row.group_id,
    workspaceKey: row.workspace_key,
    workspacePath: row.workspace_path,
    ...(row.workspace_identity ? { workspaceIdentity: row.workspace_identity } : {}),
    taskId: row.task_id,
    sortOrder: row.sort_order,
    addedAt: row.added_at,
  }));
  const orderRows = database
    .prepare(
      `SELECT
        node_type,
        node_key,
        sort_order,
        created_at,
        updated_at
      FROM task_group_view_node_orders`,
    )
    .all() as unknown as TaskGroupViewNodeOrderRow[];
  const topLevelOrders: ACodeGroupedTaskViewStructureTopOrder[] = [];
  for (const row of orderRows) {
    if (row.node_type === "group") {
      topLevelOrders.push({
        type: "group",
        groupId: row.node_key,
        sortOrder: row.sort_order,
      });
      continue;
    }
    // task node_key = JSON.stringify([workspaceKey, taskId])（NUL 分隔在 sqlite TEXT 会被截断）。
    try {
      const parsed = JSON.parse(row.node_key) as unknown;
      if (
        Array.isArray(parsed) &&
        typeof parsed[0] === "string" &&
        typeof parsed[1] === "string"
      ) {
        topLevelOrders.push({
          type: "task",
          workspaceKey: parsed[0],
          taskId: parsed[1],
          sortOrder: row.sort_order,
        });
      }
    } catch {
      // 历史脏 node_key 跳过：客户端会按 createdAt 补内存序，不致崩溃。
    }
  }
  return { groups, members, topLevelOrders };
}
