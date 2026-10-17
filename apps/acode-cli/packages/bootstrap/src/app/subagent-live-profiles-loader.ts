import type { AgentProfile, LoadCurrentSubagentProfiles } from "@acode/core";
import {
  type BuiltInSubagentModelSelectionOverrides,
  type PluginSubagentModelSelectionOverrides,
} from "@acode/shared";
import type { PluginMetadata } from "@acode/contracts";
import { applyPluginAgentModelOverrides } from "../subagent-plugin-overrides.js";

/**
 * 派生边界 live 刷新的组合工厂（specs/agent-teams-derived-config.md R6）。
 * 从 runtime-config.ts 拆出（架构 ratchet 400 行上限，spec R8）；磁盘读取全部
 * 经注入的 loadCurrentProfiles 承担，本模块是纯组合、可直接单测。
 */

/** 派生边界读取到的最新已提交配置快照；字段是 core 消费所需的最小面。 */
export interface LiveSubagentProfilesSnapshot {
  builtInModelSelectionOverrides: BuiltInSubagentModelSelectionOverrides;
  pluginAgentModelSelectionOverrides: PluginSubagentModelSelectionOverrides;
  profiles: readonly AgentProfile[];
}

/**
 * 构造 core 的派生边界读取回调（纯组合，不读磁盘）。每次新派生子 Agent 时：
 * 1. 由调用方注入的 `loadCurrentProfiles` 异步读取最新 Markdown 与 agents-state
 *    （含 bundled 成员的最新禁用过滤与覆盖烘焙，见 subagent-live-state.ts）；
 * 2. 用**启动时无覆盖的插件基线**套用最新插件/general-purpose 覆盖——基线只取一次，
 *    避免把启动时烘焙进 profile 的旧插件覆盖在覆盖被删除后继续保留；
 * 3. 按启动装配的同一顺序拼接：调用方显式 profiles → 最新磁盘 profiles（bundled →
 *    user → project）→ 最新插件 profiles；内置覆盖沿用「最新磁盘状态被调用方显式
 *    覆盖压过」的优先级。
 *
 * 插件目录/启停/配置仍来自启动快照，本回调只刷新模型覆盖，不重新扫描插件。
 */
export function createLiveSubagentProfilesLoader(input: {
  callerBuiltInModelSelectionOverrides?: BuiltInSubagentModelSelectionOverrides;
  callerProfiles?: readonly AgentProfile[];
  loadCurrentProfiles: (agentType: string) => Promise<LiveSubagentProfilesSnapshot>;
  pluginProfiles: readonly AgentProfile[];
  plugins: readonly PluginMetadata[];
}): LoadCurrentSubagentProfiles {
  return async (agentType) => {
    const current = await input.loadCurrentProfiles(agentType);
    const pluginProfiles = applyPluginAgentModelOverrides({
      profiles: input.pluginProfiles,
      plugins: input.plugins,
      modelSelectionOverrides: current.pluginAgentModelSelectionOverrides,
      builtInModelSelectionOverrides: current.builtInModelSelectionOverrides,
    });
    const reservedNames = new Set([
      ...(input.callerProfiles ?? []).map((profile) => profile.name),
      ...current.profiles.map((profile) => profile.name),
    ]);
    const canonicalPaths = new Set(
      pluginProfiles
        .filter((profile) =>
          input.plugins.some((plugin) => profile.name.startsWith(`${plugin.name}:`)),
        )
        .map((profile) => profile.path),
    );
    // 裸名别名与 caller/磁盘最新 profile 同名时让位（用户会话中新建的同名 agent
    // 不再被插件别名遮蔽）；命名空间副本始终保留。
    const availablePluginProfiles = pluginProfiles.filter(
      (profile) =>
        !reservedNames.has(profile.name) ||
        !profile.path ||
        !canonicalPaths.has(profile.path) ||
        input.plugins.some((plugin) => profile.name.startsWith(`${plugin.name}:`)),
    );
    return {
      builtInModelSelectionOverrides: {
        ...current.builtInModelSelectionOverrides,
        ...input.callerBuiltInModelSelectionOverrides,
      },
      profiles: [...(input.callerProfiles ?? []), ...current.profiles, ...availablePluginProfiles],
    };
  };
}
