/* eslint-disable max-lines -- 存量基线豁免:初始导入即超限(根 lint 的 ignorePatterns 排除 apps/acode-cli,CLI turbo lint 门禁因此从未变绿)。先恢复门禁信号,拆分重构另行立项。 */
// File Config Adapter - Load and patch JSON configuration files

import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { RuntimeConfigPatch, UiLocale } from "@acode/contracts";
import { withFileLock } from "@acode/shared/node";
import { z } from "zod";
import {
  CANONICAL_CUA_PLUGIN_ID,
  canonicalizePluginId,
  LEGACY_CUA_PLUGIN_ID,
  parseConfigFileToRuntimePatchWithDiagnostics,
  pluginIdAliases,
  type ConfigDiagnostic,
} from "./schema.js";

interface FileConfigOptions {
  baseDir?: string;
  configFileName?: string;
}

export interface LoadedConfig {
  config: RuntimeConfigPatch;
  diagnostics: ConfigDiagnostic[];
  path: string;
  loaded: boolean;
}

export interface UiLocalePatchResult {
  locale: UiLocale;
  path: string;
}

export interface PluginEnabledPatchResult {
  enabled: boolean;
  path: string;
  pluginId: string;
}

export interface PluginOptionsPatchResult {
  clearedOptionKeys: string[];
  options: Record<string, string | number | boolean>;
  path: string;
  pluginId: string;
}

export interface PluginRemovePatchResult {
  path: string;
  pluginId: string;
  removedEnabled: boolean;
  removedOptions: boolean;
}

const DEFAULT_CONFIG_FILE = "config.json";
const DEFAULT_BASE_DIR = "~/.acode/cli";

/**
 * Resolve path with ~ expansion
 */
export function resolvePath(path: string): string {
  if (path.startsWith("~/")) {
    return join(homedir(), path.slice(2));
  }
  return resolve(path);
}

/**
 * Load configuration from a JSON file
 */
export function loadFileConfig(filePath?: string, options: FileConfigOptions = {}): LoadedConfig {
  const resolvedPath = filePath
    ? resolvePath(filePath)
    : join(
        resolvePath(options.baseDir ?? DEFAULT_BASE_DIR),
        options.configFileName ?? DEFAULT_CONFIG_FILE,
      );

  if (!existsSync(resolvedPath)) {
    return {
      config: {},
      diagnostics: [],
      path: resolvedPath,
      loaded: false,
    };
  }

  try {
    const content = readFileSync(resolvedPath, "utf-8");
    const parsed = JSON.parse(content);
    const migrated = migratePluginConfigInFile(parsed);
    if (migrated) {
      // 仅装载态归一化会让旧 key 永久留在磁盘，后续版本无法安全删除迁移逻辑。
      // loadFileConfig 保持同步 API；迁移写回异步排队，并在锁内重新读取最新快照，
      // 避免旧快照覆盖同时发生的 patch。迁移失败不影响当前读取结果。
      void persistPluginConfigMigration(resolvedPath).catch(() => undefined);
    }
    const result = parseConfigFileToRuntimePatchWithDiagnostics(parsed);

    return {
      config: result.config,
      diagnostics: attachDiagnosticFilePath(result.diagnostics, resolvedPath),
      path: resolvedPath,
      loaded: true,
    };
  } catch (error) {
    return {
      config: {},
      diagnostics: [createConfigFileInvalidDiagnostic(error, resolvedPath)],
      path: resolvedPath,
      loaded: false,
    };
  }
}

