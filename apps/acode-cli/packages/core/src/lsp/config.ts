// Ported from oh-my-pi (MIT) — packages/coding-agent/src/lsp/config.ts + defaults.json, Copyright (c) 2025 Mario Zechner & Stencil Labs
// ============================================================
// LSP 配置：defaults、rootMarkers、项目本地 bin 优先解析、按文件选服务器
// ============================================================

import * as fs from "node:fs";
import * as path from "node:path";
import type { LspConfig, ServerConfig } from "./types.js";

// -----------------------------------------------------------------------------
// 内置 defaults（omp defaults.json 精简：本波五服务器）
// -----------------------------------------------------------------------------

const DEFAULT_SERVERS: Record<string, ServerConfig> = {
  "typescript-language-server": {
    command: "typescript-language-server",
    args: ["--stdio"],
    fileTypes: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
    rootMarkers: ["package.json", "tsconfig.json", "jsconfig.json"],
    initOptions: { hostInfo: "acode-coding-agent" },
  },
  "typescript-native": {
    // TypeScript 7 的原生 tsc 自带 `--lsp`；旧版走 typescript-language-server。
    command: "tsc",
    args: ["--lsp", "--stdio"],
    fileTypes: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
    rootMarkers: ["package.json", "tsconfig.json", "jsconfig.json"],
  },
  eslint: {
    command: "vscode-eslint-language-server",
    args: ["--stdio"],
    fileTypes: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
    rootMarkers: [
      ".eslintrc",
      ".eslintrc.js",
      ".eslintrc.json",
      ".eslintrc.yml",
      "eslint.config.js",
      "eslint.config.mjs",
    ],
    isLinter: true,
    settings: { validate: "on", run: "onType" },
  },
  pyright: {
    command: "pyright-langserver",
    args: ["--stdio"],
    fileTypes: [".py", ".pyi"],
    rootMarkers: ["pyproject.toml", "pyrightconfig.json", "setup.py", "setup.cfg", "requirements.txt", "Pipfile"],
    settings: {
      python: { analysis: { autoSearchPaths: true, diagnosticMode: "openFilesOnly", useLibraryCodeForTypes: true } },
    },
  },
  gopls: {
    command: "gopls",
    args: ["serve"],
    fileTypes: [".go", ".mod", ".sum"],
    rootMarkers: ["go.mod", "go.work", "go.sum"],
    settings: { gopls: { staticcheck: true, gofumpt: true } },
  },
  "rust-analyzer": {
    command: "rust-analyzer",
    args: [],
    fileTypes: [".rs"],
    rootMarkers: ["Cargo.toml", "rust-analyzer.toml"],
    settings: { "rust-analyzer": { checkOnSave: false } },
  },
};

// -----------------------------------------------------------------------------
// root markers
// -----------------------------------------------------------------------------

