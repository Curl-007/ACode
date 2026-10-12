/* eslint-disable max-lines -- 启动装配与派生边界读取共用同一套 profile 解析、状态校验与插件覆盖优先级；拆分会复制选择规则，风险高于收益。 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { basename, extname, isAbsolute, join, relative } from "node:path";
import { migrateUserSubagentMarkdown, migrateSubagentStateFile } from "@acode/shared/node";
import {
  parseAgentProfileFromMarkdown,
  type AgentProfile,
  type AgentProfileParseDiagnostic,
} from "@acode/core";
import type { Logger, PluginMetadata } from "@acode/contracts";
import {
  createAgentStateId,
  createPluginAgentStateId,
  parsePluginSubagentModelSelectionOverrides,
  modelSelectionSchema,
  type BuiltInSubagentModelSelectionOverrides,
  type BuiltInSubagentName,
  type PluginSubagentModelSelectionOverrides,
} from "@acode/shared";

interface LoadACodeAgentProfilesInput {
  logger?: Logger;
  storageRoot: string;
  workingDirectory: string;
  agentType?: string;
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
  builtInModelSelectionOverrides?: BuiltInSubagentModelSelectionOverrides;
}

interface ApplyPluginAgentModelOverridesInput {
  profiles: readonly AgentProfile[];
  plugins: readonly PluginMetadata[];
  modelSelectionOverrides?: PluginSubagentModelSelectionOverrides;
  builtInModelSelectionOverrides?: BuiltInSubagentModelSelectionOverrides;
}

interface ParsedPluginAgentProfile {
  bareName: string;
  plugin: PluginMetadata;
  profile: AgentProfile;
}

interface PluginProfileIdentity {
  bareName: string;
  plugin: PluginMetadata;
}

const RESERVED_AGENT_NAMES = new Set(["general-purpose", "Explore"]);

const BUILT_IN_SUBAGENT_NAMES: readonly BuiltInSubagentName[] = ["general-purpose", "Explore"];

export type ACodeAgentConfigErrorCode =
  | "agent_root_unreadable"
  | "agent_profile_unreadable"
  | "agent_profile_invalid"
  | "agents_state_unreadable"
  | "agents_state_malformed";

/**
 * 派生边界读取最新配置时的失败类型：文件不可读、状态损坏或 profile 解析失败都必须
 * 明确拒绝新派生，不能悄悄沿用旧模型或回退父模型。
 */
export class ACodeAgentConfigError extends Error {
  readonly code: ACodeAgentConfigErrorCode;
  readonly diagnostics: AgentProfileParseDiagnostic[];