function migratePluginConfigInFile(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value) || !isRecord(value.plugins)) return undefined;
  const plugins = value.plugins;
  const nextPlugins = { ...plugins };
  let changed = false;

  if (isRecord(plugins.enabledPlugins)) {
    const enabledPlugins = { ...plugins.enabledPlugins };
    for (const [id, enabled] of Object.entries(plugins.enabledPlugins)) {
      if (id === LEGACY_CUA_PLUGIN_ID) {
        const canonicalId = CANONICAL_CUA_PLUGIN_ID;
        if (enabledPlugins[canonicalId] === undefined) enabledPlugins[canonicalId] = enabled;
        delete enabledPlugins[id];
        changed = true;
      }
    }
    if (changed) nextPlugins.enabledPlugins = enabledPlugins;
  }

  if (Array.isArray(plugins.suppressedBuiltins)) {
    const suppressedBuiltins = plugins.suppressedBuiltins.map((id) =>
      id === LEGACY_CUA_PLUGIN_ID ? CANONICAL_CUA_PLUGIN_ID : id,
    );
    if (JSON.stringify(suppressedBuiltins) !== JSON.stringify(plugins.suppressedBuiltins)) {
      nextPlugins.suppressedBuiltins = suppressedBuiltins;
      changed = true;
    }
  }

  if (isRecord(plugins.options)) {
    const options = { ...plugins.options };
    for (const [id, pluginOptions] of Object.entries(plugins.options)) {
      if (id === LEGACY_CUA_PLUGIN_ID) {
        const canonicalId = CANONICAL_CUA_PLUGIN_ID;
        if (options[canonicalId] === undefined) options[canonicalId] = pluginOptions;
        delete options[id];
        changed = true;
      }
    }
    if (changed) nextPlugins.options = options;
  }

  return changed ? { ...value, plugins: nextPlugins } : undefined;
}

async function persistPluginConfigMigration(filePath: string): Promise<void> {
  await withFileLock(filePath, async () => {
    let latest: Record<string, unknown>;
    try {
      latest = await readJsonConfigFile(filePath);
    } catch {
      return;
    }
    const migrated = migratePluginConfigInFile(latest);
    if (migrated) await atomicWriteJson(filePath, migrated);
  });
}

function createConfigFileInvalidDiagnostic(error: unknown, filePath: string): ConfigDiagnostic {
  return {
    code: "config_file_invalid",
    filePath,
    message:
      error instanceof z.ZodError
        ? formatZodError(error)
        : error instanceof Error
          ? error.message
          : "Unable to parse config file.",
    severity: "error",
  };
}

