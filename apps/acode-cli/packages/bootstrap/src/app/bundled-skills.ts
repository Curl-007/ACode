import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Logger, SkillRoot } from "@acode/contracts";
// W1-R3（spec 规则 3）：常量经 @acode/cli-workflow 公开面消费（其唯一定义仍在 contracts，
// core 的技能门也读它）；bootstrap → 新包方向合法。
import { DYNAMIC_WORKFLOW_SKILL_NAME } from "@acode/cli-workflow/contract";
import { candidateBaseDirs } from "./bundled-plugins.js";

/**
 * 随 CLI 内置的技能包（apps/acode-cli/packages/bundled-skills）。
 *
 * 它不是插件：不进官方市场目录、没有启停开关、不能卸载，也不出现在设置页与 `$` 引用面板。
 * 产品功能的工具由 runtime 注册，配套技能随 CLI 分发，避免卸载插件后缺少工具使用说明。
 *
 * 三种运行形态解析到同一个 skills 目录：
 * - 开发态 / Electron 桌面：沿官方插件同款候选目录在入口旁找到 `packages/bundled-skills`，原地读取，不拷贝。
 * - SEA 二进制：资产内嵌在 `acode-bundled-skills/` 前缀下，首启按内容 hash 解压到
 *   `<cli storage>/bundled-skills/<hash>/`；目录名即内容身份，重复启动幂等，并发只会有一个赢家。
 * - 远端主机：prepare-prebuilds 把目录 stage 到远端 acode.cjs 旁，与桌面同路。
 *
 * 本包同时承载官方预置 agent（agents/ 子目录，specs/builtin-subagent-catalog.md R1，
 * 由同目录 bundled-agents.ts 从同一 pack root 解析），不新增分发通道。
 */

export const BUNDLED_SKILL_PACK_DIRECTORY_NAME = "bundled-skills";
export const BUNDLED_SKILL_PACK_SKILLS_DIRECTORY = "skills";
/** 门与技能包共用一个名字：常量住在 contracts（core 的技能门也读它），这里只转出。 */
export { DYNAMIC_WORKFLOW_SKILL_NAME };

/** 内容包里每个文件都是必需资产：丢任何一个都拒绝整包，而不是装出一个引用文件缺失的技能/预置 agent。 */
export const BUNDLED_SKILL_PACK_REQUIRED_PATHS = [
  `skills/${DYNAMIC_WORKFLOW_SKILL_NAME}/SKILL.md`,
  `skills/${DYNAMIC_WORKFLOW_SKILL_NAME}/patterns.md`,
  `skills/${DYNAMIC_WORKFLOW_SKILL_NAME}/examples.md`,
  // 官方预置 agent（specs/builtin-subagent-catalog.md R1）：与技能同款 all-or-nothing 完整性门。
  "agents/Plan.md",
  "agents/Verify.md",
  "agents/Review.md",
] as const;

/** 与 official-plugin-definitions 的 rootCandidates 同形，覆盖 monorepo src/dist、cli/dist 与桌面 resources/glm 布局。 */
const BUNDLED_SKILL_PACK_ROOT_CANDIDATES = [
  `packages/${BUNDLED_SKILL_PACK_DIRECTORY_NAME}`,
  `../${BUNDLED_SKILL_PACK_DIRECTORY_NAME}`,
  `../../${BUNDLED_SKILL_PACK_DIRECTORY_NAME}`,
  `../../../${BUNDLED_SKILL_PACK_DIRECTORY_NAME}`,
] as const;

export const SEA_BUNDLED_SKILL_ASSET_PREFIX = "acode-bundled-skills/";
const SEA_BUNDLED_SKILL_MANIFEST_ASSET_KEY = `${SEA_BUNDLED_SKILL_ASSET_PREFIX}manifest.json`;
const SEED_MARKER_FILE = ".acode-bundled-skills-seed.json";

/**
 * 排在所有插件根之后（adapters 的插件根从 FIRST_PLUGIN_PRIORITY 起步进）：同名技能按发现顺序取先者，
 * 用户/项目/插件里的同名技能都应压过内置包。
 */
const BUNDLED_SKILL_ROOT_PRIORITY = 1_000_000;

interface SeaBundledSkillManifest {
  files: Array<{ mode?: number; path: string; sha256: string }>;
  hash: string;
  version: 1;
}

type SeaModule = typeof import("node:sea");

export interface ResolveBundledSkillRootsOptions {
  /** `getCliStorageRoot(storage.dir)`；仅 SEA 解压需要。 */
  cliStorageRoot: string;
  logger?: Logger;
}

/**
 * 三形态共用的 bundled 内容包根解析（SEA 物化 ?? 文件系统候选目录）。
 * 上提自 resolveBundledSkillRoots 的内联组合，供技能与官方预置 agent（bundled-agents.ts）
 * 共用同一 pack root；行为与原组合一致，缺席时返回 undefined，由调用方决定降级姿态。
 */
export async function resolveBundledContentPackRoot(
  options: ResolveBundledSkillRootsOptions,
): Promise<string | undefined> {
  return (
    (await materializeSeaBundledSkillPack(options)) ??
    (await resolveFilesystemBundledSkillPackRoot())
  );
}

