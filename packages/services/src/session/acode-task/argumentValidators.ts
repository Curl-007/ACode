// IACodeTaskService descriptor 的 RPC 参数校验表与私有校验辅助。
// 自 acodeTaskService.ts 拆出：校验逻辑逐字保留；键名经四个接口分片的 keyof 并集钉死，
// 新增方法不同步登记校验器会在类型检查期直接报错。
import type { RpcArgumentValidator } from "@acode/rpc";
import type { IACodeTaskLifecycleApi } from "#src/session/acode-task/taskLifecycleApi.js";
import type { IACodeTaskListViewsApi } from "#src/session/acode-task/taskListViewsApi.js";
import type { IACodeTaskOpsEventsApi } from "#src/session/acode-task/taskOpsEventsApi.js";
import type { IACodeTaskSnapshotConfigApi } from "#src/session/acode-task/taskSnapshotConfigApi.js";

/** IACodeTaskService 全部方法名 = 四个接口分片 keyof 的并集。 */
type ACodeTaskServiceMethod = Extract<
  | keyof IACodeTaskLifecycleApi
  | keyof IACodeTaskListViewsApi
  | keyof IACodeTaskOpsEventsApi
  | keyof IACodeTaskSnapshotConfigApi,
  string
>;

// 校验策略（rpc-service-boundary spec 规则 7）：全部校验器只按 TS 签名做保守的
// 形状校验——单 params 对象、必填字段存在且顶层 typeof 匹配；可选字段（`?`/`| undefined`）
// 一律放行缺省与 undefined，字面量联合只收敛到 typeof（不钉死成员），避免接口演进时
// 误拒合法调用。错误文本只含字段名，绝不回显参数值。
export const acodeTaskArgumentValidators: Record<ACodeTaskServiceMethod, RpcArgumentValidator> = {
  initialize: (args) => requireTaskParams(args, { strings: ["workspacePath"] }),
  releaseWorkspacePreparation: (args) =>
    requireTaskParams(args, { strings: ["workspacePath"] }),
  createTask: (args) =>
    // mode/modelSelection/mcpServers 等均为可选字段，保守起见只校验必填 workspacePath。
    requireTaskParams(args, { strings: ["workspacePath"] }),
  sendPrompt: (args) =>
    // 交叉的 ACodeBackgroundTurnAttribution 是 union，attribution 字段（automationId/
    // offPeakTaskId/offPeakRunType）在部分成员中必须缺省，故不做任何校验；
    // 只校验三个必填 string。
    requireTaskParams(args, { strings: ["taskId", "traceId", "content"] }),
  deliverSessionMessage: (args) =>
    requireTaskParams(args, {
      strings: [
        "content",
        "createdAt",
        "fromSessionId",
        "messageId",
        "requestId",
        "toSessionId",
      ],
    }),
  sendSessionMessageDeliveryResult: (args) =>
    // status 为 "success" | "failed" 字面量联合，保守只校验 string。
    requireTaskParams(args, { strings: ["messageId", "requestId", "sessionId", "status"] }),
  enqueueTaskCommand: (args) =>
    // type 目前是字面量 "send_prompt"；保守只校验 string，避免未来扩展命令类型时误拒。
    requireTaskParams(args, {
      strings: ["workspacePath", "taskId", "commandId", "traceId", "type", "content"],
    }),
  promoteTaskCommand: (args) =>
    requireTaskParams(args, {
      strings: ["workspacePath", "taskId", "commandId", "ownerRunId", "clientMode"],
    }),
  cancelTaskCommand: (args) =>
    requireTaskParams(args, {
      strings: ["workspacePath", "taskId", "commandId", "clientMode"],
    }),
  stopGeneration: (args) => requireTaskParams(args, { strings: ["taskId"] }),
  compactSession: (args) => requireTaskParams(args, { strings: ["taskId"] }),
  goalSession: (args) =>
    // action 是 z.enum 字符串联合（show/set/replace/pause/resume/clear），保守只校验 string。
    requireTaskParams(args, { strings: ["taskId", "action"] }),
  respondPermission: (args) => {
    const value = requireTaskParams(args, {
      strings: ["taskId", "requestId", "optionId"],
      objects: ["response"],
    });
    // ACodePermissionResponse.decision 是必填字符串枚举；保守只校验 string。
    if (typeof (value.response as Record<string, unknown>).decision !== "string") {
      throw new Error("invalid response.decision");
    }
  },
  respondElicitation: (args) =>
    requireTaskParams(args, { strings: ["taskId", "requestId", "action"] }),
  closeTask: (args) => requireTaskParams(args, { strings: ["taskId"] }),
  resumeTask: (args) => requireTaskParams(args, { strings: ["taskId", "workspacePath"] }),
  listTasks: (args) => requireTaskParams(args, { strings: ["workspacePath"] }),
  listPinnedTaskIds: (args) => requireNoTaskArguments(args),
  listPinnedTasks: (args) => requireTaskParams(args, { strings: ["workspacePath"] }),
  listDeletedTaskIds: (args) => requireTaskParams(args, { strings: ["workspacePath"] }),
  listTaskList: (args) =>
    // kind/sortBy 为字符串字面量联合，保守只校验 string；workspaceScopes 必须是对象数组。
    requireTaskParams(args, {
      strings: ["kind", "sortBy"],
      objectArrays: ["workspaceScopes"],
    }),
  createTaskGroup: (args) => {
    // params 整体可选（params?: { title?; color? }）：接受无参、undefined 或单个对象；
    // title/color 均为可选字段，不做校验。
    if (args.length > 1) throw new Error("expected at most one params object");
    const value = args[0];
    if (value !== undefined && !isPlainObject(value)) {
      throw new Error("invalid params");
    }
  },
  renameTaskGroup: (args) => requireTaskParams(args, { strings: ["groupId", "title"] }),
  updateTaskGroupColor: (args) =>
    // color 为字符串字面量联合，保守只校验 string。
    requireTaskParams(args, { strings: ["groupId", "color"] }),
  deleteTaskGroup: (args) => requireTaskParams(args, { strings: ["groupId"] }),
  listGroupedTaskViewStructure: (args) =>
    requireTaskParams(args, { objectArrays: ["workspaceScopes"] }),
  applyGroupedTaskViewOrder: (args) =>
    requireTaskParams(args, { objectArrays: ["workspaceScopes", "topLevelNodes", "groups"] }),
  listArchivedTasks: (args) => requireTaskParams(args, { strings: ["workspacePath"] }),
  archiveStaleTasks: (args) =>
    requireTaskParams(args, { strings: ["workspacePath"], numbers: ["olderThanDays"] }),
  archiveWorkspaceTasks: (args) => requireTaskParams(args, { strings: ["workspacePath"] }),
  getTaskSnapshot: (args) => requireTaskParams(args, { strings: ["taskId", "workspacePath"] }),
  getTaskSnapshotWithEtag: (args) =>
    requireTaskParams(args, { strings: ["taskId", "workspacePath"] }),
  getTaskSnapshotBody: (args) =>
    requireTaskParams(args, { strings: ["taskId", "workspacePath", "refId"] }),
  getTaskSnapshotRef: (args) =>
    requireTaskParams(args, { strings: ["taskId", "workspacePath", "refId"] }),
  getTaskSnapshotToolCallsSlice: (args) =>
    requireTaskParams(args, {
      strings: ["taskId", "workspacePath"],
      numbers: ["messageIndex", "startToolIndex", "limit"],
    }),
  getTaskMeta: (args) => requireTaskParams(args, { strings: ["taskId", "workspacePath"] }),
  getTaskConfigOptions: (args) => requireTaskParams(args, { strings: ["taskId"] }),
  getTaskModelSelection: (args) => requireTaskParams(args, { strings: ["taskId"] }),
  setAssistantMessageFeedback: (args) => {
    const value = requireTaskParams(args, {
      strings: ["taskId", "workspacePath"],
      numbers: ["turnIndex"],
    });
    // feedback 类型是 ACodeAssistantMessageFeedback | null：null 是合法的"清除反馈"语义，
    // 只要求字段存在且为 null 或 string，不钉死枚举成员（保守，避免枚举扩展时误拒）。
    if (!("feedback" in value) || value.feedback === undefined) {
      throw new Error("invalid feedback");
    }
    if (value.feedback !== null && typeof value.feedback !== "string") {
      throw new Error("invalid feedback");
    }
  },
  scanImportableClaudeSessions: (args) => {
    // 全部字段可选（workspacePath/modifiedSince/limit），只要求单个 params 对象。
    requireTaskParams(args, {});
  },
  importClaudeSessions: (args) =>
    // 两个重载共用同一参数形状：sessionIds 必填 string[]；source 为可选枚举
    //（缺省 = "claude-code"），保守不校验 source，避免外部导入源扩展时误拒。
    requireTaskParams(args, { stringArrays: ["sessionIds"] }),
  setMode: (args) =>
    // mode 为字符串字面量联合（ACodeTaskMode），保守只校验 string。
    requireTaskParams(args, { strings: ["taskId", "mode"] }),
  setConfigOption: (args) =>
    requireTaskParams(args, { strings: ["taskId", "traceId", "configId", "value"] }),
  setModel: (args) => {
    const value = requireTaskParams(args, {
      strings: ["taskId", "traceId"],
      objects: ["modelSelection"],
    });
    requireModelSelection(value.modelSelection as Record<string, unknown>);
  },
  setAutomationSessionConfig: (args) => {
    // thoughtLevel/mode 为可选字段，不校验。
    const value = requireTaskParams(args, {
      strings: ["taskId", "traceId"],
      objects: ["modelSelection"],
    });
    requireModelSelection(value.modelSelection as Record<string, unknown>);
  },
  getTaskNativeSessionLogFile: (args) =>
    requireTaskParams(args, { strings: ["taskId", "workspacePath"] }),
  getModelTrajectory: (args) => requireTaskParams(args, { strings: ["taskId"] }),
  getTaskTokenUsage: (args) =>
    requireTaskParams(args, { strings: ["taskId", "workspacePath"] }),
  getTaskSessionFilePath: (args) =>
    requireTaskParams(args, { strings: ["taskId", "workspacePath"] }),
  restartWorkspaceProcess: (args) => requireTaskParams(args, { strings: ["workspacePath"] }),
  deleteTask: (args) => requireTaskParams(args, { strings: ["taskId", "workspacePath"] }),
  deleteArchivedTask: (args) =>
    requireTaskParams(args, { strings: ["taskId", "workspacePath"] }),
  deleteArchivedTasks: (args) =>
    requireTaskParams(args, { strings: ["workspacePath"], stringArrays: ["taskIds"] }),
  renameTask: (args) =>
    requireTaskParams(args, { strings: ["taskId", "workspacePath", "title"] }),
  setTaskPinned: (args) =>
    requireTaskParams(args, { strings: ["taskId", "workspacePath"], booleans: ["pinned"] }),
  setTaskUnread: (args) =>
    // expectedUnreadAt 为可选 number（compare-and-clear），不校验。
    requireTaskParams(args, { strings: ["taskId", "workspacePath"], booleans: ["unread"] }),
  archiveTask: (args) => requireTaskParams(args, { strings: ["taskId", "workspacePath"] }),
  unarchiveTask: (args) => requireTaskParams(args, { strings: ["taskId", "workspacePath"] }),
  branchTaskFromPrompt: (args) =>
    requireTaskParams(args, { strings: ["workspacePath", "sourceTaskId"] }),
  onDynamicStreamEvent: (args) => requireTaskIdArgument(args),
  onDynamicTaskTerminalOutcome: (args) => requireTaskIdArgument(args),
  onDynamicTaskReady: (args) => requireTaskIdArgument(args),
  onDynamicTaskEvent: (args) =>
    requireTaskParams(args, { strings: ["workspacePath", "taskId"] }),
  onDynamicWorkspaceEvent: (args) => {
    // 参数为 string | ACodeWorkspaceEventSubscriptionParams 联合：两种成员都接受；
    // 对象成员时校验必填 workspacePath string，workspaceIdentity 可选不校验。
    if (args.length !== 1) throw new Error("invalid workspace subscription");
    const value = args[0];
    if (typeof value === "string") return;
    if (!isPlainObject(value)) throw new Error("invalid workspace subscription");
    if (typeof (value as Record<string, unknown>).workspacePath !== "string") {
      throw new Error("invalid workspacePath");
    }
  },
  onError: (args) => {
    // 普通事件订阅在 ProxyChannel.listen 命中缓存后直接返回，不经过参数校验；
    // 此处登记只为公开面表完整，保守接受至多一个订阅参数。
    if (args.length > 1) throw new Error("expected event subscription without arguments");
  },
};