function attachDiagnosticFilePath(
  diagnostics: ConfigDiagnostic[],
  filePath: string,
): ConfigDiagnostic[] {
  return diagnostics.map((diagnostic) => ({
    ...diagnostic,
    filePath: diagnostic.filePath ?? filePath,
  }));
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "<config>";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

/**
 * Patch only the UI locale selection in a JSON config file.
 */
export async function updateUiLocaleInFileConfig(
  filePath: string,
  locale: UiLocale,
): Promise<UiLocalePatchResult> {
  const resolvedPath = resolvePath(filePath);
  return mutateConfigFile(resolvedPath, (parsed) => ({
    next: patchUiLocale(parsed, locale),
    result: { locale, path: resolvedPath },
  }));
}

/**
 * Patch the user plugin enabled map without touching plugin installation state.
 */
export async function updatePluginEnabledInFileConfig(
  filePath: string,
  pluginId: string,
  enabled: boolean,
): Promise<PluginEnabledPatchResult> {
  const resolvedPath = resolvePath(filePath);
  return mutateConfigFile(resolvedPath, (parsed) => ({
    next: patchPluginEnabled(parsed, pluginId, enabled),
    result: { enabled, path: resolvedPath, pluginId },
  }));
}

/**
 * Mark freshly installed plugins as enabled by default, in a single atomic write.
 *
 * 设计：安装即默认启用（仅对本次安装的插件 + 其依赖闭包生效）。这里只对**用户配置里尚未显式声明**
 * 的 id 写入 `true`——若用户先前显式停用过（例如停用后重装），尊重其选择不覆盖；已是 true 的也跳过。
 * 一次性读改写，避免逐个 id 反复读写配置文件。返回真正被新置为启用的 id 列表，便于上层据此决定是否回写。
 */
export async function enablePluginsByDefaultInFileConfig(
  filePath: string,
  pluginIds: readonly string[],
): Promise<{ enabledIds: string[]; path: string }> {
  const resolvedPath = resolvePath(filePath);
  if (pluginIds.length === 0) {
    return { enabledIds: [], path: resolvedPath };
  }
  return mutateConfigFile(resolvedPath, (parsed) => {
    const plugins = isRecord(parsed.plugins) ? parsed.plugins : {};
    const enabledPlugins = isRecord(plugins.enabledPlugins) ? plugins.enabledPlugins : {};
    const enabledIds = pluginIds.filter(
      (id) => !Object.prototype.hasOwnProperty.call(enabledPlugins, id),
    );
    if (enabledIds.length === 0) {
      return { result: { enabledIds: [], path: resolvedPath } };
    }
    return {
      next: {
        ...parsed,
        plugins: {
          ...plugins,
          enabledPlugins: {
            ...enabledPlugins,
            ...Object.fromEntries(enabledIds.map((id) => [id, true])),
          },
        },
      },
      result: { enabledIds, path: resolvedPath },
    };
  });
}

/**
 * Patch plugin user options without touching plugin installation state.
 */
export async function updatePluginOptionsInFileConfig(
  filePath: string,
  pluginId: string,
  options: Record<string, string | number | boolean>,
  clearOptionKeys: string[] = [],
): Promise<PluginOptionsPatchResult> {
  const resolvedPath = resolvePath(filePath);
  return mutateConfigFile(resolvedPath, (parsed) => ({
    next: patchPluginOptions(parsed, pluginId, options, clearOptionKeys),
    result: { clearedOptionKeys: clearOptionKeys, options, path: resolvedPath, pluginId },
  }));
}

/**
 * Remove a plugin's user config footprint when it is uninstalled.
 *
 * Uninstall is a thorough teardown, so it
 * must drop both the `plugins.enabledPlugins[id]` flag and any saved
 * `plugins.options[id]`. updatePluginEnabledInFileConfig/...Options can only set
 * values; deleting the keys needs its own patch so a reinstall starts clean.
 */
export async function removePluginFromFileConfig(
  filePath: string,
  pluginId: string,
): Promise<PluginRemovePatchResult> {
  const resolvedPath = resolvePath(filePath);
  return mutateConfigFile(resolvedPath, (parsed) => {
    const { next, removedEnabled, removedOptions } = patchPluginRemoved(parsed, pluginId);
    return {
      ...(removedEnabled || removedOptions ? { next } : {}),
      result: { path: resolvedPath, pluginId, removedEnabled, removedOptions },
    };
  });
}

/**
 * 只删除 Plugin 的启用覆盖并保留 options。
 *
 * Workspace“恢复继承”是配置视图操作，只应删除 Workspace 的启用覆盖，不能误删
 * 单独保存的 Workspace options 或 secret。
 */
export async function removePluginEnabledFromFileConfig(
  filePath: string,
  pluginId: string,
): Promise<{ path: string; pluginId: string; removedEnabled: boolean }> {
  const resolvedPath = resolvePath(filePath);
  return mutateConfigFile<{ path: string; pluginId: string; removedEnabled: boolean }>(
    resolvedPath,
    (parsed) => {
      const plugins = isRecord(parsed.plugins) ? parsed.plugins : {};
      const enabledPlugins = isRecord(plugins.enabledPlugins) ? plugins.enabledPlugins : {};
      const aliases = pluginIdAliases(pluginId);
      const removedEnabled = aliases.some((id) =>
        Object.prototype.hasOwnProperty.call(enabledPlugins, id),
      );
      if (!removedEnabled) {
        return { result: { path: resolvedPath, pluginId, removedEnabled: false } };
      }
      const nextEnabled = { ...enabledPlugins };
      for (const id of aliases) delete nextEnabled[id];
      return {
        next: { ...parsed, plugins: { ...plugins, enabledPlugins: nextEnabled } },
        result: { path: resolvedPath, pluginId, removedEnabled: true },
      };
    },
  );
}

export interface SuppressedBuiltinPatchResult {
  path: string;
  pluginId: string;
  suppressed: boolean;
}

/**
 * Persist that a built-in (official) plugin is uninstalled, so seeding skips it
 * across restarts and app upgrades. Idempotent. Stored in user config beside
 * enabledPlugins so it survives bundle re-seeds.
 */
export async function addSuppressedBuiltinInFileConfig(
  filePath: string,
  pluginId: string,
): Promise<SuppressedBuiltinPatchResult> {
  const resolvedPath = resolvePath(filePath);
  return mutateConfigFile(resolvedPath, (parsed) => {
    const plugins = isRecord(parsed.plugins) ? parsed.plugins : {};
    const canonicalPluginId = canonicalizePluginId(pluginId);
    const aliases = pluginIdAliases(canonicalPluginId);
    const current = Array.isArray(plugins.suppressedBuiltins)
      ? (plugins.suppressedBuiltins as unknown[]).filter((v): v is string => typeof v === "string")
      : [];
    const retained = current.filter((id) => !aliases.includes(id));
    if (retained.length === current.length && current.includes(canonicalPluginId)) {
      return { result: { path: resolvedPath, pluginId, suppressed: true } };
    }
    return {
      next: {
        ...parsed,
        plugins: { ...plugins, suppressedBuiltins: [...retained, canonicalPluginId] },
      },
      result: { path: resolvedPath, pluginId, suppressed: true },
    };
  });
}

/**
 * Reverse of addSuppressedBuiltinInFileConfig: restore a built-in by dropping its
 * suppression marker. The seeder re-materializes it on the next resolve.
 */
export async function removeSuppressedBuiltinInFileConfig(
  filePath: string,
  pluginId: string,
): Promise<SuppressedBuiltinPatchResult> {
  const resolvedPath = resolvePath(filePath);
  return mutateConfigFile(resolvedPath, (parsed) => {
    const plugins = isRecord(parsed.plugins) ? parsed.plugins : {};
    const aliases = pluginIdAliases(pluginId);
    const current = Array.isArray(plugins.suppressedBuiltins)
      ? (plugins.suppressedBuiltins as unknown[]).filter((v): v is string => typeof v === "string")
      : [];
    const nextSuppressedBuiltins = current.filter((id) => !aliases.includes(id));
    if (nextSuppressedBuiltins.length === current.length) {
      return { result: { path: resolvedPath, pluginId, suppressed: false } };
    }
    return {
      next: { ...parsed, plugins: { ...plugins, suppressedBuiltins: nextSuppressedBuiltins } },
      result: { path: resolvedPath, pluginId, suppressed: false },
    };
  });
}

/**
 * Get default config file path
 */
export function getDefaultConfigPath(): string {
  return join(resolvePath(DEFAULT_BASE_DIR), DEFAULT_CONFIG_FILE);
}

/**
 * Check if config file exists at default location
 */
export function hasDefaultConfigFile(): boolean {
  return existsSync(getDefaultConfigPath());
}

async function readJsonConfigFile(filePath: string): Promise<Record<string, unknown>> {
  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch (error) {
    throw new Error(`Unable to read config file: ${filePath}`, { cause: error });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`Unable to parse config file as JSON: ${filePath}`, { cause: error });
  }

  if (!isRecord(parsed)) {
    throw new Error(`Config file must contain a JSON object: ${filePath}`);
  }

  return parsed;
}

