// workspace 授权/配置同步面的 v4 handler（apps/acode-cli/specs/m2-8-workspace-provider-process.md）。
//
// 实体自 legacy `acode-protocol/` 的 interaction-preferences.ts / model-io-preferences.ts /
// off-peak-tool-policy.ts / dynamic-workflow-policy.ts 逐字迁入（M2-8：实体放 v4 目录，
// server.ts 只留一行转发，不在待删目录留实体债）。唯一改动：params 改 parse v4 schema
// （形状与 legacy 逐字 parity）。
import {
  v4WorkspaceUpdateDynamicWorkflowPolicyParamsSchema,
  v4WorkspaceUpdateInteractionPreferencesParamsSchema,
  v4WorkspaceUpdateModelIoPreferencesParamsSchema,
  v4WorkspaceUpdateOffPeakToolPolicyParamsSchema,
  type V4WorkspaceUpdateDynamicWorkflowPolicyResult,
  type V4WorkspaceUpdateInteractionPreferencesResult,
  type V4WorkspaceUpdateModelIoPreferencesResult,
  type V4WorkspaceUpdateOffPeakToolPolicyResult,
} from "@acode/shared/acode-protocol-v4";
import {
  parseParams,
  type ACodeProtocolAgentServerContext,
} from "./server-types.js";

/**
 * 应用 workspace 交互偏好。CLI 进程按 workspace 隔离，因此 registry 是该 workspace
 * 内主任务、后台任务与子 Agent 共用的权威 gate。
 */
export async function updateInteractionPreferencesV4(
  context: ACodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<V4WorkspaceUpdateInteractionPreferencesResult> {
  const params = parseParams(v4WorkspaceUpdateInteractionPreferencesParamsSchema, rawParams);
  const enabled = params.preferences.askUserQuestionAutoResolutionEnabled;
  context.appRuntimePreferences.askUserQuestionAutoResolutionEnabled = enabled;
  const snoozedInteractionCount =
    await context.v4Interactions.setAskUserQuestionAutoResolutionEnabled(enabled);

  return {
    workspace: params.workspace,
    askUserQuestionAutoResolutionEnabled: enabled,
    snoozedInteractionCount,
  };
}

/**
 * ModelIO 写盘策略是 App 全局偏好，但每个 resident session 持有独立 adapter。
 * 因此协议层同时缓存偏好供未来 session 继承，并立即更新已有 session，避免新旧任务行为分裂。
 */
export async function updateModelIoPreferencesV4(
  context: ACodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<V4WorkspaceUpdateModelIoPreferencesResult> {
  const params = parseParams(v4WorkspaceUpdateModelIoPreferencesParamsSchema, rawParams);
  const enabled = params.preferences.fullRetentionEnabled;
  context.appRuntimePreferences.modelIoFullRetentionEnabled = enabled;

  let updatedSessionCount = 0;
  for (const record of context.sessions.values()) {
    if (!record.app.setModelIoFullRetentionEnabled) continue;
    record.app.setModelIoFullRetentionEnabled(enabled);
    updatedSessionCount += 1;
  }

  return {
    workspace: params.workspace,
    fullRetentionEnabled: enabled,
    updatedSessionCount,
  };
}

/**
 * Off-Peak 工具面门禁（灰度有效 && 本地 workspace）是 workspace 级事实。CLI 进程按 workspace
 * 隔离，因此缓存一份即可；createRecord 对 legacy create/resume、v4 createSession 与 v4 冷恢复
 * （subscribe → resumePersistedSession，没有 host 参数通道）统一读取。
 * 只影响之后创建/恢复的 record；已活跃 record 的工具面不回收（与灰度中途翻转策略一致）。
 */
export async function updateOffPeakToolPolicyV4(
  context: ACodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<V4WorkspaceUpdateOffPeakToolPolicyResult> {
  const params = parseParams(v4WorkspaceUpdateOffPeakToolPolicyParamsSchema, rawParams);
  context.appRuntimePreferences.offPeakToolEnabled = params.enabled;
  return { workspace: params.workspace, enabled: params.enabled };
}

/**
 * 动态工作流灰度门。判定权在 Host：
 * 它读 `/client/configs` 的 `dynamicWorkflow.mode`，CLI 只缓存结论，从不读 feature key
 * 或本地覆盖环境变量。与 off-peak 同构：CLI 进程按 workspace 隔离，
 * 缓存一份即可；createRecord 对 legacy create/resume、v4 createSession 与 v4 冷恢复
 * （subscribe → resumePersistedSession，没有 host 参数通道）统一读取。
 * 只影响之后创建/恢复的 record；已活跃 record 的工具面不回收（灰度中途翻转策略一致）。
 */
export async function updateDynamicWorkflowPolicyV4(
  context: ACodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<V4WorkspaceUpdateDynamicWorkflowPolicyResult> {
  const params = parseParams(v4WorkspaceUpdateDynamicWorkflowPolicyParamsSchema, rawParams);
  context.appRuntimePreferences.dynamicWorkflowEnabled = params.enabled;
  return { workspace: params.workspace, enabled: params.enabled };
}
