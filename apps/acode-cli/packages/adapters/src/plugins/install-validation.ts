import { existsSync, readFileSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import type { McpServerConfig, PluginDiagnostic, PluginManifest } from "@acode/contracts";
import { fileExists, isRecord, resolveInside, sanitizePluginId } from "./helpers.js";
import { listPluginHookSources } from "./hook-sources.js";
import { loadPluginMcpServerDefinitions, resolvePluginMcpServers } from "./mcp.js";
import { readZipPluginSourceSha256 } from "./zip-source.js";
import {
  findPluginManifestPath,
  readPluginManifestFromRoot,
  validatePluginRoot,
  type SyntheticManifestFactory,
} from "./plugin-manifest-inspect.js";
import type { PluginMarketplaceEntry } from "./marketplace.js";
import type { LoadedPlugin } from "./types.js";

/**
 * 装前 validate 门与版本解析链（specs/plugin-install-transactions.md R1/R2）。
 *
 * // Mechanism ported from oh-my-pi (MIT) docs/marketplace.md:137（版本解析链
 * // catalog→manifest→package.json→SHA 前 7 位）与
 * // docs/plugin-manager-installer-plumbing.md:119（安装期校验失败整体回滚），
 * // Copyright (c) 2025 Mario Zechner & Stencil Labs。仅取机制语义。
 *
 * manifest 读取/校验助手群居 `plugin-manifest-inspect.ts`（marketplace.ts 同源迁出）；
 * 本模块只做门判定（阻断/容忍分诊）、版本链与 MCP 可执行校验。依赖方向
 * marketplace.ts → 本模块 → plugin-manifest-inspect / helpers / hook-sources / mcp，
 * 无环：对 marketplace.ts 只有 PluginMarketplaceEntry 的 type-only import。
 */

/** omp marketplace.md:137 的缓存路径版本安全形态：1–128 位 ASCII 字母/数字或 ._+-，且不含 ".."。 */
export const PLUGIN_INSTALL_VERSION_SAFE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u;

export type { SyntheticManifestFactory };

/** 版本链各环节的来源标识；缓存目录段与安装记录 version 共用同一解析结果。 */
export type PluginInstallVersionProvenance =
  | "plugin.json"
  | "package.json"
  | "catalog"
  | "source-sha"
  | "default";

export interface PluginInstallVersionResolution {
  version: string;
  provenance: PluginInstallVersionProvenance;
  /** 落盘 plugin.json 声明的版本（与 catalog 版本做一致性告警用）。 */
  manifestVersion?: string;
  /** 目录条目声明的版本。 */
  catalogVersion?: string;
}

/** 源身份锚点解析（自 marketplace.ts 迁入的公共导出，行为不变）：zip sha256 → sha → commit。 */
export function readPluginSourceIdentityPin(source: unknown): string | undefined {
  if (!isRecord(source)) return undefined;
  const zipSha256 = readZipPluginSourceSha256(source);
  if (zipSha256) return zipSha256;
  if (typeof source.sha === "string") return source.sha;
  // 兼容旧版及第三方 marketplace 的 source identity 写法。
  if (typeof source.commit === "string") return source.commit;
  return undefined;
}

/**
 * R2 版本解析链：plugin.json → package.json → catalog 条目 → 源身份锚点前 7 位 → 0.0.0。
 * 相对既有行为只新增两个环节：package.json 兜底（omp 同位）与 sha 前 7 位兜底
 * （版本键控缓存：无版本、有锚点的插件每个 commit 一个缓存目录）。
 * manifest 不可读时保持既有宽松回退（是否拒绝安装由 R1 门的 manifest 校验决定）。
 */
export function resolvePluginInstallVersionChain(input: {
  entry: Pick<PluginMarketplaceEntry, "name" | "source" | "version">;
  rootPath: string;
}): PluginInstallVersionResolution {
  const manifestVersion = readManifestVersion(input.rootPath);
  if (manifestVersion) {
    return {
      version: manifestVersion,
      provenance: "plugin.json",
      manifestVersion,
      ...(input.entry.version !== undefined ? { catalogVersion: input.entry.version } : {}),
    };
  }
  const packageVersion = readPackageJsonVersion(input.rootPath);
  if (packageVersion) {
    return {
      version: packageVersion,
      provenance: "package.json",
      ...(input.entry.version !== undefined ? { catalogVersion: input.entry.version } : {}),
    };
  }
  if (input.entry.version !== undefined && input.entry.version.trim().length > 0) {
    return {
      version: input.entry.version,
      provenance: "catalog",
      catalogVersion: input.entry.version,
    };
  }
  const sha = readPluginSourceIdentityPin(input.entry.source);
  if (sha) {
    return { version: sha.slice(0, 7), provenance: "source-sha" };
  }
  return { version: "0.0.0", provenance: "default" };
}

function readManifestVersion(rootPath: string): string | undefined {
  const manifestPath = findPluginManifestPath(rootPath);
  if (!manifestPath) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
    if (isRecord(parsed) && typeof parsed.version === "string" && parsed.version.trim().length > 0) {
      return parsed.version;
    }
  } catch {
    // 版本链宽松回退：manifest 非法不在此处中断，由 R1 门产出阻断诊断。
  }
  return undefined;
}

