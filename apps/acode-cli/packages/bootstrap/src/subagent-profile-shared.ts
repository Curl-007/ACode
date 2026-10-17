import type { AgentProfile, AgentProfileParseDiagnostic } from "@acode/core";
import {
  createAgentStateId,
  type BuiltInSubagentModelSelectionOverrides,
  type PluginSubagentModelSelectionOverrides,
} from "@acode/shared";

/**
 * 启动装配（subagents.ts）与派生边界 live 重读（subagent-live-state.ts）共用的
 * profile 卫生谓词与状态形状。单点持有，两条链路不得各写第二份判据
 * （specs/agent-teams-derived-config.md 状态所有者节）。
 */

/** agents-state.json 读取结果形状（启动宽松版与 live 严格版同构）。 */
export interface AgentStateSnapshot {
  builtInModelSelectionOverrides: BuiltInSubagentModelSelectionOverrides;
  pluginAgentModelSelectionOverrides: PluginSubagentModelSelectionOverrides;
  disabledAgentIds: Set<string>;
}

/** 启动装配与派生边界 live 重读的返回值共用形状。 */
export interface LoadACodeAgentProfilesResult {
  builtInModelSelectionOverrides: BuiltInSubagentModelSelectionOverrides;
  pluginAgentModelSelectionOverrides: PluginSubagentModelSelectionOverrides;
  diagnostics: AgentProfileParseDiagnostic[];
  profiles: AgentProfile[];
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function sanitizeProjectAgentProfile(profile: AgentProfile): AgentProfile {
  if (profile.source !== "project" || profile.permissionMode === undefined) {
    return profile;
  }

  // 项目级 .acode/agents/*.md 是仓库内容，不能通过 frontmatter
  // 把 child runtime 切到 bypass/yolo；用户级与受信插件 profile 不受影响。
  const { permissionMode: _permissionMode, ...safeProfile } = profile;
  return safeProfile;
}

export function isDisabledUserProfile(
  profile: AgentProfile,
  disabledAgentIds: ReadonlySet<string>,
): boolean {
  if (profile.source === "user") {
    return disabledAgentIds.has(
      createAgentStateId({
        name: profile.name,
        scope: "user",
        source: "user",
      }),
    );
  }
  // R5（builtin-subagent-catalog.md）：bundled 预置 agent 是 source "built-in" 且 path
  // 指向包内实际文件的 profile，可被 disabledAgentIds 禁用；核心 TS 内置二名无 path，
  // 维持不可禁用现状。
  if (profile.source === "built-in" && profile.path !== undefined) {
    return disabledAgentIds.has(
      createAgentStateId({
        name: profile.name,
        scope: "built-in",
        source: "built-in",
      }),
    );
  }
  return false;
}