// ── 文件内私有的 RPC 参数校验辅助（先例见 file.ts；不建共享模块，避免跨服务耦合） ──

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireNoTaskArguments(args: readonly unknown[]): void {
  if (args.length !== 0) throw new Error("expected no arguments");
}

/** 动态事件（onDynamicXxx）经 listen(name, arg) 传递单个 taskId。 */
function requireTaskIdArgument(args: readonly unknown[]): void {
  if (args.length !== 1 || typeof args[0] !== "string") {
    throw new Error("expected task id");
  }
}

interface TaskParamsSpec {
  /** 必填 string 字段（含字面量联合：保守只收敛到 typeof string）。 */
  readonly strings?: readonly string[];
  /** 必填有限 number 字段。 */
  readonly numbers?: readonly string[];
  /** 必填 boolean 字段。 */
  readonly booleans?: readonly string[];
  /** 必填非空对象字段（数组不视为合法对象参数）。 */
  readonly objects?: readonly string[];
  /** 必填 string[] 字段。 */
  readonly stringArrays?: readonly string[];
  /** 必填"元素为非空对象"的数组字段。 */
  readonly objectArrays?: readonly string[];
}

/**
 * 校验"单个 params 对象 + 必填字段顶层类型"。可选字段一律不校验：
 * `?`/`| undefined` 成员允许缺省，`| null` 成员允许 null；错误文本只含字段名，
 * 不回显任何参数值（spec 规则 7：details 不得携带敏感值）。
 */
