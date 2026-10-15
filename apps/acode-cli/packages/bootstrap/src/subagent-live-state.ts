import { readFile, readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { basename, extname, join } from "node:path";
import {
  parseAgentProfileFromMarkdown,
  type AgentProfile,
  type AgentProfileParseDiagnostic,
} from "@acode/core";
import type { Logger } from "@acode/contracts";
import {
  BUILT_IN_SUBAGENT_NAMES,
  modelSelectionSchema,
  type BuiltInSubagentModelSelectionOverrides,
  type PluginSubagentModelSelectionOverrides,
} from "@acode/shared";
// bundled 覆盖烘焙判据同住 bundled 目录模块（与启动装配共用单点，不复制规则）。
import { resolveBundledProfileModelSelection } from "./app/bundled-agents.js";
import {
  isDisabledUserProfile,
  isRecord,
  sanitizeProjectAgentProfile,
  type AgentStateSnapshot,
  type LoadACodeAgentProfilesResult,
} from "./subagent-profile-shared.js";

/**
 * 派生边界 live 重读（specs/agent-teams-derived-config.md R5/R6）。
 * 与启动装配（subagents.ts）的关键差异：只读不迁移、失败一律 fail-closed、
 * 每次调用都是独立完整快照。禁用过滤与项目 profile 清洗复用
 * subagent-profile-shared.ts 的单点判据，bundled 覆盖烘焙复用
 * app/bundled-agents.ts 的 resolveBundledProfileModelSelection。
 */

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

export interface LoadCurrentACodeAgentProfilesInput {
  logger?: Logger;
  storageRoot: string;
  workingDirectory: string;
  /** 本次派生目标；只有目标 agent 自身损坏才阻断（无关 Markdown 沿用诊断/跳过）。 */
  agentType?: string;
  /**
   * 官方预置 agent 的启动解析原始结果（bundled 包内容不随会话变化）。
   * live 读取用最新 disabledAgentIds 过滤、最新内置覆盖烘焙（spec R6：
   * bundled 成员必须进 live 快照，否则派生边界丢 Plan/Verify/Review）。
   */
  bundledProfiles?: readonly AgentProfile[];
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
  input: LoadCurrentACodeAgentProfilesInput,
): Promise<LoadACodeAgentProfilesResult> {
  const agentState = await readCurrentAgentState(input.storageRoot);
  const roots = [
    { path: join(input.storageRoot, "agents"), source: "user" as const },
    { path: join(input.workingDirectory, ".acode", "agents"), source: "project" as const },
  ];
  const diagnostics: AgentProfileParseDiagnostic[] = [];
  const profiles: AgentProfile[] = [];

  // 合并序与启动装配同构（spec R6）：bundled 置数组最前，user/project 同名整体覆盖。
  // 过滤与烘焙都用本次 live 读到的最新状态：GUI 里禁用/改模型后，下一次新派生即生效。
  for (const bundledProfile of input.bundledProfiles ?? []) {
    if (isDisabledUserProfile(bundledProfile, agentState.disabledAgentIds)) {
      continue;
    }
    const modelSelection = resolveBundledProfileModelSelection(
      bundledProfile,
      agentState.builtInModelSelectionOverrides,
    );
    profiles.push(modelSelection ? { ...bundledProfile, modelSelection } : bundledProfile);
  }

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

async function readCurrentAgentState(storageRoot: string): Promise<AgentStateSnapshot> {
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
  // 键集单点来自 shared 的 BUILT_IN_SUBAGENT_NAMES（含 bundled 三成员），
  // 不采用源分支的本地二名硬编码（会丢 Plan/Verify/Review 的覆盖，spec R5）。
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
