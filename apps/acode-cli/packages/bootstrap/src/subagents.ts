import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { migrateUserSubagentMarkdown, migrateSubagentStateFile } from "@acode/shared/node";
import {
  parseAgentProfileFromMarkdown,
  type AgentProfile,
  type AgentProfileParseDiagnostic,
} from "@acode/core";
import type { Logger, PluginMetadata } from "@acode/contracts";
import {
  BUILT_IN_SUBAGENT_NAMES,
  createAgentStateId,
  createPluginAgentStateId,
  parsePluginSubagentModelSelectionOverrides,
  modelSelectionSchema,
  type BuiltInSubagentModelSelectionOverrides,
  type PluginSubagentModelSelectionOverrides,
} from "@acode/shared";
// 保留名单与 bundled 覆盖烘焙的判据同住 bundled 目录模块（架构 ratchet：
// 本文件受 400 行上限约束，目录相关辅助归 app/bundled-agents.ts 单一事实源）。
import {
  CORE_RESERVED_AGENT_NAMES,
  resolveBundledProfileModelSelection,
} from "./app/bundled-agents.js";

interface LoadACodeAgentProfilesInput {
  /**
   * 官方预置 agent（bundled 包 agents/ 目录解析结果，specs/builtin-subagent-catalog.md R5）。
   * 由 create-app 装配时先经 resolveBundledAgentProfiles 解析再传入，
   * 避免 bootstrap 内部两处各自解析 pack root；插入 profiles 数组最前。
   */
  bundledProfiles?: readonly AgentProfile[];
  logger?: Logger;
  storageRoot: string;
  workingDirectory: string;
}

interface LoadACodeAgentProfilesResult {
  builtInModelSelectionOverrides: BuiltInSubagentModelSelectionOverrides;
  pluginAgentModelSelectionOverrides: PluginSubagentModelSelectionOverrides;
  diagnostics: AgentProfileParseDiagnostic[];
  profiles: AgentProfile[];
}

interface LoadPluginAgentProfilesInput {
  logger?: Logger;
  plugins: readonly PluginMetadata[];
  reservedProfileNames?: Iterable<string>;
  /** 来自已完成存储迁移的启动快照；不在插件 loader 另读磁盘或查询账号。 */
  modelSelectionOverrides?: PluginSubagentModelSelectionOverrides;
}

interface ParsedPluginAgentProfile {
  bareName: string;
  plugin: PluginMetadata;
  profile: AgentProfile;
}

