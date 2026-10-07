import type { ACodeProvider } from "./acode-task-types-core.js";
import { modelSelectionSchema, type ModelSelection } from "./model-selection.js";

export type AgentScope = "built-in" | "workspace" | "user";

export type AgentSource = "built-in" | "user" | "plugin";

/**
 * 内置子智能体名单（apps/acode-cli/specs/builtin-subagent-catalog.md R2/R5）：
 * 核心 TS 内置二名（general-purpose / Explore）+ bundled 官方预置三名（Plan / Verify / Review）。
 * 从本常量派生的键集：模型覆盖的 normalize 与启动迁移（bootstrap subagents /
 * shared subagent-state-migration / services subagentsService）与 GUI 内置判定
 * （经 isBuiltInSubagentName）。CLI 侧保留名单**不经**本常量——bootstrap 以
 * CORE_RESERVED_AGENT_NAMES ∪ bundled 包目录 profile 名派生（bundled-agents.ts，
 * spec R5 包派生语义）。本名单与包目录的耦合由
 * apps/acode-cli/tests/builtin-subagent-catalog.test.mjs 的同集合断言钉住。
 * 联合类型随数组扩展自然加宽，不再新增按字面名硬编码的第二份名单。
 */
export const BUILT_IN_SUBAGENT_NAMES = [
  "general-purpose",
  "Explore",
  "Plan",
  "Verify",
  "Review",
] as const;

export type BuiltInSubagentName = (typeof BUILT_IN_SUBAGENT_NAMES)[number];

/**
 * 名单成员判定单点（builtin-subagent-catalog.md R5/R7）：bootstrap 的覆盖烘焙通道与
 * GUI 的内置判定共用；名单以运行时数组为准，消费方不再对联合手写 cast 或硬编码字面名。
 */
export function isBuiltInSubagentName(name: string): name is BuiltInSubagentName {
  return (BUILT_IN_SUBAGENT_NAMES as readonly string[]).includes(name);
}

export type BuiltInSubagentModelSelectionOverrides = Partial<
  Record<BuiltInSubagentName, ModelSelection>
>;

export type PluginSubagentModelSelectionOverrides = Readonly<Record<string, ModelSelection>>;

/** 正式 reader 只接受结构化覆盖，不在读取时解释旧双 map 或重新匹配 Provider。 */
export function parsePluginSubagentModelSelectionOverrides(
  value: unknown,
): PluginSubagentModelSelectionOverrides {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([id, candidate]) => {
      const selection = modelSelectionSchema.safeParse(candidate);
      return id.startsWith("plugin:") && selection.success ? [[id, selection.data]] : [];
    }),
  );
}

export type AgentPermissionMode = "auto" | "plan";

export type AgentColor =
  | "red"
  | "blue"
  | "green"
  | "yellow"
  | "purple"
  | "orange"
  | "pink"
  | "cyan";

export type SubagentsListMode = "allRuntimeScopes" | "settingsUserOnly";

export interface AgentSummary {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  color?: AgentColor;
  modelSelection?: ModelSelection;
  defaultModelSelection?: ModelSelection;
  modelSelectionOverride?: ModelSelection;
  tools?: string[];
  disallowedTools?: string[];
  injectAgentsMd?: boolean;
  skills?: string[];
  permissionMode?: AgentPermissionMode;
  background?: boolean;
  mcpServers?: unknown[];
  path: string;
  scope: AgentScope;
  source: AgentSource;
  enabled: boolean;
  readOnly?: boolean;
  projectPath?: string;
  pluginId?: string;
  pluginName?: string;
  diagnostics?: AgentDiagnostic[];
}

export interface AgentDiagnostic {
  code: string;
  message: string;
  path?: string;
}

export interface AgentsCapability {
  userScopeAvailable: boolean;
  userScopeReason?: "desktop_only";
}

export interface AgentsListResult {
  agents: AgentSummary[];
  userAgents: AgentSummary[];
  pluginAgents: AgentSummary[];
  capability: AgentsCapability;
  diagnostics?: AgentDiagnostic[];
}

/** Agent 配置，用于创建/更新 agent */
export interface SubAgentConfig {
  name: string;
  description: string;
  systemPrompt: string;
  color?: AgentColor;
  modelSelection?: ModelSelection;
  tools?: string[];
  disallowedTools?: string[];
  injectAgentsMd?: boolean;
  skills?: string[];
  permissionMode?: AgentPermissionMode;
  background?: boolean;
  mcpServers?: unknown[];
}

/** Agent 创建参数 */
export interface AgentCreateParams {
  config: SubAgentConfig;
  provider: ACodeProvider;
  scope?: "user" | "workspace";
  workspacePath?: string;
  workspaceIdentity?: string;
}

/** Agent 更新参数 */
export interface AgentUpdateParams {
  agentId: string;
  config: SubAgentConfig;
  oldFilePath?: string;
  provider: ACodeProvider;
  scope?: "user" | "workspace";
  workspacePath?: string;
  workspaceIdentity?: string;
}

/** Agent 删除参数 */
export interface AgentDeleteParams {
  agentId: string;
  filePath: string;
}

export interface BuiltInSubagentModelOverrideParams {
  agentName: BuiltInSubagentName;
  modelSelection?: ModelSelection;
}

export interface PluginSubagentModelOverrideParams {
  agentId: string;
  modelSelection?: ModelSelection;
}

/**
 * 插件 subagent 的稳定 id：`plugin:<pluginId>:<裸名小写>`。
 * pluginId 为 `<name>@<marketplace>`，不含版本，插件升级后 id 不变，覆盖随之保留。
 * services 与 CLI bootstrap 都用它做 agents-state.json 的键，必须共用一处实现。
 */
export function createPluginAgentStateId(pluginId: string, agentName: string): string {
  return `plugin:${pluginId}:${agentName.trim().toLowerCase()}`;
}

export function createAgentStateId(input: {
  name: string;
  scope: AgentScope;
  source: AgentSource;
}): string {
  return `${input.source}:${input.scope}:${input.name.trim().toLowerCase()}`;
}
