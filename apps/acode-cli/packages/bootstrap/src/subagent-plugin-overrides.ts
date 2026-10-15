import { readFileSync } from "node:fs";
import { basename, extname, isAbsolute, relative } from "node:path";
import {
  parseAgentProfileFromMarkdown,
  type AgentProfile,
  type AgentProfileParseDiagnostic,
} from "@acode/core";
import type { Logger, PluginMetadata } from "@acode/contracts";
import {
  createPluginAgentStateId,
  type BuiltInSubagentModelSelectionOverrides,
  type PluginSubagentModelSelectionOverrides,
} from "@acode/shared";

/**
 * 插件 Agent profile 的构造与模型覆盖单点（specs/agent-teams-derived-config.md R3/R4）。
 * 启动装配（subagents.ts 的 loadPluginAgentProfiles）与派生边界 live 刷新
 * （app/subagent-live-profiles-loader.ts）共用本模块，保证两处选择优先级同源；
 * 任何一侧都不得另写第二套覆盖规则。
 */

export interface ApplyPluginAgentModelOverridesInput {
  profiles: readonly AgentProfile[];
  plugins: readonly PluginMetadata[];
  modelSelectionOverrides?: PluginSubagentModelSelectionOverrides;
  builtInModelSelectionOverrides?: BuiltInSubagentModelSelectionOverrides;
}

export interface ParsedPluginAgentProfile {
  bareName: string;
  plugin: PluginMetadata;
  profile: AgentProfile;
}

interface PluginProfileIdentity {
  bareName: string;
  plugin: PluginMetadata;
}

/**
 * 把最新插件 Agent 模型覆盖应用到缓存下来的插件基线 profile（纯函数，不读磁盘）。
 *
 * 选择优先级与启动时一致：插件专属覆盖 > AgentTeams 成员在 `!inheritCaptainModel`
 * 时的 general-purpose 回退 > profile 自身基线模型。成员在不能继承队长模型时必须带
 * `requireExplicitModelSelection`，缺少配置就 fail closed。别名副本与命名空间副本共享
 * 同一份 Markdown，必须一起改写；除模型选择与显式标记外，permissionMode、颜色、工具、
 * MCP 权限等字段原样保留。
 */
export function applyPluginAgentModelOverrides(
  input: ApplyPluginAgentModelOverridesInput,
): AgentProfile[] {
  const resolveIdentity = createPluginProfileIdentityResolver(input.profiles, input.plugins);
  return input.profiles.map((profile) => {
    const identity = resolveIdentity(profile);
    return identity ? applyPluginOverrideToProfile(profile, identity, input) : profile;
  });
}

function applyPluginOverrideToProfile(
  profile: AgentProfile,
  identity: PluginProfileIdentity,
  input: ApplyPluginAgentModelOverridesInput,
): AgentProfile {
  const override =
    input.modelSelectionOverrides?.[
      createPluginAgentStateId(identity.plugin.id, identity.bareName)
    ];
  // AgentTeams 成员仍用自身 profile（含团队 MCP 工具与权限）；只借用用户已配置的
  // general-purpose 模型选择。没有已配置子智能体模型时不能误继承队长模型。
  const teamMember = identity.plugin.name === "agent-teams" && identity.bareName === "member";
  const inheritCaptainModel = identity.plugin.configuredOptions?.inheritCaptainModel === true;
  const configuredSelection =
    override ??
    (teamMember && !inheritCaptainModel
      ? input.builtInModelSelectionOverrides?.["general-purpose"]
      : undefined);
  const withSelection: AgentProfile = configuredSelection
    ? { ...profile, modelSelection: configuredSelection }
    : profile;

  if (!teamMember) {
    return withSelection;
  }
  if (inheritCaptainModel) {
    // 显式继承队长模型：成员不再需要 fail-closed 标记，回到既有父模型继承规则。
    const { requireExplicitModelSelection: _requireExplicitModelSelection, ...inherited } =
      withSelection;
    return inherited;
  }
  return { ...withSelection, requireExplicitModelSelection: true };
}

