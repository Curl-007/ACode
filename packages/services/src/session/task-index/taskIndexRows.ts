// task 索引派生库的 sqlite 行形状与写入参数类型。
// 类型由 taskIndexRepo 本体与 ./task-index/ 各叶子共享；本文件只承载类型，不产生运行时代码。
import type { ACodeTaskMeta } from "@acode/shared";

export interface TaskIndexRow {
  workspace_key: string;
  workspace_path: string;
  workspace_identity: string | null;
  task_id: string;
  title: string;
  task_status: string | null;
  provider: string | null;
  mode: string;
  model: string | null;
  migration_source: string | null;
  forked_from_task_id: string | null;
  cron_automation_id: string | null;
  off_peak_task_id: string | null;
  created_at: number;
  updated_at: number;
  unread_at: number | null;
  last_unread_at: number;
  pinned: number;
  archived: number;
  deleted: number;
  title_overridden: number;
  searchable_text: string;
  meta_json: string;
}

export interface TaskGroupRow {
  group_id: string;
  title: string;
  color: string;
  created_at: number;
  updated_at: number;
}

export interface TaskGroupMemberRow {
  group_id: string;
  workspace_key: string;
  workspace_path: string;
  workspace_identity: string | null;
  task_id: string;
  sort_order: number | null;
  added_at: number;
  created_at: number;
  updated_at: number;
}

export interface TaskGroupViewNodeOrderRow {
  node_type: "group" | "task";
  node_key: string;
  sort_order: number;
  created_at: number;
  updated_at: number;
}

export interface TaskGroupWorkspaceBootstrapRow {
  workspace_key: string;
  group_id: string | null;
}

export interface WorkspaceBootstrapScope {
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
}

export interface TaskIndexWriteRecord {
  meta: ACodeTaskMeta;
  pinned: boolean;
  archived: boolean;
  deleted: boolean;
  titleOverridden: boolean;
  // 只有 unread 专属写路径可以修改现有行，其他 metadata/snapshot 写必须保留当前 CAS marker。
  writeUnreadAt?: boolean;
  // searchableText 可空：传入 undefined 表示保留 existing 行的现有值。
  // 这样 applyAgentPatch / updateTaskState 这类不带 messages 上下文的写入不会把已索引的正文清空。
  searchableText?: string;
}

export interface TaskIndexStatePatch {
  pinned?: boolean;
  archived?: boolean;
  deleted?: boolean;
  title?: string;
  titleOverridden?: boolean;
  unreadAt?: number;
  model?: string;
  status?: ACodeTaskMeta["status"];
  lastError?: ACodeTaskMeta["lastError"];
  target?: ACodeTaskMeta["target"];
  updatedAt?: number;
}