function readPackageJsonVersion(rootPath: string): string | undefined {
  const packageJsonPath = join(rootPath, "package.json");
  if (!fileExists(packageJsonPath)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as unknown;
    if (isRecord(parsed) && typeof parsed.version === "string" && parsed.version.trim().length > 0) {
      return parsed.version;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export interface PluginInstallGateInput {
  entry: PluginMarketplaceEntry;
  marketplace: string;
  rootPath: string;
  storageRoot: string;
  syntheticManifestFactory?: SyntheticManifestFactory;
}

export interface PluginInstallGateResult {
  /** 阻断诊断：任一命中 → 拒装。 */
  blocking: PluginDiagnostic[];
  /** 容忍诊断（warning / 运行期变量缺失），随安装结果以 warnings 面披露。 */
  tolerated: PluginDiagnostic[];
  version: PluginInstallVersionResolution;
}

/**
 * R1 装前 validate 门。判定规则（spec R1）：error 严重度且非 plugin_variable_missing
 * 的一律阻断；plugin_variable_missing 是运行期变量（user_config/env）在安装进程
 * 不可解析的预期形态，降级为容忍项；其余 warning 全部容忍。
 * 检测器复用既有单一事实源（hook-sources / mcp / manifest 兼容诊断），不重复实现。
 */
export function validatePluginForInstall(input: PluginInstallGateInput): PluginInstallGateResult {
  const blocking: PluginDiagnostic[] = [];
  const tolerated: PluginDiagnostic[] = [];
  const pluginId = `${input.entry.name}@${input.marketplace}`;

  // 1. manifest 可读性/结构/名称一致性 + 兼容与 MCP schema 诊断（复用既有校验）。
  for (const diagnostic of validatePluginRoot(input)) {
    if (isBlockingDiagnostic(diagnostic)) blocking.push(diagnostic);
    else tolerated.push(diagnostic);
  }

  // 结构性 manifest 缺失/非法时，后续声明检查没有可信输入，直接短路（阻断已就位）。
  let manifest: PluginManifest | null = null;
  let manifestPath: string | undefined;
  try {
    const loaded = readPluginManifestFromRoot(
      input.rootPath,
      input.entry,
      input.syntheticManifestFactory,
    );
    if (loaded) {
      manifest = loaded.manifest;
      manifestPath = loaded.manifestPath;
    }
  } catch {
    // 已由 validatePluginRoot 产出 plugin_manifest_invalid 阻断诊断。
  }

  if (manifest) {
    const loadedContext: LoadedPlugin = {
      id: pluginId,
      manifest,
      manifestPath: manifestPath ?? input.rootPath,
      marketplace: input.marketplace,
      rootPath: input.rootPath,
      source: "cache",
    };

    // 2. hooks 声明文件存在性（hook-sources 的错误诊断进入统一阻断/容忍分诊）。
    const hookDiagnostics: PluginDiagnostic[] = [];
    listPluginHookSources({ diagnostics: hookDiagnostics, loaded: loadedContext });
    triage(hookDiagnostics, blocking, tolerated);

    // 3. commands/agents/skills 显式声明的路径必须存在（默认目录缺席是合法形态，不检查）。
    pushDeclaredPathDiagnostics({ blocking, manifest, pluginId, rootPath: input.rootPath });

    // 4. MCP stdio 可执行路径存在性（schema 失败已进入统一分诊；此处只补可执行校验）。
    const mcpDiagnostics: PluginDiagnostic[] = [];
    const definitions = loadPluginMcpServerDefinitions({
      diagnostics: mcpDiagnostics,
      loaded: loadedContext,
    });
    const resolvedServers = resolvePluginMcpServers({
      dataPath: join(input.storageRoot, "data", sanitizePluginId(pluginId)),
      definitions,
      diagnostics: mcpDiagnostics,
      env: {},
      loaded: loadedContext,
      options: {},
      workingDirectory: process.cwd(),
    });
    triage(mcpDiagnostics, blocking, tolerated);
    pushMcpExecutableDiagnostics({ blocking, pluginId, rootPath: input.rootPath, resolvedServers });
  }

  // 5. 版本解析链安全形态（R2 + R1-6）。
  const version = resolvePluginInstallVersionChain({
    entry: input.entry,
    rootPath: input.rootPath,
  });
  if (!PLUGIN_INSTALL_VERSION_SAFE_PATTERN.test(version.version) || version.version.includes("..")) {
    blocking.push({
      code: "plugin_manifest_invalid",
      message:
        `Plugin install version "${version.version}" (from ${version.provenance}) is not safe for cache paths; ` +
        'use 1-128 ASCII letters/digits or . _ + - without ".."',
      path: input.rootPath,
      pluginId,
      severity: "error",
    });
  } else if (
    version.manifestVersion !== undefined &&
    version.catalogVersion !== undefined &&
    version.manifestVersion !== version.catalogVersion
  ) {
    tolerated.push({
      code: "plugin_manifest_invalid",
      message:
        `Plugin catalog version (${version.catalogVersion}) differs from manifest version (${version.manifestVersion}); ` +
        `install will use the ${version.provenance} version (${version.version})`,
      path: input.rootPath,
      pluginId,
      severity: "warning",
    });
  }

  return { blocking, tolerated, version };
}

/** 统一阻断/容忍分诊（规则见 validatePluginForInstall）。 */
function triage(
  diagnostics: PluginDiagnostic[],
  blocking: PluginDiagnostic[],
  tolerated: PluginDiagnostic[],
): void {
  for (const diagnostic of diagnostics) {
    if (isBlockingDiagnostic(diagnostic)) blocking.push(diagnostic);
    else tolerated.push(diagnostic);
  }
}

/** 阻断/容忍分诊的唯一规则（spec R1）：error 且非运行期变量缺失 → 阻断。 */
export function isBlockingDiagnostic(diagnostic: PluginDiagnostic): boolean {
  return diagnostic.severity === "error" && diagnostic.code !== "plugin_variable_missing";
}

function pushDeclaredPathDiagnostics(input: {
  blocking: PluginDiagnostic[];
  manifest: PluginManifest;
  pluginId: string;
  rootPath: string;
}): void {
  for (const field of ["commands", "agents", "skills"] as const) {
    const value: unknown = input.manifest[field];
    const declaredPaths =
      typeof value === "string"
        ? [value]
        : Array.isArray(value)
          ? value.filter((item): item is string => typeof item === "string")
          : [];
    for (const raw of declaredPaths) {
      const resolved = resolveInside(input.rootPath, raw.replace(/^\.\//, ""));
      if (!resolved) {
        input.blocking.push({
          code: "plugin_component_path_invalid",
          message: `Plugin ${field} path escapes plugin root: ${raw}`,
          path: input.rootPath,
          pluginId: input.pluginId,
          severity: "error",
        });
        continue;
      }
      if (!existsSync(resolved)) {
        input.blocking.push({
          code: "plugin_component_path_invalid",
          message: `Plugin ${field} path declared in manifest does not exist: ${raw}`,
          path: resolved,
          pluginId: input.pluginId,
          severity: "error",
        });
      }
    }
  }
}

function pushMcpExecutableDiagnostics(input: {
  blocking: PluginDiagnostic[];
  pluginId: string;
  rootPath: string;
  resolvedServers: Record<string, McpServerConfig>;
}): void {
  for (const [serverName, config] of Object.entries(input.resolvedServers)) {
    if (config.type !== "stdio" || config.enabled === false) continue;
    const command = config.command;
    if (typeof command !== "string" || command.length === 0) continue;
    // 含未解析模板的 command 是运行期值（用户 env / user_config），安装期不做存在性裁决。
    if (command.includes("${")) continue;
    const looksLikePath = command.includes("/") || command.includes("\\") || isAbsolute(command);
    const executableMissing = looksLikePath
      ? !fileExists(command)
      : !resolveCommandOnPathSync(command);
    if (executableMissing) {
      input.blocking.push({
        code: "plugin_component_path_invalid",
        message: looksLikePath
          ? `Plugin MCP server "${serverName}" executable not found: ${command}`
          : `Plugin MCP server "${serverName}" command not found on PATH: ${command}`,
        path: input.rootPath,
        pluginId: input.pluginId,
        severity: "error",
      });
    }
  }
}

/** Windows 下可执行扩展（PATHEXT 常见序的固定子集；跨平台测试不依赖机器 PATHEXT）。 */
const WINDOWS_EXECUTABLE_EXTENSIONS = [".com", ".exe", ".bat", ".cmd"] as const;

/**
 * 裸命令按 PATH 解析（同步：PATH 条目有限，且安装门在 async 流程中调用，
 * statSync 成本可忽略；与既有 manifest/hook 读取的同步口径一致）。
 */
export function resolveCommandOnPathSync(command: string): boolean {
  const pathEnv = process.env.PATH ?? "";
  if (pathEnv.length === 0) return false;
  const extensions = process.platform === "win32" ? ["", ...WINDOWS_EXECUTABLE_EXTENSIONS] : [""];
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    for (const extension of extensions) {
      if (fileExists(join(dir, command + extension))) return true;
    }
  }
  return false;
}
