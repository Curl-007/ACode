import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  parseAgentProfileFromMarkdown,
  type AgentProfile,
  type AgentProfileParseDiagnostic,
} from "@acode/core";
import type { Logger } from "@acode/contracts";
import {
  isBuiltInSubagentName,
  type BuiltInSubagentModelSelectionOverrides,
  type ModelSelection,
} from "@acode/shared";
import {
  resolveBundledContentPackRoot,
  type ResolveBundledSkillRootsOptions,
} from "./bundled-skills.js";

/**
 * 官方预置 agent（bundled 层，specs/builtin-subagent-catalog.md R1/R8）。
 *
 * 预置 agent markdown 与 bundled 技能同包分发（`agents/` 与 `skills/` 平级），
 * 复用同一套三形态 pack root 解析（resolveBundledContentPackRoot），不新增分发通道。
 * 解析结果 `source: "built-in"`、`path` 指向实际文件——path 在场是禁用机制
 * （isDisabledUserProfile）区分「bundled 可禁用」与「核心 TS 内置不可禁用」的判据。
 *
 * 失败姿态（R8）：包整体缺席或 `agents/` 目录缺失时 warn 日志 + 返回空结果，
 * 目录降级为核心二内置，CLI 正常启动，不抛错；单文件解析 diagnostic 不静默，
 * 照既有通道随返回值上报。
 */

export const BUNDLED_AGENTS_DIRECTORY = "agents";

interface BundledAgentProfilesResult {
  profiles: AgentProfile[];
  diagnostics: AgentProfileParseDiagnostic[];
}

/**
 * 从 bundled 内容包解析官方预置 agent profiles。
 * cliStorageRoot 仅 SEA 物化需要，与 resolveBundledSkillRoots 同源（getCliStorageRoot）。
 */
export async function resolveBundledAgentProfiles(
  options: ResolveBundledSkillRootsOptions,
): Promise<BundledAgentProfilesResult> {
  const packRoot = await resolveBundledContentPackRoot(options);
  if (!packRoot) {
    // R8：三形态解析全失败即包整体缺席；与 bundled-skills 同款 warn 姿态，目录降级为二内置。
    options.logger?.warn("Bundled agent pack unavailable", {
      module: "bootstrap.bundled_agents",
    });
    return { diagnostics: [], profiles: [] };
  }
  return loadBundledAgentProfilesFromRoot(packRoot, options.logger);
}

/** pack root 已确定时的目录解析；desktop 侧 services 注入 bundledAgentsRoot 时走同一语义。 */
export async function loadBundledAgentProfilesFromRoot(
  packRoot: string,
  logger?: Logger,
): Promise<BundledAgentProfilesResult> {
  const agentsRoot = join(packRoot, BUNDLED_AGENTS_DIRECTORY);
  let entries;
  try {
    entries = await readdir(agentsRoot, { withFileTypes: true });
  } catch {
    // R8：agents/ 目录缺失同样降级为空目录，不抛错（包完整性门已在 pack root 解析把关）。
    logger?.warn("Bundled agents directory unavailable", {
      module: "bootstrap.bundled_agents",
      path: agentsRoot,
    });
    return { diagnostics: [], profiles: [] };
  }

  const diagnostics: AgentProfileParseDiagnostic[] = [];
  const profiles: AgentProfile[] = [];
  // 排序保证多文件时装配顺序稳定（与 listMarkdownFiles 的 localeCompare 同款）。
  const filePaths = entries
    .filter((entry) => entry.isFile() && /\.(md|markdown)$/iu.test(entry.name))
    .map((entry) => join(agentsRoot, entry.name))
    .sort((left, right) => left.localeCompare(right));

  for (const filePath of filePaths) {
    let content;
    try {
      content = await readFile(filePath, "utf8");
    } catch (error) {
      // 文件在目录枚举后消失（极窄竞态）：按读失败 diagnostic 上报，不中断其余文件。
      diagnostics.push({
        code: "agent_read_failed",
        message:
          error instanceof Error ? error.message : `Failed to read bundled agent: ${filePath}`,
        path: filePath,
      });
      logger?.warn("Bundled agent read failed", {
        module: "bootstrap.bundled_agents",
        path: filePath,
        error: String(error),
      });
      continue;
    }
    const result = parseAgentProfileFromMarkdown({
      content,
      path: filePath,
      source: "built-in",
    });
    if (result.diagnostic) {
      // R8：随包分发的文件解析出 diagnostic 即分发资产损坏，照既有通道上报，不静默。
      diagnostics.push(result.diagnostic);
      logger?.warn("Bundled agent profile diagnostic", {
        code: result.diagnostic.code,
        message: result.diagnostic.message,
        module: "bootstrap.bundled_agents",
        path: filePath,
      });
    }
    if (result.profile) {
      profiles.push(result.profile);
    }
  }

  logger?.debug("Bundled agent profiles loaded", {
    diagnosticCount: diagnostics.length,
    module: "bootstrap.bundled_agents",
    profileCount: profiles.length,
  });
  return { diagnostics, profiles };
}

/** 核心 TS 内置二名（general-purpose / Explore）：不可禁用、恒保留，是保留名单的固定基座。 */
export const CORE_RESERVED_AGENT_NAMES: readonly string[] = ["general-purpose", "Explore"];

/**
 * 保留名单单点函数（specs/builtin-subagent-catalog.md R5）：核心二名 ∪ bundled profile 名。
 * bundled 名单从传入的 profiles 派生，不再出现第二份硬编码；create-app 把结果经
 * loadPluginAgentProfiles 的 reservedProfileNames 入参消费。与 bundled 目录同住：
 * 名单随包内容增减，本模块是包内容的单一事实源。
 */
export function createReservedAgentNames(
  bundledProfiles?: readonly Pick<AgentProfile, "name">[],
): Set<string> {
  return new Set([
    ...CORE_RESERVED_AGENT_NAMES,
    ...(bundledProfiles ?? []).map((profile) => profile.name),
  ]);
}

/**
 * GUI 内置覆盖通道只作用于 bundled 文件成员，判据与 isDisabledUserProfile 同款：
 * source "built-in" 且带 path。核心二内置无 path，其覆盖继续经
 * loadACodeAgentProfiles 返回值的 builtInModelSelectionOverrides 走
 * normalizeAgentProfiles 播种，不在这里重复应用；名单外名字（理论上不出现）
 * 经 isBuiltInSubagentName 守卫，不做越权索引。
 */
export function resolveBundledProfileModelSelection(
  profile: AgentProfile,
  overrides: BuiltInSubagentModelSelectionOverrides,
): ModelSelection | undefined {
  if (profile.source !== "built-in" || profile.path === undefined) {
    return undefined;
  }
  return isBuiltInSubagentName(profile.name) ? overrides[profile.name] : undefined;
}