/**
 * 识别缓存 profile 属于哪个插件 Agent。命名空间副本按 `${plugin.name}:` 前缀解析；
 * 裸名别名不带前缀，靠它与命名空间副本共享同一份 Markdown（`path`）来复用身份——
 * 覆盖键必须与启动装配一致地取 frontmatter 名，而不是文件名。最后才回退到插件根目录
 * 包含关系（取文件 stem）。无法归属的 profile 原样返回，避免误改用户/项目 profile。
 */
function createPluginProfileIdentityResolver(
  profiles: readonly AgentProfile[],
  plugins: readonly PluginMetadata[],
): (profile: AgentProfile) => PluginProfileIdentity | undefined {
  const namespacedPlugins = plugins
    .map((plugin) => ({ plugin, prefix: `${plugin.name}:` }))
    .sort((left, right) => right.prefix.length - left.prefix.length);
  const pluginRoots = plugins
    .map((plugin) => ({ plugin, root: plugin.rootPath }))
    .sort((left, right) => right.root.length - left.root.length);
  const byPath = new Map<string, PluginProfileIdentity>();
  for (const profile of profiles) {
    const identity = resolveNamespacedIdentity(profile, namespacedPlugins);
    if (identity && profile.path) byPath.set(profile.path, identity);
  }

  return (profile) =>
    resolveNamespacedIdentity(profile, namespacedPlugins) ??
    (profile.path ? byPath.get(profile.path) : undefined) ??
    resolvePluginRootIdentity(profile, pluginRoots);
}

function resolveNamespacedIdentity(
  profile: AgentProfile,
  namespacedPlugins: readonly { plugin: PluginMetadata; prefix: string }[],
): PluginProfileIdentity | undefined {
  for (const { plugin, prefix } of namespacedPlugins) {
    if (profile.name.startsWith(prefix) && profile.name.length > prefix.length) {
      return { bareName: profile.name.slice(prefix.length), plugin };
    }
  }
  return undefined;
}

function resolvePluginRootIdentity(
  profile: AgentProfile,
  pluginRoots: readonly { plugin: PluginMetadata; root: string }[],
): PluginProfileIdentity | undefined {
  if (!profile.path) return undefined;
  for (const { plugin, root } of pluginRoots) {
    if (!isPathInside(root, profile.path)) continue;
    // 插件 Agent 的裸名就是 Markdown 文件 stem（frontmatter name 与文件名一致）。
    return { bareName: basename(profile.path, extname(profile.path)), plugin };
  }
  return undefined;
}

function isPathInside(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath.length > 0 && !relativePath.startsWith("..") && !isAbsolute(relativePath);
}

export function parsePluginAgentProfile(input: {
  filePath: string;
  logger?: Logger;
  plugin: PluginMetadata;
}): { diagnostic?: AgentProfileParseDiagnostic; parsed?: ParsedPluginAgentProfile } {
  try {
    const content = readFileSync(input.filePath, "utf8");
    const result = parseAgentProfileFromMarkdown({
      content,
      path: input.filePath,
      source: "user",
    });
    if (result.diagnostic) {
      input.logger?.warn("Plugin agent profile diagnostic", {
        code: result.diagnostic.code,
        message: result.diagnostic.message,
        module: "bootstrap.subagents",
        path: input.filePath,
        pluginId: input.plugin.id,
      });
      if (!result.profile) return { diagnostic: result.diagnostic };
    }
    if (!result.profile) return {};
    return {
      ...(result.diagnostic ? { diagnostic: result.diagnostic } : {}),
      parsed: {
        bareName: result.profile.name,
        plugin: input.plugin,
        profile: result.profile,
      },
    };
  } catch (error) {
    return {
      diagnostic: {
        code: "agent_read_failed",
        message:
          error instanceof Error ? error.message : `Failed to read plugin agent: ${input.filePath}`,
        path: input.filePath,
      },
    };
  }
}

export function namespacePluginAgentProfile(parsed: ParsedPluginAgentProfile): AgentProfile {
  return {
    ...parsed.profile,
    name: `${parsed.plugin.name}:${parsed.bareName}`,
  };
}

export function countBareProfileNames(
  parsedProfiles: readonly ParsedPluginAgentProfile[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const parsed of parsedProfiles) {
    const name = parsed.bareName.trim();
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return counts;
}
