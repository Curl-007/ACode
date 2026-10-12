import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import {
  DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS,
  findBuiltinLibraryViolation,
  promptSnippetBuiltinLibrarySchema,
  type PromptSnippetBuiltinEntry,
} from "@acode/shared";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { readInstalledPluginRoots } from "#src/plugins/installedPluginRoots.js";

const log = createServiceLogger("snippets");

/** 内置库插件的 manifest name（不是包名）。 */
export const BUILTIN_SNIPPETS_PLUGIN_NAME = "prompt-snippets";
export const BUILTIN_SNIPPETS_PLUGIN_ID = `${BUILTIN_SNIPPETS_PLUGIN_NAME}@acode-plugins-official`;
/** 内置库数据的**约定路径**：manifest 里不声明任何组件字段（§4.2 硬约束）。 */
export const BUILTIN_SNIPPETS_RELATIVE_PATH = join("snippets", "builtin.json");

const ACODE_OFFICIAL_PLUGIN_MARKETPLACE = "acode-plugins-official";
const ACODE_INLINE_PLUGIN_MARKETPLACE = "inline";
const HOME_PREFIX = "~/";
const ACODE_PLUGIN_MANIFEST_PATH = join(".acode-plugin", "plugin.json");

export type BuiltinSnippetsStatus = "ready" | "unavailable" | "loadError";

export interface BuiltinSnippetsResult {
  entries: PromptSnippetBuiltinEntry[];
  status: BuiltinSnippetsStatus;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveUserHomeDir(): string {
  const envHome = process.env.HOME?.trim() || process.env.USERPROFILE?.trim();
  return envHome && envHome.length > 0 ? envHome : homedir();
}

function resolveConfigPath(path: string): string {
  const expanded = path.startsWith(HOME_PREFIX)
    ? join(resolveUserHomeDir(), path.slice(HOME_PREFIX.length))
    : path;
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}

function resolvePluginStorageRoot(storageDir: string): string {
  const storageRoot = resolveConfigPath(storageDir);
  return join(basename(storageRoot) === "cli" ? storageRoot : join(storageRoot, "cli"), "plugins");
}

interface PluginEnablement {
  enabledPlugins: Record<string, boolean>;
  suppressedBuiltins: string[];
  pluginDirs: string[];
  storageDir: string;
}

/**
 * 读 CLI 用户配置里的插件启停。
 *
 * 与 commandsService / skillsService / subagentsService 的既有读法同构（`~/.acode/cli/config.json`
 * 的 `plugins` 段）。判定式 `enabledPlugins[id] ?? (candidateDefault || DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS)`
 * 保持一致，否则用户在设置页停用内置库后片段仍会出现。
 */
async function readPluginEnablement(): Promise<PluginEnablement> {
  const empty: PluginEnablement = {
    enabledPlugins: {},
    suppressedBuiltins: [],
    pluginDirs: [],
    storageDir: "~/.acode",
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      await readFile(join(resolveUserHomeDir(), ".acode", "cli", "config.json"), "utf-8"),
    );
  } catch {
    return empty;
  }
  if (!isRecord(parsed)) {
    return empty;
  }
  const plugins = isRecord(parsed.plugins) ? parsed.plugins : {};
  const storage = isRecord(parsed.storage) ? parsed.storage : {};
  const enabledPlugins: Record<string, boolean> = {};
  if (isRecord(plugins.enabledPlugins)) {
    for (const [id, enabled] of Object.entries(plugins.enabledPlugins)) {
      if (typeof enabled === "boolean") {
        enabledPlugins[id] = enabled;
      }
    }
  }
  const readStringArray = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  return {
    enabledPlugins,
    suppressedBuiltins: readStringArray(plugins.suppressedBuiltins),
    pluginDirs: readStringArray(plugins.dirs),
    storageDir:
      typeof storage.dir === "string" && storage.dir.trim().length > 0 ? storage.dir : "~/.acode",
  };
}