export async function resolveBundledSkillRoots(
  options: ResolveBundledSkillRootsOptions,
): Promise<SkillRoot[]> {
  const packRoot = await resolveBundledContentPackRoot(options);
  if (!packRoot) {
    // 内置技能包缺席会让脚本编写被技能门拒绝；记录诊断，便于定位不完整的分发资产。
    options.logger?.warn("Bundled skill pack unavailable", {
      module: "bootstrap.bundled_skills",
      requiredPaths: [...BUNDLED_SKILL_PACK_REQUIRED_PATHS],
    });
    return [];
  }
  return [
    {
      path: join(packRoot, BUNDLED_SKILL_PACK_SKILLS_DIRECTORY),
      priority: BUNDLED_SKILL_ROOT_PRIORITY,
      scope: "system",
      source: "bundled",
    },
  ];
}

export async function findMissingBundledSkillPackPaths(packRoot: string): Promise<string[]> {
  const present = await Promise.all(
    BUNDLED_SKILL_PACK_REQUIRED_PATHS.map((requiredPath) =>
      pathExists(join(packRoot, ...requiredPath.split("/"))),
    ),
  );
  return BUNDLED_SKILL_PACK_REQUIRED_PATHS.filter((_, index) => !present[index]);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function resolveFilesystemBundledSkillPackRoot(): Promise<string | undefined> {
  for (const baseDir of candidateBaseDirs()) {
    for (const relativePath of BUNDLED_SKILL_PACK_ROOT_CANDIDATES) {
      const packRoot = resolve(baseDir, relativePath);
      if (
        (await pathExists(join(packRoot, BUNDLED_SKILL_PACK_SKILLS_DIRECTORY))) &&
        (await findMissingBundledSkillPackPaths(packRoot)).length === 0
      ) {
        return packRoot;
      }
    }
  }
  return undefined;
}

async function materializeSeaBundledSkillPack(
  options: ResolveBundledSkillRootsOptions,
): Promise<string | undefined> {
  const sea = getSeaModule();
  if (!sea?.isSea()) return undefined;
  const manifest = readSeaManifest(sea);
  if (!manifest) return undefined;

  const packsRoot = join(options.cliStorageRoot, BUNDLED_SKILL_PACK_DIRECTORY_NAME);
  const targetRoot = join(packsRoot, manifest.hash);
  if (await isSeedComplete(targetRoot, manifest.hash)) return targetRoot;

  // 目录名就是内容 hash：写进唯一临时目录再 rename，rename 失败且目标已完整即并发赢家先到，
  // 直接复用；其他失败回退到任一已完整的旧包（升级中途掉盘仍有技能可用）。
  const temporaryRoot = `${targetRoot}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await mkdir(temporaryRoot, { recursive: true });
    for (const file of manifest.files) {
      const bytes = Buffer.from(sea.getRawAsset(`${SEA_BUNDLED_SKILL_ASSET_PREFIX}${file.path}`));
      if (hashBytes(bytes) !== file.sha256) {
        throw new Error(`Bundled skill asset hash mismatch: ${file.path}`);
      }
      const outputPath = join(temporaryRoot, ...file.path.split("/"));
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, bytes, { mode: file.mode ?? 0o644 });
    }
    await writeFile(
      join(temporaryRoot, SEED_MARKER_FILE),
      JSON.stringify({ hash: manifest.hash, version: 1 }, null, 2),
    );
    await mkdir(packsRoot, { recursive: true });
    await rename(temporaryRoot, targetRoot);
    return targetRoot;
  } catch (error) {
    await rm(temporaryRoot, { force: true, recursive: true });
    if (await isSeedComplete(targetRoot, manifest.hash)) return targetRoot;
    const fallbackRoot = await findUsableSeededPack(packsRoot);
    options.logger?.warn("Bundled skill pack seed degraded", {
      error: error instanceof Error ? error.message : String(error),
      fallbackRoot,
      module: "bootstrap.bundled_skills",
      targetRoot,
    });
    return fallbackRoot;
  }
}

async function isSeedComplete(targetRoot: string, expectedHash: string): Promise<boolean> {
  try {
    const marker = JSON.parse(await readFile(join(targetRoot, SEED_MARKER_FILE), "utf8")) as {
      hash?: unknown;
    };
    if (marker.hash !== expectedHash) return false;
  } catch {
    return false;
  }
  return (await findMissingBundledSkillPackPaths(targetRoot)).length === 0;
}

async function findUsableSeededPack(packsRoot: string): Promise<string | undefined> {
  let entries;
  try {
    entries = await readdir(packsRoot, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.includes(".tmp-")) continue;
    const packRoot = join(packsRoot, entry.name);
    try {
      const marker = JSON.parse(await readFile(join(packRoot, SEED_MARKER_FILE), "utf8")) as {
        hash?: unknown;
      };
      if (typeof marker.hash === "string" && (await isSeedComplete(packRoot, marker.hash))) {
        return packRoot;
      }
    } catch {
      // 损坏的旧缓存不参与降级，继续查找完整的技能包。
    }
  }
  return undefined;
}

function readSeaManifest(sea: SeaModule): SeaBundledSkillManifest | undefined {
  try {
    const manifest = JSON.parse(
      sea.getAsset(SEA_BUNDLED_SKILL_MANIFEST_ASSET_KEY, "utf8"),
    ) as SeaBundledSkillManifest;
    return manifest.version === 1 &&
      typeof manifest.hash === "string" &&
      Array.isArray(manifest.files)
      ? manifest
      : undefined;
  } catch {
    return undefined;
  }
}

function getSeaModule(): SeaModule | undefined {
  const getBuiltinModule = process.getBuiltinModule as ((id: "node:sea") => SeaModule) | undefined;
  try {
    return getBuiltinModule?.("node:sea");
  } catch {
    return undefined;
  }
}

function hashBytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
