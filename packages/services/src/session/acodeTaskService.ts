import { ServiceChannels } from "@acode/shared";
import { createServiceDescriptor } from "#src/descriptors.js";
import { acodeTaskArgumentValidators } from "#src/session/acode-task/argumentValidators.js";
import type { IACodeTaskLifecycleApi } from "#src/session/acode-task/taskLifecycleApi.js";
import type { IACodeTaskListViewsApi } from "#src/session/acode-task/taskListViewsApi.js";
import type { IACodeTaskOpsEventsApi } from "#src/session/acode-task/taskOpsEventsApi.js";
import type { IACodeTaskSnapshotConfigApi } from "#src/session/acode-task/taskSnapshotConfigApi.js";

// 浏览器安全不变量（specs/session-module-boundary.md）：本文件是根 barrel 的三条
// 浏览器安全值边之一，值导入闭包必须零 node: builtin。上方唯一新增值边指向
// acode-task/argumentValidators.js（零导入纯函数叶子）；类型/投影经 export type
// 与 import type 转发，模块图求值期即擦除，不产生 bundle 边。

export type {
  ACodeModelTrajectory,
  ACodeModelTrajectoryCallSource,
  ACodeModelTrajectoryCallSourceKind,
  ACodeModelTrajectoryContentPart,
  ACodeModelTrajectoryMessage,
  ACodeModelTrajectoryRecord,
  ACodeModelTrajectoryUsage,
} from "#src/session/acode-task/modelTrajectoryTypes.js";

export type {
  ACodeArchivedTaskDeletionResult,
  ACodeTaskReadyOutcome,
  ACodeTaskSnapshotWithEtagResult,
  ACodeTaskTerminalOutcome,
} from "#src/session/acode-task/taskOutcomeTypes.js";

export type {
  ACodeTaskListKind,
  ACodeTaskListQuery,
  ACodeTaskListResult,
  ACodeTaskListSortBy,
  ACodeTaskListWorkspaceScope,
  ACodeWorkspaceEventSubscriptionParams,
  ACodeGroupedTaskRef,
  ACodeGroupedTaskView,
  ACodeGroupedTaskViewNode,
  ACodeGroupedTaskViewOrderInput,
  ACodeGroupedTaskViewQuery,
  ACodeGroupedTaskViewStructure,
  ACodeGroupedTaskViewStructureMember,
  ACodeGroupedTaskViewStructureTopOrder,
  ACodeGroupedTaskViewTopLevelNodeRef,
  ACodeTaskGroup,
  ACodeTaskGroupColor,
} from "#src/session/acodeTaskListTypes.js";

/**
 * IACodeTaskService — ACode task wrapper API 服务接口
 *
 * UI、remote controller 通过这层访问 task wrapper 状态；核心 session 状态由
 * ACode Agent server 维护，新功能应优先走 IACodeSessionService。
 *
 * 接口成员按域拆成 acode-task/ 下四个分片（生命周期与命令 / 列表与分组视图 /
 * 快照与配置 / 运维与流式事件），此处经 extends 组合还原完整公开面；
 * 分片只服务文件行数治理，成员签名与注释逐字保留，消费方零改动。
 */
export interface IACodeTaskService
  extends IACodeTaskLifecycleApi,
    IACodeTaskListViewsApi,
    IACodeTaskSnapshotConfigApi,
    IACodeTaskOpsEventsApi {}

export const IACodeTaskService = createServiceDescriptor<IACodeTaskService>(
  ServiceChannels.ACodeTask,
  {
    allowedMethods: [
      "initialize",
      "releaseWorkspacePreparation",
      "createTask",
      "sendPrompt",
      "deliverSessionMessage",
      "sendSessionMessageDeliveryResult",
      "enqueueTaskCommand",
      "promoteTaskCommand",
      "cancelTaskCommand",
      "stopGeneration",
      "compactSession",
      "goalSession",
      "respondPermission",
      "respondElicitation",
      "closeTask",
      "resumeTask",
      "listTasks",
      "listPinnedTaskIds",
      "listPinnedTasks",
      "listDeletedTaskIds",
      "listTaskList",
      "createTaskGroup",
      "renameTaskGroup",
      "updateTaskGroupColor",
      "deleteTaskGroup",
      "listGroupedTaskViewStructure",
      "applyGroupedTaskViewOrder",
      "listArchivedTasks",
      "archiveStaleTasks",
      "archiveWorkspaceTasks",
      "getTaskSnapshot",
      "getTaskSnapshotWithEtag",
      "getTaskSnapshotBody",
      "getTaskSnapshotRef",
      "getTaskSnapshotToolCallsSlice",
      "getTaskMeta",
      "getTaskConfigOptions",
      "getTaskModelSelection",
      "setAssistantMessageFeedback",
      "scanImportableClaudeSessions",
      "importClaudeSessions",
      "setMode",
      "setConfigOption",
      "setModel",
      "setAutomationSessionConfig",
      "getTaskNativeSessionLogFile",
      "getModelTrajectory",
      "getTaskTokenUsage",
      "getTaskSessionFilePath",
      "restartWorkspaceProcess",
      "deleteTask",
      "deleteArchivedTask",
      "deleteArchivedTasks",
      "renameTask",
      "setTaskPinned",
      "setTaskUnread",
      "archiveTask",
      "unarchiveTask",
      "branchTaskFromPrompt",
      "onDynamicStreamEvent",
      "onDynamicTaskTerminalOutcome",
      "onDynamicTaskReady",
      "onDynamicTaskEvent",
      "onDynamicWorkspaceEvent",
      "onError",
    ],
    // 校验策略（rpc-service-boundary spec 规则 7）全文随校验表移至
    // acode-task/argumentValidators.js；校验表键名按四分片 keyof 并集全量钉死。
    argumentValidators: acodeTaskArgumentValidators,
  },
);
