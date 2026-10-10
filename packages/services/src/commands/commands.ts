import type {
  CommandsListResult,
  CommandCreateParams,
  CommandUpdateParams,
  CommandDeleteParams,
  CommandSetEnabledParams,
  CommandAgentSource,
  UserCommand,
} from "@acode/shared";
import { ServiceChannels } from "@acode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export interface ICommandsService {
  list(params: {
    agentSource?: CommandAgentSource;
    workspacePath?: string;
    workspaceIdentity?: string;
  }): Promise<CommandsListResult>;
  writeCommandFile(params: CommandCreateParams): Promise<{ command: UserCommand }>;
  updateCommandFile(params: CommandUpdateParams): Promise<{ command: UserCommand }>;
  deleteCommandFile(params: CommandDeleteParams): Promise<void>;
  setCommandEnabled(params: CommandSetEnabledParams): Promise<void>;
  getPrimaryUserCommandsDirectory(params?: {
    agentSource?: CommandAgentSource;
  }): Promise<{ path: string }>;
}

export const ICommandsService = createServiceDescriptor<ICommandsService>(
  ServiceChannels.Commands,
  {
    allowedMethods: [
      "list",
      "writeCommandFile",
      "updateCommandFile",
      "deleteCommandFile",
      "setCommandEnabled",
      "getPrimaryUserCommandsDirectory",
    ],
    argumentValidators: {
      list: (args) => {
        // 字段全部可选；只校验参数对象形态与可选字段类型。
        const params = requireParams(args);
        requireOptionalString(params.agentSource, "agentSource");
        requireOptionalString(params.workspacePath, "workspacePath");
        requireOptionalString(params.workspaceIdentity, "workspaceIdentity");
      },
      writeCommandFile: (args) => {
        const params = requireParams(args);
        requireCommandConfig(params.config);
        requireOptionalString(params.agentSource, "agentSource");
        requireOptionalString(params.storageLevel, "storageLevel");
        requireOptionalString(params.workspacePath, "workspacePath");
      },
      updateCommandFile: (args) => {
        const params = requireParams(args);
        requireNonEmptyString(params.commandId, "commandId");
        requireCommandConfig(params.config);
        requireOptionalString(params.oldFilePath, "oldFilePath");
        requireOptionalString(params.agentSource, "agentSource");
        requireOptionalString(params.storageLevel, "storageLevel");
        requireOptionalString(params.workspacePath, "workspacePath");
      },
      deleteCommandFile: (args) => {
        const params = requireParams(args);
        requireNonEmptyString(params.commandId, "commandId");
        // 删除操作的 filePath 为空字符串属明显异常，边界要求非空；
        // agentSource 成员集合由服务实现校验。
        requireNonEmptyString(params.filePath, "filePath");
        requireOptionalString(params.agentSource, "agentSource");
      },
      setCommandEnabled: (args) => {
        const params = requireParams(args);
        requireNonEmptyString(params.commandId, "commandId");
        requireNonEmptyString(params.filePath, "filePath");
        requireBoolean(params.enabled, "enabled");
        requireOptionalString(params.agentSource, "agentSource");
      },
      getPrimaryUserCommandsDirectory: (args) => {
        // params 可选（缺省用默认 agentSource）。
        if (args.length > 1) throw new Error("expected at most one params object");
        if (args[0] === undefined) return;
        const params = requireRecordField(args[0], "params");
        requireOptionalString(params.agentSource, "agentSource");
      },
    },
  },
);

// —— 文件内私有 RPC 参数校验辅助（边界迁移规则禁止跨文件共享 helper，先例 file.ts）——

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

/** CommandConfig 的 name/prompt 为必选字符串；description/argumentHint 可选留给实现。 */
function requireCommandConfig(value: unknown): void {
  const config = requireRecordField(value, "config");
  requireString(config.name, "config.name");
  requireString(config.prompt, "config.prompt");
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

function requireBoolean(value: unknown, field: string): void {
  if (typeof value !== "boolean") throw new Error(`invalid ${field}`);
}
