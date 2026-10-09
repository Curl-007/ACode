import type {
  LoadCliMcpFromUserDirectoryRequest,
  LoadCliMcpFromUserDirectoryResult,
  McpSyncCandidateListResult,
  McpSyncExportResult,
  McpSyncExportedServer,
  McpSyncImportResult,
  McpSyncRemoteStatusResult,
  RemoteSyncWriteAccessResult,
  SaveCliMcpToUserDirectoryRequest,
  ACodeAgentMcpServer,
  ACodeMcpListMode,
  ACodeMcpListResult,
} from "@acode/shared";
import { ServiceChannels } from "@acode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export interface IMcpSyncService {
  loadMcpFromUserDirectory(
    request?: LoadCliMcpFromUserDirectoryRequest,
  ): Promise<LoadCliMcpFromUserDirectoryResult>;
  /**
   * workspace MCP server 运行态状态列表（原 UI 直调 acodeAgentService 的
   * mcp/list）。真实 connect/listTools 检查必须发生在 agent 进程（PATH/cwd 是
   * workspace 环境），本服务只是 UI 的注入面——mcp/list 词的 host 消费收拢到实现一处。
   */
  listWorkspaceMcpServerStatuses(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    mcpServers?: ACodeAgentMcpServer[];
    mode?: ACodeMcpListMode;
  }): Promise<ACodeMcpListResult>;
  saveMcpToUserDirectory(payload: SaveCliMcpToUserDirectoryRequest): Promise<void>;
  listLocalUserMcpCandidates(): Promise<McpSyncCandidateListResult>;
  listRemoteUserMcpStatuses(params: { names: string[] }): Promise<McpSyncRemoteStatusResult>;
  exportMcpServers(params: { serverIds: string[] }): Promise<McpSyncExportResult>;
  checkRemoteUserMcpWriteAccess(): Promise<RemoteSyncWriteAccessResult>;
  importMcpServers(params: {
    servers: McpSyncExportedServer[];
    localHomeDir: string;
    localWorkspacePath?: string;
    remoteWorkspacePath?: string;
    overwrite?: false;
  }): Promise<McpSyncImportResult>;
}

export const IMcpSyncService = createServiceDescriptor<IMcpSyncService>(ServiceChannels.McpSync, {
  allowedMethods: [
    "loadMcpFromUserDirectory",
    "listWorkspaceMcpServerStatuses",
    "saveMcpToUserDirectory",
    "listLocalUserMcpCandidates",
    "listRemoteUserMcpStatuses",
    "exportMcpServers",
    "checkRemoteUserMcpWriteAccess",
    "importMcpServers",
  ],
  argumentValidators: {
    loadMcpFromUserDirectory: (args) => {
      // request 可选（缺省读取默认目录）；字段全部可选，只校验对象形态。
      if (args.length > 1) throw new Error("expected at most one request object");
      if (args[0] !== undefined) requireRecordField(args[0], "request");
    },
    listWorkspaceMcpServerStatuses: (args) => {
      const params = requireParams(args);
      requireString(params.workspacePath, "workspacePath");
      requireOptionalString(params.workspaceIdentity, "workspaceIdentity");
      if (params.mcpServers !== undefined && !Array.isArray(params.mcpServers)) {
        throw new Error("invalid mcpServers");
      }
      requireOptionalString(params.mode, "mode");
    },
    // action/source 为封闭字符串枚举，成员由服务实现校验；边界要求非空字符串。
    saveMcpToUserDirectory: (args) => {
      const payload = requireParams(args);
      requireNonEmptyString(payload.action, "action");
      requireNonEmptyString(payload.source, "source");
      requireNonEmptyString(payload.name, "name");
      if (payload.config !== undefined) requireRecordField(payload.config, "config");
      requireOptionalBoolean(payload.enabled, "enabled");
    },
    listLocalUserMcpCandidates: (args) => requireNoArguments(args),
    listRemoteUserMcpStatuses: (args) => {
      const params = requireParams(args);
      requireStringArray(params.names, "names");
    },
    exportMcpServers: (args) => {
      const params = requireParams(args);
      requireStringArray(params.serverIds, "serverIds");
    },
    checkRemoteUserMcpWriteAccess: (args) => requireNoArguments(args),
    importMcpServers: (args) => {
      const params = requireParams(args);
      // servers 元素为 McpSyncExportedServer 对象；成员级字段由导入实现逐项校验。
      requireRecordArray(params.servers, "servers");
      requireString(params.localHomeDir, "localHomeDir");
      requireOptionalString(params.localWorkspacePath, "localWorkspacePath");
      requireOptionalString(params.remoteWorkspacePath, "remoteWorkspacePath");
      // 类型只允许字面量 false：显式传 true 属契约违规，边界直接拒绝。
      if (params.overwrite !== undefined && params.overwrite !== false) {
        throw new Error("invalid overwrite");
      }
    },
  },
});

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

function requireRecordArray(value: unknown, field: string): void {
  if (!Array.isArray(value) || !value.every((item) => isRecord(item))) {
    throw new Error(`invalid ${field}`);
  }
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