export async function loadACodeAgentProfiles(
  input: LoadACodeAgentProfilesInput,
): Promise<LoadACodeAgentProfilesResult> {
  const migration = await migrateUserSubagentMarkdown(join(input.storageRoot, "agents"));
  await migrateSubagentStateFile(join(input.storageRoot, "v2", "agents-state.json"));
  const roots = [
    { path: join(input.storageRoot, "agents"), source: "user" as const },
    { path: join(input.workingDirectory, ".acode", "agents"), source: "project" as const },
  ];
  const diagnostics: AgentProfileParseDiagnostic[] = [];
  for (const failure of migration.failures) {
    diagnostics.push({
      code: "agent_read_failed",
      message: "Subagent Markdown migration failed; original file preserved",
      path: failure.path,
    });
    input.logger?.warn("Subagent Markdown migration failed", {
      module: "bootstrap.subagents",
      path: failure.path,
      error: String(failure.error),
    });
  }
  const agentState = readAgentState(input.storageRoot);
  const profiles: AgentProfile[] = [];

  // 合并序（R5）：核心内置（normalizeAgentProfiles 播种）< bundled < user < project。
  // bundled 插数组最前，user/project 同名整体覆盖；禁用的 bundled profile 不装配。
  for (const bundledProfile of input.bundledProfiles ?? []) {
    if (isDisabledUserProfile(bundledProfile, agentState.disabledAgentIds)) {
      continue;
    }
    // 场景 6（builtin-subagent-catalog.md）：GUI 内置模型覆盖在装配期烘焙到 bundled 成员。
    // normalizeAgentProfiles 只对播种的核心二内置应用 overrides，不在这里烘焙则
    // Plan/Verify/Review 的覆盖只会持久化、派发时不生效。与 loadPluginAgentProfiles
    // 的 plugin override 同款烘焙模式；user/project 同名 markdown 在数组后方整体替换
    // 本条目，覆盖不随迁移——替换后走用户自己的模型选择语义。
    const modelSelection = resolveBundledProfileModelSelection(
      bundledProfile,
      agentState.builtInModelSelectionOverrides,
    );
    profiles.push(modelSelection ? { ...bundledProfile, modelSelection } : bundledProfile);
  }

  for (const root of roots) {
    for (const filePath of listMarkdownFiles(root.path)) {
      const content = readFileSync(filePath, "utf8");
      const result = parseAgentProfileFromMarkdown({
        content,
        path: filePath,
        source: root.source,
      });
      if (result.diagnostic) {
        diagnostics.push(result.diagnostic);
        input.logger?.warn("Agent profile diagnostic", {
          code: result.diagnostic.code,
          message: result.diagnostic.message,
          module: "bootstrap.subagents",
          path: filePath,
        });
      }
      if (result.profile) {
        const profile = sanitizeProjectAgentProfile(result.profile);
        if (isDisabledUserProfile(profile, agentState.disabledAgentIds)) {
          continue;
        }
        profiles.push(profile);
      }
    }
  }

  input.logger?.debug("Agent profiles loaded", {
    diagnosticCount: diagnostics.length,
    module: "bootstrap.subagents",
    profileCount: profiles.length,
  });

  return {
    builtInModelSelectionOverrides: agentState.builtInModelSelectionOverrides,
    pluginAgentModelSelectionOverrides: agentState.pluginAgentModelSelectionOverrides,
    diagnostics,
    profiles,
  };
}

function sanitizeProjectAgentProfile(profile: AgentProfile): AgentProfile {
  if (profile.source !== "project" || profile.permissionMode === undefined) {
    return profile;
  }

  // 项目级 .acode/agents/*.md 是仓库内容，不能通过 frontmatter
  // 把 child runtime 切到 bypass/yolo；用户级与受信插件 profile 不受影响。
  const { permissionMode: _permissionMode, ...safeProfile } = profile;
  return safeProfile;
}

export function loadPluginAgentProfiles(
  input: LoadPluginAgentProfilesInput,
): LoadACodeAgentProfilesResult {
  const diagnostics: AgentProfileParseDiagnostic[] = [];
  const parsedProfiles: ParsedPluginAgentProfile[] = [];
  const reservedProfileNames = new Set([
    ...CORE_RESERVED_AGENT_NAMES,
    ...(input.reservedProfileNames ?? []),
  ]);

  for (const plugin of input.plugins) {
    if (!plugin.enabled) continue;
    const agents = plugin.components.find((group) => group.kind === "agent")?.items ?? [];
    for (const agent of agents) {
      const filePath = join(plugin.rootPath, "agents", `${agent.name}.md`);
      const result = parsePluginAgentProfile({ filePath, logger: input.logger, plugin });
      if (result.diagnostic) diagnostics.push(result.diagnostic);
      if (result.parsed) parsedProfiles.push(result.parsed);
    }
  }

  const bareNameCounts = countBareProfileNames(parsedProfiles);
  const profiles: AgentProfile[] = [];
  for (const parsed of parsedProfiles) {
    const override =
      input.modelSelectionOverrides?.[createPluginAgentStateId(parsed.plugin.id, parsed.bareName)];
    // 先替换完整选择再展开别名，避免同一插件的两个调用入口使用不同模型/档位。
    const canonical = {
      ...namespacePluginAgentProfile(parsed),
      ...(override ? { modelSelection: override } : {}),
    };
    profiles.push(canonical);

    const bareName = parsed.bareName.trim();
    if (bareNameCounts.get(bareName) === 1 && !reservedProfileNames.has(bareName)) {
      profiles.push({ ...canonical, name: bareName });
    } else if (reservedProfileNames.has(bareName)) {
      diagnostics.push({
        code: "agent_ambiguous_name",
        message: `Plugin agent bare name conflicts with an existing profile; use ${canonical.name}: ${bareName}`,
        path: canonical.path,
      });
    } else if ((bareNameCounts.get(bareName) ?? 0) > 1) {
      diagnostics.push({
        code: "agent_ambiguous_name",
        message: `Plugin agent bare name is ambiguous; use ${canonical.name}: ${bareName}`,
        path: canonical.path,
      });
    }
  }

  input.logger?.debug("Plugin agent profiles loaded", {
    diagnosticCount: diagnostics.length,
    module: "bootstrap.subagents",
    profileCount: profiles.length,
  });

  return {
    builtInModelSelectionOverrides: {},
    pluginAgentModelSelectionOverrides: {},
    diagnostics,
    profiles,
  };
}

