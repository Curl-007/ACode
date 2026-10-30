// IACodeTaskService 接口分片：诊断读取、workspace 进程重启、task 状态操作与流式事件订阅。
// 自 acodeTaskService.ts 拆出；成员与注释逐字保留，组合关系见本体文件。
import type { Event } from "@acode/rpc";
import type {
  ACodeError,
  ACodeProvider,
  ACodeStreamEvent,
  ACodeTaskCreateResult,
  ACodeTaskMeta,
  ACodeTaskTokenUsageResult,
  ACodeWorkspaceEvent,
} from "@acode/shared";
import type { ACodeWorkspaceEventSubscriptionParams } from "#src/session/acodeTaskListTypes.js";
import type { ACodeModelTrajectory } from "#src/session/acode-task/modelTrajectoryTypes.js";
import type {
  ACodeArchivedTaskDeletionResult,
  ACodeTaskReadyOutcome,
  ACodeTaskTerminalOutcome,
} from "#src/session/acode-task/taskOutcomeTypes.js";

export interface IACodeTaskOpsEventsApi {
  /** 获取 ACode Agent 当前结构化日志文件路径。 */
  getTaskNativeSessionLogFile(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<{
    provider: ACodeProvider | null;
    path: string | null;
    exists: boolean;
  }>;

  /**
   * 读取 task 对应的模型调用轨迹（来自 ~/.acode/cli/{debug,rollout} 的 model-io JSONL）。
   * taskId 即 ACode Agent 的 sessionId，按 sessionId 匹配 model-io 记录。
   */
  getModelTrajectory(params: {
    taskId: string;
    /** 最多返回的调用条数（按时间倒序保留最近 N 条），默认 200。 */
    limit?: number;
  }): Promise<ACodeModelTrajectory>;

  /** 从 agent usage 数据库读取某个 task/session 的累计模型 token 用量。 */
  getTaskTokenUsage(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<ACodeTaskTokenUsageResult>;

  /** 获取 task 持久化快照文件路径（统一为 {taskId}.json，软删除例外为 .deleted.json） */
  getTaskSessionFilePath(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<{
    path: string;
    exists: boolean;
  }>;

  /**
   * 重启指定 workspace 的 ACode Agent 共享进程。
   * 配置变更需要重新读取进程环境时使用。
   * 可选传入 resumeTaskId 在重启后立即续接当前聊天会话。
   */
  restartWorkspaceProcess(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    provider?: ACodeProvider;
    resumeTaskId?: string;
    bumpRuntimeEpoch?: boolean;
  }): Promise<void>;

  /** 将已持久化 task 标记为列表不可见；CLI session 内容继续保留 */
  deleteTask(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<void>;

  /** 仅删除写入时仍归档的任务；已恢复、已删除或不存在时返回 false，不清理 CLI 会话。 */
  deleteArchivedTask(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<boolean>;

  /** 逐项执行归档条件删除，批次结束后统一通知列表；不清理 CLI 会话。 */
  deleteArchivedTasks(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskIds: string[];
  }): Promise<ACodeArchivedTaskDeletionResult>;

  /** 重命名已持久化的 task */
  renameTask(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    title: string;
  }): Promise<ACodeTaskMeta>;

  /** 更新 task 置顶状态 */
  setTaskPinned(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    pinned: boolean;
  }): Promise<ACodeTaskMeta>;

  /** 更新 task 未读状态 */
  setTaskUnread(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    unread: boolean;
    /** 仅用于已读 compare-and-clear；缺省时保持既有无条件写入语义。 */
    expectedUnreadAt?: number;
  }): Promise<ACodeTaskMeta>;

  /** 归档 task，使其从默认任务列表中隐藏 */
  archiveTask(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<ACodeTaskMeta>;

  /** 取消归档 task，使其重新回到默认任务列表 */
  unarchiveTask(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<ACodeTaskMeta>;

  /** 基于 source task 的会话配置新建一个空白分支，用于重新编辑某条用户输入。 */
  branchTaskFromPrompt(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    sourceTaskId: string;
  }): Promise<ACodeTaskCreateResult>;

  // ---- 流式事件 ----

  /** 订阅指定 task 的流式更新（ProxyChannel 动态事件） */
  onDynamicStreamEvent(taskId: string): Event<ACodeStreamEvent>;

  /**
   * 订阅指定 task 的终态结果（succeeded / failed / stopped）。
   * 基于 task index 的常开 session 订阅，不依赖 renderer 是否正在观看该 task，
   * 因此后台派发（如定时任务）也能可靠拿到终态。用于回写 automation_runs.outcome。
   */
  onDynamicTaskTerminalOutcome(taskId: string): Event<ACodeTaskTerminalOutcome>;

  /**
   * 订阅指定 task 的输入就绪边界。sendPrompt 只返回远端 ACK，不能用它判断 Agent 已空闲；
   * Host runtime 回收必须等本事件，避免关闭 workspace 时中断仍在运行的 Agent。
   */
  onDynamicTaskReady(taskId: string): Event<ACodeTaskReadyOutcome>;

  /** 订阅指定 workspace + task 的流式更新，用于避免同 taskId 跨 workspace 串流。 */
  onDynamicTaskEvent(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
    clientId?: string;
    deliveryKind?: "continuous" | "bot-channel-continuous" | "replayable" | "mixed";
  }): Event<ACodeStreamEvent>;

  /**
   * 订阅 workspace 级别的异步通知（如预热阶段 Agent 推送的 slash commands、configOptions）。
   * 覆盖 task 创建前的空档期，UI 收到后可实时更新草稿态的工具栏和命令列表。
   * 命名遵循 ProxyChannel 的 onDynamic 前缀约定，使 RPC 代理自动识别为动态事件。
   */
  onDynamicWorkspaceEvent(
    workspace: string | ACodeWorkspaceEventSubscriptionParams,
  ): Event<ACodeWorkspaceEvent>;

  /** 全局错误事件 */
  onError: Event<ACodeError>;
}