async function readPluginManifestName(rootPath: string): Promise<string | null> {
  const manifestPath = join(rootPath, ACODE_PLUGIN_MANIFEST_PATH);
  if (!existsSync(manifestPath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(await readFile(manifestPath, "utf-8")) as unknown;
    if (!isRecord(parsed) || typeof parsed.name !== "string") {
      return null;
    }
    const name = parsed.name.trim();
    return name.length > 0 ? name : null;
  } catch {
    return null;
  }
}

/** 官方内置插件被 seed 到 `cache/acode-plugins-official/<plugin>/<version>`。 */
async function scanOfficialPluginCacheRoots(pluginStorageRoot: string): Promise<string[]> {
  const cacheRoot = join(pluginStorageRoot, "cache", ACODE_OFFICIAL_PLUGIN_MARKETPLACE);
  let pluginEntries: string[];
  try {
    pluginEntries = await readdir(cacheRoot);
  } catch {
    return [];
  }
  const roots: string[] = [];
  for (const pluginEntry of pluginEntries) {
    const pluginDir = join(cacheRoot, pluginEntry);
    let versionEntries: string[];
    try {
      versionEntries = await readdir(pluginDir);
    } catch {
      continue;
    }
    for (const versionEntry of versionEntries) {
      roots.push(join(pluginDir, versionEntry));
    }
  }
  // 多版本共存时按字典序取最后一个（版本号升序的自然近似），保证选择稳定。
  return roots.sort((left, right) => left.localeCompare(right)).reverse();
}

interface CandidateRoot {
  defaultEnabled: boolean;
  marketplace: string;
  rootPath: string;
}

async function resolveCandidateRoots(): Promise<string[]> {
  const enablement = await readPluginEnablement();
  const pluginStorageRoot = resolvePluginStorageRoot(enablement.storageDir);
  const [officialCacheRoots, installedRoots] = await Promise.all([
    scanOfficialPluginCacheRoots(pluginStorageRoot),
    readInstalledPluginRoots(pluginStorageRoot),
  ]);
  const candidates: CandidateRoot[] = [
    ...enablement.pluginDirs.map((dir) => ({
      defaultEnabled: true,
      marketplace: ACODE_INLINE_PLUGIN_MARKETPLACE,
      rootPath: resolveConfigPath(dir),
    })),
    ...officialCacheRoots.map((rootPath) => ({
      defaultEnabled: false,
      marketplace: ACODE_OFFICIAL_PLUGIN_MARKETPLACE,
      rootPath,
    })),
    ...installedRoots,
  ];

  const enabledRoots: string[] = [];
  const seenRoots = new Set<string>();
  for (const candidate of candidates) {
    if (seenRoots.has(candidate.rootPath)) {
      continue;
    }
    seenRoots.add(candidate.rootPath);
    if ((await readPluginManifestName(candidate.rootPath)) !== BUILTIN_SNIPPETS_PLUGIN_NAME) {
      continue;
    }
    const pluginId = `${BUILTIN_SNIPPETS_PLUGIN_NAME}@${candidate.marketplace}`;
    if (
      candidate.marketplace === ACODE_OFFICIAL_PLUGIN_MARKETPLACE &&
      enablement.suppressedBuiltins.includes(pluginId)
    ) {
      continue;
    }
    const defaultEnabled =
      candidate.defaultEnabled || DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS.has(pluginId);
    if (!(enablement.enabledPlugins[pluginId] ?? defaultEnabled)) {
      continue;
    }
    enabledRoots.push(candidate.rootPath);
  }
  return enabledRoots;
}

/**
 * 读取内置片段库。
 *
 * 失败语义（§3.7）：插件未安装/被停用 → `unavailable`；JSON 解析或 schema 校验失败 →
 * `loadError` 且 `entries = []`。两种失败都**不得影响用户片段**。
 * 日志只记路径与失败原因，不记片段正文（可能含产品内容）。
 */
export async function loadBuiltinSnippets(): Promise<BuiltinSnippetsResult> {
  const roots = await resolveCandidateRoots();
  if (roots.length === 0) {
    log.warn(undefined, "snippets.builtin.unavailable", {
      candidatePaths: [
        join(resolvePluginStorageRoot("~/.acode"), "cache", ACODE_OFFICIAL_PLUGIN_MARKETPLACE),
      ],
    });
    return { entries: [], status: "unavailable" };
  }

  const pluginRoot = roots[0] as string;
  const filePath = join(pluginRoot, BUILTIN_SNIPPETS_RELATIVE_PATH);
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (error) {
    log.warn(undefined, "snippets.builtin.unavailable", {
      candidatePaths: [filePath],
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    return { entries: [], status: "unavailable" };
  }

  let entries: PromptSnippetBuiltinEntry[];
  try {
    const library = promptSnippetBuiltinLibrarySchema.parse(JSON.parse(raw) as unknown);
    const violation = findBuiltinLibraryViolation(library);
    if (violation) {
      throw new Error(violation);
    }
    entries = library.entries;
  } catch (error) {
    log.warn(undefined, "snippets.builtin.load_failed", {
      reason: error instanceof Error ? error.message : String(error),
      preview: raw.slice(0, 120),
    });
    return { entries: [], status: "loadError" };
  }

  log.info(undefined, "snippets.builtin.loaded", {
    pluginRoot,
    entryCount: entries.length,
    missingMcpEntryCount: entries.filter((entry) => entry.requiresMcp.length > 0).length,
  });
  return { entries, status: "ready" };
}
