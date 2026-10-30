// IACodeTaskService 接口分片：任务列表、分组视图与归档查询。
// 自 acodeTaskService.ts 拆出；成员与注释逐字保留，组合关系见本体文件。
import type { ACodeTaskMeta } from "@acode/shared";
import type {
  ACodeTaskListQuery,
  ACodeTaskListResult,
  ACodeTaskListWorkspaceScope,
  ACodeGroupedTaskView,
  ACodeGroupedTaskViewOrderInput,
  ACodeGroupedTaskViewStructure,
  ACodeTaskGroup,
  ACodeTaskGroupColor,
} from "#src/session/acodeTaskListTypes.js";

export interface IACodeTaskListViewsApi {
  /** 列出 workspace 下所有已持久化的 task */
  listTasks(params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<ACodeTaskMeta[]>;

  /** 读取全局 pinned task id 列表，真相源为 tasks-index.sqlite */
  listPinnedTaskIds(): Promise<string[]>;

  /** 按 tasks-index.sqlite 中的 pinned 状态列出当前 workspace 下所有 pinned task */
  listPinnedTasks(params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<ACodeTaskMeta[]>;

  /** 读取 workspace 下已删除 task id；用于 sessions-index 列表的持久负向 membership join */
  listDeletedTaskIds(params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<string[]>;

  /**
   * 按当前打开的 workspace scopes 聚合查询任务列表，真相源为 tasks-index.sqlite。
   * 消费面：全文搜索（searchable_text/snippets）与 remoteTimelineTaskStore 补充链路；
   * 无搜索列表行走 listTasks/listPinnedTasks/listArchivedTasks，workspace 行由
   * 客户端用各 endpoint 的 task 行 + session detail 构建（多端收敛）。
   */
  listTaskList(params: ACodeTaskListQuery): Promise<ACodeTaskListResult>;

  /** 创建最小 task group；完整 delete 后续由 group 管理功能补齐 */
  createTaskGroup(params?: {
    title?: string;
    color?: ACodeTaskGroupColor;
  }): Promise<ACodeTaskGroup>;

  /** 重命名 task group；workspaceScopes 只用于通知当前可见 grouped 视图刷新 */
  renameTaskGroup(params: {
    groupId: string;
    title: string;
    workspaceScopes?: ACodeTaskListWorkspaceScope[];
  }): Promise<ACodeTaskGroup>;

  /** 更新 task group 颜色；workspaceScopes 只用于通知当前可见 grouped 视图刷新 */
  updateTaskGroupColor(params: {
    groupId: string;
    color: ACodeTaskGroupColor;
    workspaceScopes?: ACodeTaskListWorkspaceScope[];
  }): Promise<ACodeTaskGroup>;

  /** 删除 task group；调用方应先把组内 task 移回顶层 root */
  deleteTaskGroup(params: {
    groupId: string;
    workspaceScopes?: ACodeTaskListWorkspaceScope[];
  }): Promise<void>;

  // 服务端 grouped 查询只回原始结构（不 join tasks 表），
  // renderer 用 task 行分区 + session detail 统一投影。

  /**
   * 查询 Grouped 视图原始结构（group/member/顶层排序，不 join tasks 表）。
   * 客户端以 task 行分区为左表 join 本结构，sessions-index 只补充实时 detail。
   */
  listGroupedTaskViewStructure(params: {
    workspaceScopes: ACodeTaskListWorkspaceScope[];
  }): Promise<ACodeGroupedTaskViewStructure>;

  /** 一次性提交 grouped 视图最终排序和 membership，服务层用 sqlite transaction 落库 */
  applyGroupedTaskViewOrder(params: ACodeGroupedTaskViewOrderInput): Promise<ACodeGroupedTaskView>;

  /** 列出 workspace 下所有已归档 task */
  listArchivedTasks(params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<ACodeTaskMeta[]>;

  /** 批量归档超期旧任务；仅归档已完成、无未读、非 pinned 且当前未打开的 task */
  archiveStaleTasks(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    olderThanDays: number;
  }): Promise<ACodeTaskMeta[]>;

  /** 移除 workspace 时批量归档该 workspace 下所有未归档 task，包含 pinned task */
  archiveWorkspaceTasks(params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<ACodeTaskMeta[]>;
}
