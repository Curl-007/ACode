import type { WorkspacePurpose, ACodeTaskMeta } from "@acode/shared";

export type ACodeTaskListKind = "pinned" | "archived" | "timeline" | "active";
export type ACodeTaskListSortBy = "created" | "updated";

export interface ACodeTaskListWorkspaceScope {
  workspacePath: string;
  workspaceIdentity?: string;
  workspacePurpose?: WorkspacePurpose;
}

export interface ACodeTaskListQuery {
  kind: ACodeTaskListKind;
  workspaceScopes: ACodeTaskListWorkspaceScope[];
  sortBy: ACodeTaskListSortBy;
  search?: string;
  limit?: number;
}

export type ACodeTaskListItem = ACodeTaskMeta & {
  searchSnippet?: string;
  searchSnippets?: string[];
};

export interface ACodeTaskListResult {
  items: ACodeTaskListItem[];
  total: number;
  hasMore: boolean;
}

export type ACodeTaskGroupColor =
  | "gray"
  | "red"
  | "orange"
  | "yellow"
  | "green"
  | "blue"
  | "purple";

export interface ACodeTaskGroup {
  id: string;
  title: string;
  color: ACodeTaskGroupColor;
  createdAt: number;
  updatedAt: number;
}

export interface ACodeGroupedTaskRef {
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
}

export type ACodeGroupedTaskViewTopLevelNodeRef =
  | { type: "group"; groupId: string }
  | { type: "task"; task: ACodeGroupedTaskRef };

export type ACodeGroupedTaskViewNode =
  | {
      type: "group";
      group: ACodeTaskGroup;
      tasks: ACodeTaskListItem[];
      sortOrder?: number;
    }
  | {
      type: "task";
      task: ACodeTaskListItem;
      sortOrder?: number;
    };

export interface ACodeGroupedTaskView {
  nodes: ACodeGroupedTaskViewNode[];
}

export interface ACodeGroupedTaskViewQuery {
  workspaceScopes: ACodeTaskListWorkspaceScope[];
  includeAllWorkspaces?: boolean;
}

// ── grouped 原始结构（不 join tasks 表）──
// grouped 视图的任务数据源迁到 sessions-index 后，服务端只提供分组结构
// （task_groups / task_group_members / task_group_view_node_orders），
// 由客户端与 sessions-index 会话做 join。

/** 组成员引用（不含任务 meta；task 内容由 sessions-index 提供）。 */
export interface ACodeGroupedTaskViewStructureMember {
  groupId: string;
  /** 服务端口径 workspaceKey（resolveWorkspaceKey：identity ?? path），join 匹配键。 */
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
  /** null = 尚未落 sort_order（新加入组）；客户端按 addedAt 降序补内存序。 */
  sortOrder: number | null;
  addedAt: number;
}

/** 顶层节点排序（task_group_view_node_orders，node_key 已解析为结构化引用）。 */
export type ACodeGroupedTaskViewStructureTopOrder =
  | { type: "group"; groupId: string; sortOrder: number }
  | { type: "task"; workspaceKey: string; taskId: string; sortOrder: number };

export interface ACodeGroupedTaskViewStructure {
  /** 已按 workspaceScopes 可见性过滤的 group（bootstrap workspace group 只在其 workspace 可见）。 */
  groups: ACodeTaskGroup[];
  /** 全量组成员（含不可见 group 的成员——顶层排除规则需要全量判断）。 */
  members: ACodeGroupedTaskViewStructureMember[];
  topLevelOrders: ACodeGroupedTaskViewStructureTopOrder[];
}

export interface ACodeGroupedTaskViewOrderInput {
  workspaceScopes: ACodeTaskListWorkspaceScope[];
  topLevelNodes: ACodeGroupedTaskViewTopLevelNodeRef[];
  groups: Array<{
    groupId: string;
    taskRefs: ACodeGroupedTaskRef[];
  }>;
}

export interface ACodeWorkspaceEventSubscriptionParams {
  workspacePath: string;
  workspaceIdentity?: string;
}
