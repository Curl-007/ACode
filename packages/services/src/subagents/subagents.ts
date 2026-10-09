import type {
  ACodeProvider,
  AgentSummary,
  AgentsListResult,
  AgentCreateParams,
  AgentUpdateParams,
  AgentDeleteParams,
  BuiltInSubagentModelOverrideParams,
  PluginSubagentModelOverrideParams,
  SubagentsListMode,
} from "@acode/shared";
import { ServiceChannels } from "@acode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export interface ISubagentsService {
  list(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    provider?: ACodeProvider;
    mode?: SubagentsListMode;
  }): Promise<AgentsListResult>;

  setEnabled(params: { agentId: string; enabled: boolean }): Promise<void>;

  setBuiltInModelOverride(params: BuiltInSubagentModelOverrideParams): Promise<void>;

  /** 只写用户 state 的完整覆盖，不改插件 Markdown。 */
  setPluginAgentModelOverride(params: PluginSubagentModelOverrideParams): Promise<void>;

  /** 当前筛选来源对应的用户级 agent 根目录（与内置扫描顺序一致，取 buildUserRoots 的首项）。 */
  getPrimaryUserAgentsDirectory(params: { provider: ACodeProvider }): Promise<{ path: string }>;

  /** 创建新的 agent 文件 */
  createAgent(params: AgentCreateParams): Promise<{ agent: AgentSummary }>;

  /** 更新现有 agent 文件 */
  updateAgent(params: AgentUpdateParams): Promise<{ agent: AgentSummary }>;

  /** 删除 agent 文件 */
  deleteAgent(params: AgentDeleteParams): Promise<void>;
}

export const ISubagentsService = createServiceDescriptor<ISubagentsService>(
  ServiceChannels.Subagents,
  {
    allowedMethods: [
      "list",
      "setEnabled",
      "setBuiltInModelOverride",
      "setPluginAgentModelOverride",
      "getPrimaryUserAgentsDirectory",
      "createAgent",
      "updateAgent",
      "deleteAgent",
    ],
    argumentValidators: {
      list: (args) => {
        const params = requireParams(args);
        requireString(params.workspacePath, "workspacePath");
        requireOptionalString(params.workspaceIdentity, "workspaceIdentity");
        requireOptionalString(params.provider, "provider");
        requireOptionalString(params.mode, "mode");
      },
      setEnabled: (args) => {
        const params = requireParams(args);
        requireNonEmptyString(params.agentId, "agentId");
        requireBoolean(params.enabled, "enabled");
      },
      setBuiltInModelOverride: (args) => {
        const params = requireParams(args);
        // agentName 为封闭内置名枚举，成员由服务实现校验；边界要求非空字符串。
        requireNonEmptyString(params.agentName, "agentName");
        if (params.modelSelection !== undefined) {
          requireRecordField(params.modelSelection, "modelSelection");
        }
      },
      setPluginAgentModelOverride: (args) => {
        const params = requireParams(args);
        requireNonEmptyString(params.agentId, "agentId");
        if (params.modelSelection !== undefined) {
          requireRecordField(params.modelSelection, "modelSelection");
        }
      },
      getPrimaryUserAgentsDirectory: (args) => {
        const params = requireParams(args);
        requireNonEmptyString(params.provider, "provider");
      },
      createAgent: (args) => {
        const params = requireParams(args);
        // SubAgentConfig 其余字段可选或为受控枚举；边界只挡明显畸形，成员级由实现校验。
        const config = requireRecordField(params.config, "config");
        requireString(config.name, "config.name");
        requireNonEmptyString(params.provider, "provider");
        requireOptionalString(params.workspacePath, "workspacePath");
      },
      updateAgent: (args) => {
        const params = requireParams(args);
        requireNonEmptyString(params.agentId, "agentId");
        const config = requireRecordField(params.config, "config");
        requireString(config.name, "config.name");
        requireNonEmptyString(params.provider, "provider");
        requireOptionalString(params.oldFilePath, "oldFilePath");
        requireOptionalString(params.workspacePath, "workspacePath");
      },
      deleteAgent: (args) => {
        const params = requireParams(args);
        requireNonEmptyString(params.agentId, "agentId");
        // 删除操作的 filePath 为空字符串属明显异常（可能被解析到当前目录），边界要求非空。
        requireNonEmptyString(params.filePath, "filePath");
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
