import type {
  ACodeAgentMcpServer,
  ACodeAutomationScheduleRule,
  ACodeMcpListMode,
  ModelSelection,
} from "@acode/shared";

export interface ACodeAgentWorkspaceTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  /** 远程 workspace 的运行时会话身份；只用于隔离/路由，不能替代 workspacePath。 */
  remoteSessionId?: string;
}

export interface ACodeAgentPluginViewParams extends ACodeAgentWorkspaceTarget {
  configScope?: "user" | "workspace";
}

export interface ACodeAgentListMcpServerStatusesParams extends ACodeAgentWorkspaceTarget {
  mcpServers?: ACodeAgentMcpServer[];
  mode?: ACodeMcpListMode;
}

export interface ACodeAgentAddPluginMarketplaceParams extends ACodeAgentWorkspaceTarget {
  dryRun?: boolean;
  operationId?: string;
  source: string;
}

export interface ACodeAgentRemovePluginMarketplaceParams extends ACodeAgentWorkspaceTarget {
  marketplace: string;
}

export interface ACodeAgentUpdatePluginMarketplaceParams extends ACodeAgentWorkspaceTarget {
  marketplace?: string;
  operationId?: string;
}

export interface ACodeAgentInstallPluginParams extends ACodeAgentWorkspaceTarget {
  dryRun?: boolean;
  marketplace: string;
  operationId?: string;
  pluginName: string;
  scope?: "user" | "workspace";
}

export interface ACodeAgentCancelPluginOperationParams {
  operationId: string;
}

export interface ACodeAgentUninstallPluginParams extends ACodeAgentWorkspaceTarget {
  marketplace?: string;
  pluginId?: string;
  pluginName?: string;
  removeCache?: boolean;
}

export interface ACodeAgentUpdatePluginParams extends ACodeAgentWorkspaceTarget {
  pluginId?: string;
  marketplace?: string;
}

export interface ACodeAgentRestoreBuiltinPluginParams extends ACodeAgentWorkspaceTarget {
  pluginId: string;
}

export interface ACodeAgentConfigurePluginParams extends ACodeAgentWorkspaceTarget {
  clearOptionKeys?: string[];
  dryRun?: boolean;
  options: Record<string, unknown>;
  pluginId: string;
  scope?: "user" | "workspace";
}

export interface ACodeAgentResetPluginConfigParams extends ACodeAgentWorkspaceTarget {
  pluginId: string;
  scope?: "user" | "workspace";
}

export interface ACodeAgentValidatePluginParams extends ACodeAgentWorkspaceTarget {
  marketplace?: string;
  pluginName?: string;
  source?: string;
}

export interface ACodeAgentDescribePluginParams extends ACodeAgentWorkspaceTarget {
  marketplace: string;
  pluginName: string;
}

export interface ACodeAgentSetPluginEnabledParams extends ACodeAgentWorkspaceTarget {
  enabled: boolean;
  operationId?: string;
  pluginId: string;
  scope?: "user" | "workspace";
}

// Plugin 对话引用 catalog：
// 带 sessionId → session-owned 冻结 catalog（必须路由到持有该 session 的 workspace client）；
// 不带 → workspace 当前 catalog（新建草稿 Picker）。
export interface ACodeAgentPluginReferenceCatalogParams extends ACodeAgentWorkspaceTarget {
  sessionId?: string;
}

// Composer Skill catalog：与 Plugin 引用相同，以 sessionId 区分 workspace 当前目录和
// resident Session runtime 快照；不参与 Settings 管理目录。
export interface ACodeAgentSkillReferenceCatalogParams extends ACodeAgentWorkspaceTarget {
  sessionId?: string;
}
export interface ACodeAgentResolveSuggestedPluginReferenceParams extends ACodeAgentWorkspaceTarget {
  stableId: string;
  operationId: string;
  clientMode: "desktop-continuous" | "web-remote-replayable";
  deliveryKind: "desktop-continuous" | "web-remote-replayable";
}

// ---- 定时任务(automation)管理参数 ----

export interface ACodeAgentCreateAutomationParams extends ACodeAgentWorkspaceTarget {
  title: string;
  cronExpr: string;
  relativeDelayMinutes?: number;
  prompt: string;
  modelSelection?: ModelSelection;
  mode?: string;
  recurring?: boolean;
  maxRuns?: number;
  endAt?: number;
  scheduleRule?: ACodeAutomationScheduleRule;
}

export interface ACodeAgentUpdateAutomationParams extends ACodeAgentWorkspaceTarget {
  automationId: string;
  title?: string;
  cronExpr?: string;
  prompt?: string;
  modelSelection?: ModelSelection | null;
  mode?: string | null;
  recurring?: boolean;
  maxRuns?: number | null;
  endAt?: number | null;
  scheduleRule?: ACodeAutomationScheduleRule | null;
  scheduleEditedByUser?: boolean;
}

export interface ACodeAgentAutomationIdParams extends ACodeAgentWorkspaceTarget {
  automationId: string;
}

export interface ACodeAgentSetAutomationEnabledParams extends ACodeAgentWorkspaceTarget {
  automationId: string;
  enabled: boolean;
}

export interface ACodeAgentDeleteAutomationRunParams extends ACodeAgentWorkspaceTarget {
  runId: string;
}
