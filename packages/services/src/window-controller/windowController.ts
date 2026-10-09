import type { Event } from "@acode/rpc";
import { ServiceChannels } from "@acode/shared";
import type { ACodeTaskMeta } from "@acode/shared";
import type {
  ControllerResyncParams,
  ControllerResyncResult,
  ControllerSubscribeParams,
  ControllerSubscribeResult,
  ControllerUnsubscribeParams,
  WindowHostControllerTaskFrame,
  WindowHostControllerTaskRow,
  WindowHostControllerWorkspaceFrame,
  WindowHostTaskAddress,
} from "@acode/shared/acode-protocol-v4";
import { createServiceDescriptor } from "../descriptors.js";
import type { ACodeArchivedTaskDeletionResult } from "#src/session/acodeTaskService.js";
import type {
  ACodeTaskListItem,
  ACodeTaskListQuery,
  ACodeTaskListResult,
} from "../session/acodeTaskListTypes.js";

export type WindowHostControllerMutation =
  | { kind: "pin"; pinned: boolean }
  | { kind: "archive"; archived: boolean }
  | { kind: "delete" }
  | { kind: "delete-archived" }
  | { kind: "mark-read"; expectedUnreadAt?: number }
  | { kind: "mark-unread" }
  | { kind: "open" }
  | { kind: "resume" };

export type WindowHostControllerTaskListItem = ACodeTaskListItem & {
  remoteSessionId?: string;
  sourceAvailability: "online" | "offline";
  liveStatus: WindowHostControllerTaskRow["liveStatus"];
  activity?: WindowHostControllerTaskRow["activity"];
};

export interface WindowHostControllerTaskListResult extends Omit<ACodeTaskListResult, "items"> {
  items: WindowHostControllerTaskListItem[];
}

export type WindowHostControllerFrame =
  | WindowHostControllerTaskFrame
  | WindowHostControllerWorkspaceFrame;

/**
 * 窗口级 Controller 服务只承载列表投影与跨 source 路由。
 * conversation/file/git/terminal 仍由 attachment 对应的 scoped facade 提供。
 */
export interface IWindowControllerService {
  deleteArchivedTask(params: { address: WindowHostTaskAddress }): Promise<boolean>;
  deleteArchivedTasks(params: {
    address: WindowHostTaskAddress;
    taskIds: string[];
  }): Promise<ACodeArchivedTaskDeletionResult>;
  listTaskList(params: ACodeTaskListQuery): Promise<WindowHostControllerTaskListResult>;
  mutateTask(params: {
    address: WindowHostTaskAddress;
    mutation: WindowHostControllerMutation;
  }): Promise<ACodeTaskMeta | null>;
  subscribeControllerV4(params: ControllerSubscribeParams): Promise<ControllerSubscribeResult>;
  resyncControllerV4(params: ControllerResyncParams): Promise<ControllerResyncResult>;
  unsubscribeControllerV4(params: ControllerUnsubscribeParams): Promise<void>;
  onDynamicControllerFrame(): Event<WindowHostControllerFrame>;
}

export const IWindowControllerService = createServiceDescriptor<IWindowControllerService>(
  ServiceChannels.WindowController,
  {
    allowedMethods: [
      "deleteArchivedTask",
      "deleteArchivedTasks",
      "listTaskList",
      "mutateTask",
      "subscribeControllerV4",
      "resyncControllerV4",
      "unsubscribeControllerV4",
      "onDynamicControllerFrame",
    ],
    argumentValidators: {
      deleteArchivedTask: (args) => {
        const params = requireParams(args);
        requireTaskAddress(params.address);
      },
      deleteArchivedTasks: (args) => {
        const params = requireParams(args);
        requireTaskAddress(params.address);
        requireStringArray(params.taskIds, "taskIds");
      },
      listTaskList: (args) => {
        const params = requireParams(args);
        // kind/sortBy 为封闭字符串枚举，成员由服务实现校验；边界只做 typeof。
        requireString(params.kind, "kind");
        requireString(params.sortBy, "sortBy");
        const scopes = params.workspaceScopes;
        if (
          !Array.isArray(scopes) ||
          !scopes.every((scope) => isRecord(scope) && typeof scope.workspacePath === "string")
        ) {
          throw new Error("invalid workspaceScopes");
        }
      },
      mutateTask: (args) => {
        const params = requireParams(args);
        requireTaskAddress(params.address);
        // mutation 为封闭 kind 判别 union；成员字段由实现按 kind 分支校验。
        const mutation = requireRecordField(params.mutation, "mutation");
        requireNonEmptyString(mutation.kind, "mutation.kind");
      },
      subscribeControllerV4: (args) => {
        const params = requireParams(args);
        requireNonEmptyString(params.topic, "topic");
        // base 为可选续传游标；logEpoch/seq 成员由 v4 zod schema 校验。
        if (params.base !== undefined) requireRecordField(params.base, "base");
        requireOptionalString(params.visibility, "visibility");
      },
      resyncControllerV4: (args) => {
        const params = requireParams(args);
        requireNonEmptyString(params.subscriptionId, "subscriptionId");
        // 签名中 base 必选但可空（首轮 resync 无游标）；允许 null/对象/缺省，
        // 其余原始类型拒绝。logEpoch/seq 成员由 v4 zod schema 校验。
        const base = params.base;
        if (base !== undefined && base !== null && !isRecord(base)) {
          throw new Error("invalid base");
        }
        requireOptionalBoolean(params.forceSnapshot, "forceSnapshot");
      },
      unsubscribeControllerV4: (args) => {
        const params = requireParams(args);
        requireNonEmptyString(params.subscriptionId, "subscriptionId");
      },
      // 动态事件订阅参数：接口无参数，多余参数即契约违规。
      onDynamicControllerFrame: (args) => requireNoArguments(args),
    },
  },
);

// —— 文件内私有 RPC 参数校验辅助（边界迁移规则禁止跨文件共享 helper，先例 file.ts）——

function requireNoArguments(args: readonly unknown[]): void {
  if (args.length !== 0) throw new Error("expected no arguments");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 恰好一个参数且必须是非 null、非数组对象。 */
function requireParams(args: readonly unknown[]): Record<string, unknown> {
  if (args.length !== 1) throw new Error("expected one params object");
  const value = args[0];
  if (!isRecord(value)) throw new Error("expected one params object");
  return value;
}

function requireRecordField(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`invalid ${field}`);
  return value;
}

function requireString(value: unknown, field: string): void {
  if (typeof value !== "string") throw new Error(`invalid ${field}`);
}

function requireNonEmptyString(value: unknown, field: string): void {
  if (typeof value !== "string" || value.length === 0) throw new Error(`invalid ${field}`);
}

function requireOptionalString(value: unknown, field: string): void {
  if (value !== undefined && typeof value !== "string") throw new Error(`invalid ${field}`);
}

function requireOptionalBoolean(value: unknown, field: string): void {
  if (value !== undefined && typeof value !== "boolean") throw new Error(`invalid ${field}`);
}

function requireStringArray(value: unknown, field: string): void {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`invalid ${field}`);
  }
}

/** v4 windowHostTaskAddressSchema 要求 workspacePath/taskId 非空；跨 source 路由依赖它们。 */
function requireTaskAddress(value: unknown): void {
  const address = requireRecordField(value, "address");
  requireNonEmptyString(address.workspacePath, "address.workspacePath");
  requireNonEmptyString(address.taskId, "address.taskId");
}