async function readJsonConfigFileOrEmpty(filePath: string): Promise<Record<string, unknown>> {
  try {
    return await readJsonConfigFile(filePath);
  } catch (error) {
    const cause = error instanceof Error ? error.cause : undefined;
    if (isNodeError(cause) && cause.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

type ConfigMutationResult<T> = {
  next?: Record<string, unknown>;
  result: T;
};

/**
 * 配置 patch 的锁必须覆盖读、合并和 rename；只锁 atomicWriteJson 会让两个旧快照互相覆盖。
 */
async function mutateConfigFile<T>(
  filePath: string,
  mutation: (parsed: Record<string, unknown>) => ConfigMutationResult<T>,
): Promise<T> {
  return withFileLock(filePath, async () => {
    const parsed = await readJsonConfigFileOrEmpty(filePath);
    const { next, result } = mutation(parsed);
    if (next !== undefined) await atomicWriteJson(filePath, next);
    return result;
  });
}

function patchUiLocale(parsed: Record<string, unknown>, locale: UiLocale): Record<string, unknown> {
  const currentUi = isRecord(parsed.ui) ? parsed.ui : {};

  return {
    ...parsed,
    ui: {
      ...currentUi,
      locale,
    },
  };
}

function patchPluginEnabled(
  parsed: Record<string, unknown>,
  pluginId: string,
  enabled: boolean,
): Record<string, unknown> {
  const plugins = isRecord(parsed.plugins) ? parsed.plugins : {};
  const enabledPlugins = isRecord(plugins.enabledPlugins) ? plugins.enabledPlugins : {};
  const canonicalPluginId = canonicalizePluginId(pluginId);
  const nextEnabledPlugins = { ...enabledPlugins };
  for (const id of pluginIdAliases(canonicalPluginId)) delete nextEnabledPlugins[id];

  return {
    ...parsed,
    plugins: {
      ...plugins,
      enabledPlugins: {
        ...nextEnabledPlugins,
        [canonicalPluginId]: enabled,
      },
    },
  };
}

function patchPluginOptions(
  parsed: Record<string, unknown>,
  pluginId: string,
  options: Record<string, string | number | boolean>,
  clearOptionKeys: string[],
): Record<string, unknown> {
  const plugins = isRecord(parsed.plugins) ? parsed.plugins : {};
  const currentOptions = isRecord(plugins.options) ? plugins.options : {};
  const canonicalPluginId = canonicalizePluginId(pluginId);
  const aliases = pluginIdAliases(canonicalPluginId);
  const legacyPluginId = aliases.length > 1 ? aliases[1] : undefined;
  const currentPluginOptions = isRecord(currentOptions[canonicalPluginId])
    ? currentOptions[canonicalPluginId]
    : legacyPluginId && isRecord(currentOptions[legacyPluginId])
      ? currentOptions[legacyPluginId]
      : {};
  const nextOptions = { ...currentOptions };
  for (const id of aliases) delete nextOptions[id];
  const clearedOptionKeySet = new Set(clearOptionKeys);
  const retainedPluginOptions = Object.fromEntries(
    Object.entries(currentPluginOptions).filter(([key]) => !clearedOptionKeySet.has(key)),
  );

  return {
    ...parsed,
    plugins: {
      ...plugins,
      options: {
        ...nextOptions,
        // 敏感字段按脱敏合同不会回传 UI，二次保存普通字段时请求中自然缺少
        // 已存 secret。这里按 option key 合并，避免整对象替换把同 scope 的密钥静默清空。
        // 显式清除走 clearOptionKeys，先删除指定键，再合并本次输入；不会连带删除启用状态
        // 或同插件的其他配置。
        [canonicalPluginId]: {
          ...retainedPluginOptions,
          ...options,
        },
      },
    },
  };
}

function patchPluginRemoved(
  parsed: Record<string, unknown>,
  pluginId: string,
): { next: Record<string, unknown>; removedEnabled: boolean; removedOptions: boolean } {
  const plugins = isRecord(parsed.plugins) ? parsed.plugins : {};
  const enabledPlugins = isRecord(plugins.enabledPlugins) ? plugins.enabledPlugins : {};
  const options = isRecord(plugins.options) ? plugins.options : {};
  const aliases = pluginIdAliases(pluginId);
  const removedEnabled = aliases.some((id) => id in enabledPlugins);
  const removedOptions = aliases.some((id) => id in options);
  if (!removedEnabled && !removedOptions) {
    return { next: parsed, removedEnabled, removedOptions };
  }

  const nextEnabled = { ...enabledPlugins };
  for (const id of aliases) delete nextEnabled[id];
  const nextOptions = { ...options };
  for (const id of aliases) delete nextOptions[id];

  return {
    next: {
      ...parsed,
      plugins: {
        ...plugins,
        enabledPlugins: nextEnabled,
        options: nextOptions,
      },
    },
    removedEnabled,
    removedOptions,
  };
}

async function atomicWriteJson(filePath: string, value: Record<string, unknown>): Promise<void> {
  const directory = dirname(filePath);
  await mkdir(directory, { recursive: true });
  const tempPath = join(
    directory,
    `.${basename(filePath)}.${process.pid}.${Date.now()}.${Math.random()
      .toString(16)
      .slice(2)}.tmp`,
  );
  const content = `${JSON.stringify(value, null, 2)}\n`;

  try {
    await writeFile(tempPath, content, { mode: 0o600 });
    await rename(tempPath, filePath);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw new Error(`Unable to write config file: ${filePath}`, { cause: error });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}
