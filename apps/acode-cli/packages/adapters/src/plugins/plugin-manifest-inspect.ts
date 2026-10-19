import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PluginDiagnostic, PluginManifest } from "@acode/contracts";
import { fileExists, isRecord, sanitizePluginId } from "./helpers.js";
import { loadPluginMcpServerDefinitions, resolvePluginMcpServers } from "./mcp.js";
import type { PluginMarketplaceEntry } from "./marketplace.js";
import type { LoadedPlugin } from "./types.js";

/**
 * 插件 manifest 读取与校验助手群（自 marketplace.ts 迁出，行为不变的单一事实源；
 * specs/plugin-install-transactions.md R1 的检测器底座）。
 *
 * 依赖方向：marketplace.ts / install-validation.ts → 本模块 → helpers/mcp，
 * 无反向依赖；对 marketplace.ts 只有 PluginMarketplaceEntry 的 type-only import。
 */

const ACODE_MANIFEST_PATH = join(".acode-plugin", "plugin.json");
const CLAUDE_MANIFEST_PATH = join(".claude-plugin", "plugin.json");
const CODEX_MANIFEST_PATH = join(".codex-plugin", "plugin.json");
const CURSOR_MANIFEST_PATH = join(".cursor-plugin", "plugin.json");
const DEFAULT_VERSION = "0.0.0";
const PLUGIN_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const UNSUPPORTED_MANIFEST_FIELDS = ["channels", "lspServers", "outputStyles", "settings"] as const;

/** strict:false 条目缺失 manifest 文件时的合成 manifest 工厂（实现保留在 marketplace.ts）。 */
export type SyntheticManifestFactory = (entry: PluginMarketplaceEntry) => Record<string, unknown>;

/** manifest 兼容/结构校验助手。候选集与优先级见 specs/plugin-foreign-manifest-compat.md（所有发现点必须一致）。 */
export function findPluginManifestPath(rootPath: string): string | null {
  for (const candidate of [
    ACODE_MANIFEST_PATH,
    CLAUDE_MANIFEST_PATH,
    CODEX_MANIFEST_PATH,
    CURSOR_MANIFEST_PATH,
  ]) {
    const path = join(rootPath, candidate);
    if (fileExists(path)) return path;
  }
  return null;
}

export function readPluginManifestFromRoot(
  rootPath: string,
  entry: PluginMarketplaceEntry,
  // strict:false 条目落盘后没有 manifest 文件时的合成入口；不传则与「缺失」同判。
  syntheticManifestFactory?: SyntheticManifestFactory,
): { manifest: PluginManifest; manifestPath?: string } | null {
  const manifestPath = findPluginManifestPath(rootPath);
  if (manifestPath) {
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
    if (!isRecord(parsed)) throw new Error("Plugin manifest must be a JSON object");
    const name = typeof parsed.name === "string" ? parsed.name.trim() : "";
    if (!PLUGIN_NAME_PATTERN.test(name)) throw new Error(`Invalid plugin name: ${name}`);
    return {
      manifest: {
        ...parsed,
        name,
        version: typeof parsed.version === "string" ? parsed.version : DEFAULT_VERSION,
      } as PluginManifest,
      manifestPath,
    };
  }
  if (entry.strict === false && syntheticManifestFactory) {
    return { manifest: syntheticManifestFactory(entry) as unknown as PluginManifest };
  }
  return null;
}