function requireTaskParams(
  args: readonly unknown[],
  spec: TaskParamsSpec,
): Record<string, unknown> {
  if (args.length !== 1 || !isPlainObject(args[0])) {
    throw new Error("expected a single params object");
  }
  const value = args[0];
  for (const field of spec.strings ?? []) {
    if (typeof value[field] !== "string") throw new Error(`invalid ${field}`);
  }
  for (const field of spec.numbers ?? []) {
    const fieldValue = value[field];
    if (typeof fieldValue !== "number" || !Number.isFinite(fieldValue)) {
      throw new Error(`invalid ${field}`);
    }
  }
  for (const field of spec.booleans ?? []) {
    if (typeof value[field] !== "boolean") throw new Error(`invalid ${field}`);
  }
  for (const field of spec.objects ?? []) {
    const fieldValue = value[field];
    if (typeof fieldValue !== "object" || fieldValue === null) {
      throw new Error(`invalid ${field}`);
    }
  }
  for (const field of spec.stringArrays ?? []) {
    const fieldValue = value[field];
    if (!Array.isArray(fieldValue) || !fieldValue.every((item) => typeof item === "string")) {
      throw new Error(`invalid ${field}`);
    }
  }
  for (const field of spec.objectArrays ?? []) {
    const fieldValue = value[field];
    if (
      !Array.isArray(fieldValue) ||
      !fieldValue.every((item) => typeof item === "object" && item !== null)
    ) {
      throw new Error(`invalid ${field}`);
    }
  }
  return value;
}

function requireModelSelection(selection: Record<string, unknown>): void {
  // ModelSelection（zod strict object）：providerId/modelId 为必填 string；
  // options 为可选字段，不校验（保守）。
  if (typeof selection.providerId !== "string" || typeof selection.modelId !== "string") {
    throw new Error("invalid modelSelection");
  }
}