  constructor(
    code: ACodeAgentConfigErrorCode,
    message: string,
    options: { cause?: unknown; diagnostics?: AgentProfileParseDiagnostic[] } = {},
  ) {
    super(message, options);
    this.name = "ACodeAgentConfigError";
    this.code = code;
    this.diagnostics = options.diagnostics ?? [];
  }
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

/**
 * 已打开的会话在每次新建子 Agent 前读取一次最新已提交配置：用户/项目 Markdown 与
 * 用户 `agents-state.json`。与启动装配的关键差异：
 * - 只读，不执行任何旧格式迁移（迁移仍只在 CLI 装配时完成）；
 * - 文件不可读、状态损坏或 profile 解析失败一律抛出 `ACodeAgentConfigError`，
 *   由 core 拒绝新派生，而不是沿用旧模型或回退父模型；
 * - 缺失的 agents 根目录与缺失的 agents-state.json 是合法默认值（无 profile / 无覆盖）。
 * 每次调用都是独立完整快照，不共享跨派生的可变缓存。
 */
export async function loadCurrentACodeAgentProfiles(
  input: LoadACodeAgentProfilesInput,
): Promise<LoadACodeAgentProfilesResult> {
  const agentState = await readCurrentAgentState(input.storageRoot);
  const roots = [
    { path: join(input.storageRoot, "agents"), source: "user" as const },
    { path: join(input.workingDirectory, ".acode", "agents"), source: "project" as const },
  ];
  const diagnostics: AgentProfileParseDiagnostic[] = [];
  const profiles: AgentProfile[] = [];

  for (const root of roots) {
    for (const filePath of await listMarkdownFilesAsync(root.path)) {
      const content = await readAgentProfileFile(filePath);
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
      if (!result.profile) {
        // agents 根目录还承载普通 Markdown；只有本次目标定义损坏才阻断派生。
        // 无关文件沿用启动装配的诊断/跳过语义，不能让一个 README 阻断所有 Agent。
        if (input.agentType && isRequestedAgentFile(input.agentType, filePath)) {
          throw new ACodeAgentConfigError(
            "agent_profile_invalid",
            `Agent profile failed to parse: ${filePath}`,
            { diagnostics: result.diagnostic ? [result.diagnostic] : [] },
          );
        }
        continue;
      }
      if (input.agentType && matchesRequestedAgent(input.agentType, result.profile.name)) {
        validateRequestedAgentModel(content, filePath, result.profile);
      }
      const profile = sanitizeProjectAgentProfile(result.profile);
      if (isDisabledUserProfile(profile, agentState.disabledAgentIds)) {
        continue;
      }
      profiles.push(profile);
    }
  }

  input.logger?.debug("Current agent profiles loaded", {
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

function matchesRequestedAgent(requested: string, candidate: string): boolean {
  const normalize = (value: string): string =>
    value
      .trim()
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[\p{White_Space}\p{Pd}_]+/gu, "");
  return normalize(requested) === normalize(candidate);
}

function isRequestedAgentFile(agentType: string, filePath: string): boolean {
  return matchesRequestedAgent(agentType, basename(filePath, extname(filePath)));
}

function validateRequestedAgentModel(
  content: string,
  filePath: string,
  profile: AgentProfile,
): void {
  const frontmatter = /^(?:\uFEFF)?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/u.exec(
    content,
  )?.[1];
  if (!frontmatter) return;
  const rawModel = /^model[ \t]*:[ \t]*(.*)$/mu.exec(frontmatter)?.[1]?.trim();
  if (!rawModel) return;
  const model = rawModel.replace(/^['"]|['"]$/gu, "").trim();
  if (!model || ["inherit", "main", "sonnet", "opus", "haiku"].includes(model)) return;
  if (profile.modelSelection) return;
  throw new ACodeAgentConfigError(
    "agent_profile_invalid",
    `Agent profile has an invalid model selection: ${filePath}`,
    {
      diagnostics: [
        { code: "agent_invalid_model", message: "Invalid model selection", path: filePath },
      ],
    },
  );
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

export function loadPluginAgentProfiles(
  input: LoadPluginAgentProfilesInput,
): LoadACodeAgentProfilesResult {
  const diagnostics: AgentProfileParseDiagnostic[] = [];
  const parsedProfiles: ParsedPluginAgentProfile[] = [];
  const reservedProfileNames = new Set([
    ...RESERVED_AGENT_NAMES,
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

  // 先构造不含模型覆盖的基线 profile（命名空间名 + 唯一裸名别名），
  // 再用与派生边界共用的纯函数套用覆盖，保证两处选择优先级完全一致。
  const bareNameCounts = countBareProfileNames(parsedProfiles);
  const baseProfiles: AgentProfile[] = [];
  for (const parsed of parsedProfiles) {
    const canonical = namespacePluginAgentProfile(parsed);
    baseProfiles.push(canonical);

    const bareName = parsed.bareName.trim();
    if (bareNameCounts.get(bareName) === 1 && !reservedProfileNames.has(bareName)) {
      baseProfiles.push({ ...canonical, name: bareName });
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

  const profiles = applyPluginAgentModelOverrides({
    profiles: baseProfiles,
    plugins: input.plugins,
    modelSelectionOverrides: input.modelSelectionOverrides,
    builtInModelSelectionOverrides: input.builtInModelSelectionOverrides,
  });

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
  const generalPurpose = modelSelectionSchema.safeParse(structuredRecord["general-purpose"]);
  const explore = modelSelectionSchema.safeParse(structuredRecord.Explore);
  if (generalPurpose.success) result["general-purpose"] = generalPurpose.data;
  if (explore.success) result.Explore = explore.data;
  return result;
}

function isDisabledUserProfile(
  profile: AgentProfile,
  disabledAgentIds: ReadonlySet<string>,
): boolean {
  if (profile.source !== "user") {
    return false;
  }
  return disabledAgentIds.has(
    createAgentStateId({
      name: profile.name,
      scope: "user",
      source: "user",
    }),
  );
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

async function readCurrentAgentState(storageRoot: string): Promise<{
  builtInModelSelectionOverrides: BuiltInSubagentModelSelectionOverrides;
  pluginAgentModelSelectionOverrides: PluginSubagentModelSelectionOverrides;
  disabledAgentIds: Set<string>;
}> {
  const statePath = join(storageRoot, "v2", "agents-state.json");
  let raw: string;
  try {
    raw = await readFile(statePath, "utf8");
  } catch (error) {
    // 状态文件缺失是合法默认（尚无任何覆盖）；其他 IO 失败必须 fail closed。
    if (isMissingPath(error)) {
      return {
        builtInModelSelectionOverrides: {},
        pluginAgentModelSelectionOverrides: {},
        disabledAgentIds: new Set(),
      };
    }
    throw new ACodeAgentConfigError(
      "agents_state_unreadable",
      `Subagent state file is unreadable: ${statePath}`,
      { cause: error },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ACodeAgentConfigError(
      "agents_state_malformed",
      `Subagent state file is not valid JSON: ${statePath}`,
      { cause: error },
    );
  }
  if (!isRecord(parsed)) {
    throw new ACodeAgentConfigError(
      "agents_state_malformed",
      `Subagent state file must contain a JSON object: ${statePath}`,
    );
  }

  return {
    builtInModelSelectionOverrides: readCurrentBuiltInSelectionOverrides(
      parsed.builtInModelSelectionOverrides,
      statePath,
    ),
    pluginAgentModelSelectionOverrides: readCurrentPluginSelectionOverrides(
      parsed.pluginAgentModelSelectionOverrides,
      statePath,
    ),
    disabledAgentIds: readCurrentDisabledAgentIds(parsed.disabledAgentIds, statePath),
  };
}

/** 派生边界不接受"半损坏"的覆盖：字段存在但形状/选择非法时直接拒绝读取。 */
function readCurrentBuiltInSelectionOverrides(
  value: unknown,
  statePath: string,
): BuiltInSubagentModelSelectionOverrides {
  if (value === undefined) return {};
  if (!isRecord(value)) throw malformedAgentState(statePath, "builtInModelSelectionOverrides");
  const result: BuiltInSubagentModelSelectionOverrides = {};
  for (const name of BUILT_IN_SUBAGENT_NAMES) {
    const candidate = value[name];
    if (candidate === undefined) continue;
    const selection = modelSelectionSchema.safeParse(candidate);
    if (!selection.success) {
      throw malformedAgentState(statePath, `builtInModelSelectionOverrides.${name}`);
    }
    result[name] = selection.data;
  }
  return result;
}

function readCurrentPluginSelectionOverrides(
  value: unknown,
  statePath: string,
): PluginSubagentModelSelectionOverrides {
  if (value === undefined) return {};
  if (!isRecord(value)) throw malformedAgentState(statePath, "pluginAgentModelSelectionOverrides");
  const result: Record<string, PluginSubagentModelSelectionOverrides[string]> = {};
  for (const [id, candidate] of Object.entries(value)) {
    if (!id.startsWith("plugin:")) continue;
    const selection = modelSelectionSchema.safeParse(candidate);
    if (!selection.success) {
      throw malformedAgentState(statePath, `pluginAgentModelSelectionOverrides.${id}`);
    }
    result[id] = selection.data;
  }
  return result;
}

function readCurrentDisabledAgentIds(value: unknown, statePath: string): Set<string> {
  if (value === undefined) return new Set();
  if (!Array.isArray(value)) throw malformedAgentState(statePath, "disabledAgentIds");
  return new Set(
    value.filter((id): id is string => typeof id === "string" && id.trim().length > 0),
  );
}

function malformedAgentState(statePath: string, field: string): ACodeAgentConfigError {
  return new ACodeAgentConfigError(
    "agents_state_malformed",
    `Subagent state field is malformed (${field}): ${statePath}. Correct this entry in Subagents settings before starting a new agent.`,
  );
}

async function readAgentProfileFile(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    throw new ACodeAgentConfigError(
      "agent_profile_unreadable",
      `Agent profile is unreadable: ${filePath}`,
      {
        cause: error,
        diagnostics: [
          {
            code: "agent_read_failed",
            message: error instanceof Error ? error.message : "Agent profile is unreadable",
            path: filePath,
          },
        ],
      },
    );
  }
}

/** 只有"路径不存在"才是合法默认；其他错误（含 ENOTDIR/EACCES）都属于不可读，必须拒绝派生。 */
function isMissingPath(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT";
}

/** 与启动枚举同一规则，但走异步 IO；缺失根目录是合法默认，读取失败则 fail closed。 */
async function listMarkdownFilesAsync(root: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    // 根目录不存在等同"没有配置"；该路径存在但不是目录属于不可读，必须拒绝派生。
    if (isMissingPath(error)) return [];
    throw new ACodeAgentConfigError(
      "agent_root_unreadable",
      `Agent directory is unreadable: ${root}`,
      { cause: error },
    );
  }

  const result: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      result.push(...(await listMarkdownFilesAsync(path)));
      continue;
    }
    if (entry.isFile() && /\.(md|markdown)$/iu.test(entry.name)) {
      result.push(path);
    }
  }
  return result.sort((left, right) => left.localeCompare(right));
}