export function validatePluginRoot(input: {
  entry: PluginMarketplaceEntry;
  marketplace: string;
  rootPath: string;
  storageRoot: string;
  syntheticManifestFactory?: SyntheticManifestFactory;
}): PluginDiagnostic[] {
  const diagnostics: PluginDiagnostic[] = [];
  const pluginId = `${input.entry.name}@${input.marketplace}`;
  let loadedManifest: { manifest: PluginManifest; manifestPath?: string } | null = null;
  try {
    loadedManifest = readPluginManifestFromRoot(
      input.rootPath,
      input.entry,
      input.syntheticManifestFactory,
    );
  } catch (error) {
    diagnostics.push({
      code: "plugin_manifest_invalid",
      message: error instanceof Error ? error.message : String(error),
      path: input.rootPath,
      pluginId,
      severity: "error",
    });
    return diagnostics;
  }

  if (!loadedManifest) {
    diagnostics.push({
      code: "plugin_manifest_not_found",
      message: `Plugin manifest not found: ${pluginId}`,
      path: input.rootPath,
      pluginId,
      severity: "error",
    });
    return diagnostics;
  }

  const manifestPath = loadedManifest.manifestPath ?? input.rootPath;
  if (loadedManifest.manifest.name !== input.entry.name) {
    diagnostics.push({
      code: "plugin_manifest_invalid",
      message: `Plugin manifest name '${loadedManifest.manifest.name}' does not match marketplace entry '${input.entry.name}'`,
      path: manifestPath,
      pluginId,
      severity: "error",
    });
  }
  pushManifestCompatibilityDiagnostics({
    diagnostics,
    manifest: loadedManifest.manifest,
    manifestPath,
    pluginId,
    source: "cache",
  });
  pushMcpValidationDiagnostics({
    diagnostics,
    manifest: loadedManifest.manifest,
    manifestPath,
    marketplace: input.marketplace,
    pluginId,
    rootPath: input.rootPath,
    storageRoot: input.storageRoot,
  });
  return diagnostics;
}

export function pushManifestCompatibilityDiagnostics(input: {
  diagnostics: PluginDiagnostic[];
  manifest: PluginManifest;
  manifestPath: string;
  pluginId: string;
  source: "cache" | "inline" | "official";
}): void {
  for (const key of UNSUPPORTED_MANIFEST_FIELDS) {
    if (key in input.manifest) {
      input.diagnostics.push({
        code: "plugin_unsupported_component",
        message: `Plugin component is diagnostic-only in this ACode runtime: ${key}`,
        path: input.manifestPath,
        pluginId: input.pluginId,
        severity: "warning",
      });
    }
  }
  for (const [key, option] of Object.entries(input.manifest.userConfig ?? {})) {
    if (option.required === true && option.default === undefined) {
      input.diagnostics.push({
        code: "plugin_variable_missing",
        message: `Required plugin userConfig has no default and must be configured: ${key}`,
        path: input.manifestPath,
        pluginId: input.pluginId,
        severity: "warning",
      });
    }
  }
  if (containsMcpBundleSource(input.manifest.mcpServers)) {
    input.diagnostics.push({
      code: "plugin_marketplace_source_unsupported",
      message: "MCPB/DXT plugin bundles are recognized but not supported in this runtime",
      path: input.manifestPath,
      pluginId: input.pluginId,
      severity: "warning",
    });
  }
}

function pushMcpValidationDiagnostics(input: {
  diagnostics: PluginDiagnostic[];
  manifest: PluginManifest;
  manifestPath: string;
  marketplace: string;
  pluginId: string;
  rootPath: string;
  storageRoot: string;
}): void {
  const diagnostics = input.diagnostics as PluginDiagnostic[];
  const loaded: LoadedPlugin = {
    id: input.pluginId,
    manifest: input.manifest,
    manifestPath: input.manifestPath,
    marketplace: input.marketplace,
    rootPath: input.rootPath,
    source: "cache",
  };
  const definitions = loadPluginMcpServerDefinitions({ diagnostics, loaded });
  resolvePluginMcpServers({
    dataPath: join(input.storageRoot, "data", sanitizePluginId(input.pluginId)),
    definitions,
    diagnostics,
    env: {},
    loaded,
    options: {},
    workingDirectory: process.cwd(),
  });
}

function containsMcpBundleSource(value: unknown): boolean {
  if (typeof value === "string") return value.endsWith(".mcpb") || value.endsWith(".dxt");
  if (Array.isArray(value)) return value.some(containsMcpBundleSource);
  return false;
}
