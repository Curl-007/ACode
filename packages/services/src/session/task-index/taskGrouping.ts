// 分组视图（grouped task view）的纯函数：workspace key 归一化、分组键、颜色、排序比较。
// 原 taskIndexRepo.ts 内部函数原样迁入；不接触 sqlite 句柄，全部可按纯函数测试。
import { createHash } from "node:crypto";
import { resolveWorkspaceKey } from "@acode/shared";
import type {
  ACodeGroupedTaskViewNode,
  ACodeTaskGroup,
  ACodeTaskGroupColor,
  ACodeTaskListItem,
} from "#src/session/acodeTaskListTypes.js";
import type {
  TaskGroupMemberRow,
  TaskGroupRow,
  WorkspaceBootstrapScope,
} from "#src/session/task-index/taskIndexRows.js";

export const GROUPED_TASK_ORDER_STEP = 1000;
export const GROUPED_WORKSPACE_BOOTSTRAP_ONCE_KEY =
  "__acode_internal_grouped_workspace_bootstrap_once__";
export const DEFAULT_TASK_GROUP_COLOR: ACodeTaskGroupColor = "gray";
const WORKSPACE_BOOTSTRAP_TASK_GROUP_COLORS = [
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
] satisfies ACodeTaskGroupColor[];

export function workspaceKey(params: {
  workspacePath: string;
  workspaceIdentity?: string;
}): string {
  return resolveWorkspaceKey(params);
}

export function normalizeWorkspaceKeys(
  scopes: Array<{ workspacePath: string; workspaceIdentity?: string }>,
): string[] {
  return [
    ...new Set(scopes.map((scope) => workspaceKey(scope)).filter((key) => key.trim().length > 0)),
  ].sort((left, right) => left.localeCompare(right));
}

export function normalizeWorkspaceBootstrapScopes(
  scopes: Array<{
    workspacePath: string;
    workspaceIdentity?: string;
    workspacePurpose?: import("@acode/shared").WorkspacePurpose;
  }>,
): WorkspaceBootstrapScope[] {
  const seen = new Set<string>();
  const result: WorkspaceBootstrapScope[] = [];
  for (const scope of scopes) {
    if (scope.workspacePurpose === "conversation") {
      // 对话 backing workspace 只是 cwd，不是项目；迁移期不能为它生成同名项目分组。
      continue;
    }
    const key = workspaceKey(scope);
    if (!key.trim() || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push({
      workspaceKey: key,
      workspacePath: scope.workspacePath,
      workspaceIdentity: scope.workspaceIdentity,
    });
  }
  return result;
}

export function isTaskGroupColor(value: string): value is ACodeTaskGroupColor {
  return (
    value === "gray" ||
    value === "red" ||
    value === "orange" ||
    value === "yellow" ||
    value === "green" ||
    value === "blue" ||
    value === "purple"
  );
}

export function rowToTaskGroup(row: TaskGroupRow): ACodeTaskGroup {
  return {
    id: row.group_id,
    title: row.title,
    color: isTaskGroupColor(row.color) ? row.color : DEFAULT_TASK_GROUP_COLOR,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function workspaceGroupId(targetWorkspaceKey: string): string {
  const hash = createHash("sha256").update(targetWorkspaceKey).digest("hex");
  return `workspace-group-${hash.slice(0, 24)}`;
}

export function workspaceGroupTitle(workspacePath: string): string {
  const normalized = workspacePath.replace(/[\\/]+$/u, "");
  const leaf = normalized.split(/[\\/]/u).filter(Boolean).at(-1);
  return leaf?.trim() || normalized.trim() || "Workspace";
}

export function workspaceGroupColor(targetWorkspaceKey: string): ACodeTaskGroupColor {
  const hash = createHash("sha256").update(targetWorkspaceKey).digest();
  const colorIndex = hash.readUInt8(0) % WORKSPACE_BOOTSTRAP_TASK_GROUP_COLORS.length;
  return WORKSPACE_BOOTSTRAP_TASK_GROUP_COLORS[colorIndex] ?? DEFAULT_TASK_GROUP_COLOR;
}

export function taskNodeKey(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
}): string {
  return `${workspaceKey(params)}\u0000${params.taskId}`;
}

export function taskOrderNodeKey(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
}): string {
  // task_group_view_node_orders.node_key 不能使用 "\u0000" 分隔；
  // node:sqlite 读 TEXT 时会截断 NUL 后面的 taskId，导致 grouped 视图排序写入后查询匹配不上。
  return JSON.stringify([workspaceKey(params), params.taskId]);
}

export function groupedTopNodeOrderRef(node: ACodeGroupedTaskViewNode): {
  nodeType: "group" | "task";
  nodeKey: string;
  mapKey: string;
} {
  if (node.type === "group") {
    return {
      nodeType: "group",
      nodeKey: node.group.id,
      mapKey: `group:${node.group.id}`,
    };
  }
  const nodeKey = taskOrderNodeKey(node.task);
  return {
    nodeType: "task",
    nodeKey,
    mapKey: `task:${nodeKey}`,
  };
}

export function compareGroupedNodes(
  left: ACodeGroupedTaskViewNode,
  right: ACodeGroupedTaskViewNode,
): number {
  const leftOrder = left.sortOrder ?? 0;
  const rightOrder = right.sortOrder ?? 0;
  if (leftOrder !== rightOrder) {
    return leftOrder - rightOrder;
  }
  return groupedTopNodeOrderRef(left).mapKey.localeCompare(groupedTopNodeOrderRef(right).mapKey);
}

export function compareCronGroupTasks(left: ACodeTaskListItem, right: ACodeTaskListItem): number {
  // cron 系统分组固定按创建时间倒序：最新的定时任务结果始终展示在最前面，
  // 不参与用户手动排序（sort_order），新 session 到达时天然排到组顶部。
  if (right.createdAt !== left.createdAt) {
    return right.createdAt - left.createdAt;
  }
  return taskNodeKey(right).localeCompare(taskNodeKey(left));
}

export function compareGroupTasks(
  left: ACodeTaskListItem,
  right: ACodeTaskListItem,
  memberByTaskKey: Map<string, TaskGroupMemberRow>,
): number {
  const leftMember = memberByTaskKey.get(taskNodeKey(left));
  const rightMember = memberByTaskKey.get(taskNodeKey(right));
  const leftOrder = leftMember?.sort_order ?? 0;
  const rightOrder = rightMember?.sort_order ?? 0;
  if (leftOrder !== rightOrder) {
    return leftOrder - rightOrder;
  }
  return taskNodeKey(left).localeCompare(taskNodeKey(right));
}