/** 目录里是否存在任一 root marker（支持 `*.cabal` 这类单层 glob）。 */
export function hasRootMarkers(cwd: string, markers: string[]): boolean {
  let entries: string[] | null = null;
  for (const marker of markers) {
    if (marker.includes("*")) {
      // root marker 只在项目根一层，readdir + 模式匹配即可，
      // 避免 Bun.Glob 场景下钻 node_modules 的开销。
      if (entries === null) {
        try {
          entries = fs.readdirSync(cwd);
        } catch {
          entries = [];
        }
      }
      const regex = globToRegExp(marker);
      if (entries.some((entry) => regex.test(entry))) return true;
      continue;
    }
    if (fs.existsSync(path.join(cwd, marker))) return true;
  }
  return false;
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

/** 文件的任一祖先目录是该项目类型的 LSP 工程根。 */
export function hasRootMarkerAncestor(filePath: string, markers: string[]): boolean {
  if (markers.length === 0) return false;
  let dir = path.dirname(path.resolve(filePath));
  for (;;) {
    if (hasRootMarkers(dir, markers)) return true;
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

// -----------------------------------------------------------------------------
// 项目本地命令解析（项目 bin 优先于 $PATH）
// -----------------------------------------------------------------------------

const PYTHON_ROOT_MARKERS = [
  "pyproject.toml",
  "requirements.txt",
  "setup.py",
  "setup.cfg",
  "Pipfile",
  "pyrightconfig.json",
];

const LOCAL_BIN_PATHS: Array<{ markers: string[]; binDir: string }> = [
  { markers: ["package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml"], binDir: "node_modules/.bin" },
  { markers: PYTHON_ROOT_MARKERS, binDir: ".venv/bin" },
  { markers: PYTHON_ROOT_MARKERS, binDir: ".venv/Scripts" },
  { markers: PYTHON_ROOT_MARKERS, binDir: "venv/bin" },
  { markers: PYTHON_ROOT_MARKERS, binDir: "venv/Scripts" },
  { markers: ["go.mod", "go.sum", "go.work"], binDir: "bin" },
];

// Windows 包管理器在 node_modules/.bin 写的是带后缀的启动器。
const WINDOWS_EXECUTABLE_EXTENSIONS = [".exe", ".cmd", ".bat"] as const;

function resolveLocalCommand(basePath: string): string | null {
  if (fs.existsSync(basePath)) return basePath;
  if (process.platform !== "win32") return null;
  for (const extension of WINDOWS_EXECUTABLE_EXTENSIONS) {
    const candidate = `${basePath}${extension}`;
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function resolveCommandFromLocalRoot(command: string, cwd: string): string | null {
  for (const { markers, binDir } of LOCAL_BIN_PATHS) {
    if (!hasRootMarkers(cwd, markers)) continue;
    const resolved = resolveLocalCommand(path.join(cwd, binDir, command));
    if (resolved) return resolved;
  }
  return null;
}

/** 命令 → 可执行路径：项目本地 bin 优先，再回退 $PATH。找不到返回 null。 */
export function resolveCommand(command: string, cwd: string): string | null {
  const local = resolveCommandFromLocalRoot(command, cwd);
  if (local) return local;
  const pathVar = process.env.PATH ?? "";
  for (const dir of pathVar.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, command);
    if (isExecutableFile(candidate)) return candidate;
    if (process.platform === "win32") {
      const pathExt = (process.env.PATHEXT ?? ".exe;.cmd;.bat").split(";");
      for (const ext of pathExt) {
        if (isExecutableFile(`${candidate}${ext}`)) return `${candidate}${ext}`;
      }
    }
  }
  return null;
}

function isExecutableFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

// -----------------------------------------------------------------------------
// TypeScript 服务器二选一
// -----------------------------------------------------------------------------

/** `tsc` 启动器所属 typescript 包目录（不可识别布局返回 null）。 */
function typescriptPackageDir(tscPath: string): string | null {
  let realPath = tscPath;
  try {
    realPath = fs.realpathSync(tscPath);
  } catch {
    /* 符号链接解析失败按原路径继续 */
  }
  const binDir = path.dirname(tscPath);
  const candidates = [
    // <pkg>/bin/tsc：node_modules/.bin 符号链接与全局安装
    ...(path.basename(path.dirname(realPath)) === "bin" ? [path.dirname(path.dirname(realPath))] : []),
    path.join(binDir, "..", "typescript"),
    path.join(binDir, "node_modules", "typescript"),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
  }
  return null;
}

/**
 * TS7 丢弃了 typescript-language-server 依赖的 `lib/tsserver.js`，改为原生
 * `tsc --lsp`；旧版 tsc 遇到该 flag 报 TS5023。按已解析的 tsc 安装形态二选一，
 * 不靠并发 spawn 竞速。
 */
function selectTypescriptServer(servers: Record<string, ServerConfig>): void {
  const native = servers["typescript-native"];
  if (!native?.resolvedCommand) return;
  const packageDir = typescriptPackageDir(native.resolvedCommand);
  const speaksLsp = packageDir !== null && !fs.existsSync(path.join(packageDir, "lib", "tsserver.js"));
  if (speaksLsp) delete servers["typescript-language-server"];
  else delete servers["typescript-native"];
}

// -----------------------------------------------------------------------------
// 配置装载与合并
// -----------------------------------------------------------------------------

interface RawServerConfig extends Partial<ServerConfig> {
  initializationOptions?: unknown;
}

function normalizeStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const items = value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
  return items.length > 0 ? items : null;
}

function normalizeServerConfig(name: string, config: RawServerConfig): ServerConfig | null {
  const command = typeof config.command === "string" && config.command.length > 0 ? config.command : null;
  const fileTypes = normalizeStringArray(config.fileTypes);
  const rootMarkers = normalizeStringArray(config.rootMarkers);
  if (!command || !fileTypes || !rootMarkers) return null;
  const initOptions =
    config.initOptions && typeof config.initOptions === "object" && !Array.isArray(config.initOptions)
      ? (config.initOptions as Record<string, unknown>)
      : config.initializationOptions &&
          typeof config.initializationOptions === "object" &&
          !Array.isArray(config.initializationOptions)
        ? (config.initializationOptions as Record<string, unknown>)
        : undefined;
  return {
    command,
    args: Array.isArray(config.args) ? config.args.filter((e): e is string => typeof e === "string") : undefined,
    fileTypes,
    rootMarkers,
    languageId: typeof config.languageId === "string" && config.languageId ? config.languageId : undefined,
    settings:
      config.settings && typeof config.settings === "object" && !Array.isArray(config.settings)
        ? (config.settings as Record<string, unknown>)
        : undefined,
    disabled: config.disabled === true,
    isLinter: config.isLinter === true,
    ...(initOptions ? { initOptions } : {}),
  };
}

/** 项目覆盖文件路径（低→高优先级）。 */
export function configFilePaths(cwd: string): string[] {
  return [
    path.join(cwd, "lsp.json"),
    path.join(cwd, ".lsp.json"),
    path.join(cwd, ".acode", "lsp.json"),
  ];
}

function readConfigFile(filePath: string): Record<string, RawServerConfig> | null {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const servers = (parsed as { servers?: unknown }).servers ?? parsed;
  if (typeof servers !== "object" || servers === null) return null;
  return servers as Record<string, RawServerConfig>;
}

/** 装载 cwd 的 LSP 配置：defaults ← 项目覆盖合并，按 marker+可解析过滤，TS 二选一。 */
export function loadConfig(cwd: string): LspConfig {
  let merged: Record<string, ServerConfig> = {};
  for (const [name, config] of Object.entries(DEFAULT_SERVERS)) merged[name] = { ...config };
  for (const filePath of configFilePaths(cwd)) {
    const overrides = readConfigFile(filePath);
    if (!overrides) continue;
    for (const [name, raw] of Object.entries(overrides)) {
      if (raw === null) {
        delete merged[name];
        continue;
      }
      const base = merged[name];
      const normalized = normalizeServerConfig(name, base ? { ...base, ...raw } : raw);
      if (normalized) merged[name] = normalized;
    }
  }

  const servers: Record<string, ServerConfig> = {};
  for (const [name, config] of Object.entries(merged)) {
    if (config.disabled) continue;
    if (!hasRootMarkers(cwd, config.rootMarkers)) continue;
    const resolved = resolveCommand(config.command, cwd);
    if (!resolved) continue;
    servers[name] = { ...config, resolvedCommand: resolved };
  }
  selectTypescriptServer(servers);
  return { servers, idleTimeoutMs: readIdleTimeout(cwd) };
}

function readIdleTimeout(cwd: string): number | undefined {
  for (const filePath of configFilePaths(cwd)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as { idleTimeoutMs?: unknown };
      if (typeof parsed?.idleTimeoutMs === "number" && parsed.idleTimeoutMs > 0) return parsed.idleTimeoutMs;
    } catch {
      /* 无覆盖文件或坏 JSON 都按缺省 */
    }
  }
  return undefined;
}

// 按 cwd 缓存，避免每次调用重复磁盘 IO；lsp reload 时显式失效。
export const configCache = new Map<string, LspConfig>();

export function getConfig(cwd: string): LspConfig {
  let config = configCache.get(cwd);
  if (!config) {
    config = loadConfig(cwd);
    configCache.set(cwd, config);
  }
  return config;
}

// -----------------------------------------------------------------------------
// 按文件选服务器
// -----------------------------------------------------------------------------

/** 扩展名匹配的全部服务器：类型智能（非 linter）在前。 */
export function getServersForFile(config: LspConfig, filePath: string): Array<[string, ServerConfig]> {
  const ext = path.extname(filePath).toLowerCase();
  const extNoDot = ext.startsWith(".") ? ext.slice(1) : ext;
  const fileName = path.basename(filePath).toLowerCase();
  const matches: Array<[string, ServerConfig]> = [];
  for (const [name, serverConfig] of Object.entries(config.servers)) {
    const supports = serverConfig.fileTypes.some((fileType) => {
      // 容忍用户配置漏点号（`.ts`/`ts` 同形）。
      const normalized = fileType.toLowerCase();
      const normalizedNoDot = normalized.startsWith(".") ? normalized.slice(1) : normalized;
      return normalized === ext || normalized === fileName || normalizedNoDot === extNoDot || normalizedNoDot === fileName;
    });
    if (supports) matches.push([name, serverConfig]);
  }
  return matches.sort((a, b) => (a[1].isLinter ? 1 : 0) - (b[1].isLinter ? 1 : 0));
}

/** 主服务器（类型智能优先于 linter），definition/hover 等用它。 */
export function getServerForFile(config: LspConfig, filePath: string): [string, ServerConfig] | null {
  const servers = getServersForFile(config, filePath);
  return servers.length > 0 ? servers[0]! : null;
}