function parsePluginAgentProfile(input: {
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

function namespacePluginAgentProfile(parsed: ParsedPluginAgentProfile): AgentProfile {
  return {
    ...parsed.profile,
    name: `${parsed.plugin.name}:${parsed.bareName}`,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function countBareProfileNames(
  parsedProfiles: readonly ParsedPluginAgentProfile[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const parsed of parsedProfiles) {
    const name = parsed.bareName.trim();
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return counts;
}

function readAgentState(storageRoot: string): {
  builtInModelSelectionOverrides: BuiltInSubagentModelSelectionOverrides;
  pluginAgentModelSelectionOverrides: PluginSubagentModelSelectionOverrides;
  disabledAgentIds: Set<string>;
} {
  try {
    const raw = readFileSync(join(storageRoot, "v2", "agents-state.json"), "utf8");
    const parsed = JSON.parse(raw) as {
      builtInModelSelectionOverrides?: unknown;
      pluginAgentModelSelectionOverrides?: unknown;
      disabledAgentIds?: unknown;
    };
    return {
      pluginAgentModelSelectionOverrides: parsePluginSubagentModelSelectionOverrides(
        parsed.pluginAgentModelSelectionOverrides,
      ),
      builtInModelSelectionOverrides: normalizeBuiltInSelectionOverrides(
        parsed.builtInModelSelectionOverrides,
      ),
      disabledAgentIds: new Set(
        Array.isArray(parsed.disabledAgentIds)
          ? parsed.disabledAgentIds.filter(
              (id): id is string => typeof id === "string" && id.trim().length > 0,
            )
          : [],
      ),
    };
  } catch {
    return {
      builtInModelSelectionOverrides: {},
      pluginAgentModelSelectionOverrides: {},
      disabledAgentIds: new Set(),
    };
  }
}

function normalizeBuiltInSelectionOverrides(
  structured: unknown,
): BuiltInSubagentModelSelectionOverrides {
  const result: BuiltInSubagentModelSelectionOverrides = {};
  const structuredRecord = isRecord(structured) ? structured : {};
  // R5：键集单点来自 shared 的 BUILT_IN_SUBAGENT_NAMES（含 bundled 三成员），
  // 不再按字面二名硬编码；旧 state 文件的未知键照既有 safeParse 方向忽略不报错。
  for (const name of BUILT_IN_SUBAGENT_NAMES) {
    const parsed = modelSelectionSchema.safeParse(structuredRecord[name]);
    if (parsed.success) {
      result[name] = parsed.data;
    }
  }
  return result;
}

function isDisabledUserProfile(
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
  // R5：bundled 预置 agent 是 source "built-in" 且 path 指向包内实际文件的 profile，
  // 可被 disabledAgentIds 禁用；核心 TS 内置二名无 path，维持不可禁用现状。
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

function listMarkdownFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  if (!statSync(root).isDirectory()) return [];

  const result: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      result.push(...listMarkdownFiles(path));
      continue;
    }
    if (entry.isFile() && /\.(md|markdown)$/iu.test(entry.name)) {
      result.push(path);
    }
  }
  return result.sort((left, right) => left.localeCompare(right));
}
