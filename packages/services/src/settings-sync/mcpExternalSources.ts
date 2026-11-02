// 契约形状参照 Fynvra（Apache-2.0），见 docs/specs/provider-config-import.md R7
// 外部 Agent MCP 来源表与读取实现（自 settings-sync/settingsSyncService.ts 迁出，并按 R7.1/R7.2 扩展）。
// 来源表 + reader 是同一语义（外部工具的 MCP 配置 → McpServerConfig map），集中一处。
// 本文件**只读**：写入已收敛到 mcp-sync 唯一漏斗（Q2）。变量引用不展开（R7.6），只产键名告警。
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import type {
  McpServerConfig,
  SettingsSyncAgent,
  SettingsSyncMcpVariableReferenceWarning,
} from "@acode/shared";
import { readCcSwitchRows } from "../model-provider/provider-import/locate.js";
import { parseJsonc } from "./jsonc.js";

export type McpConfigFormat =
  | "mcpServersJson"
  | "mcpJson"
  | "codexToml"
  | "jsonc"
  | "ccSwitchSqlite";

/** JSONC 来源的包装键（R7.2「按来源决定包装键」）。 */
export type McpWrapperKey = "mcpServers" | "mcp" | "servers";

export type McpSourceScope = "user" | "workspace";

export interface ExternalAgentMcpPathSource {
  agent: SettingsSyncAgent;
  projectFiles: string[][];
  globalFiles: string[][];
  format: McpConfigFormat;
  wrapperKey?: McpWrapperKey;
  /** 平台相关的绝对路径候选（VS Code）；与 globalFiles 并列，按存在性择优。 */
  resolveGlobalFiles?: (home: string, env: NodeJS.ProcessEnv) => string[];
}

export interface McpSourceRoot {
  agent: SettingsSyncAgent;
  rootPath: string;
  scope: McpSourceScope;
  format: McpConfigFormat;
  wrapperKey?: McpWrapperKey;
}

/** cc-switch 副本上限（与 provider 侧同口径）。 */
const MAX_CC_SWITCH_DB_COPY_BYTES = 256 * 1024 * 1024;
/** cc-switch mcp_servers 行的配置列候选（schema 未采样，按常见命名容忍；见 spec 附录 A 核实项）。 */
const CC_SWITCH_MCP_CONFIG_COLUMNS = [
  "server_config",
  "config",
  "settings_config",
  "json",
  "value",
] as const;
const JSONC_WRAPPER_FALLBACK_ORDER: readonly McpWrapperKey[] = ["mcpServers", "servers", "mcp"];
const VARIABLE_REFERENCE_PATTERN = /\$\{[^}]*\}|\{env:[^}]*\}|\{file:[^}]*\}/;

export const SUPPORTED_MCP_AGENT_SOURCES: ExternalAgentMcpPathSource[] = [
  {
    agent: "claudeCode",
    projectFiles: [[".claude", "settings.json"], [".mcp.json"]],
    globalFiles: [[".claude", "settings.json"]],
    format: "mcpServersJson",
  },
  {
    agent: "codexCli",
    projectFiles: [[".codex", "config.toml"]],
    globalFiles: [[".codex", "config.toml"]],
    format: "codexToml",
  },
  {
    agent: "openCode",
    projectFiles: [[".opencode", "opencode.json"]],
    globalFiles: [[".config", "opencode", "opencode.json"]],
    format: "mcpJson",
  },
  {
    agent: "openClaw",
    projectFiles: [["settings.json"]],
    globalFiles: [[".openclaw", "settings.json"]],
    format: "mcpServersJson",
  },
  {
    agent: "qwenCode",
    projectFiles: [[".qwen", "settings.json"]],
    globalFiles: [[".qwen", "settings.json"]],
    format: "mcpServersJson",
  },
  {
    agent: "qode",
    projectFiles: [[".qoder", "settings.json"]],
    globalFiles: [[".qoder", "settings.json"]],
    format: "mcpServersJson",
  },
  {
    agent: "qodeCn",
    projectFiles: [[".qoder", "settings.json"]],
    globalFiles: [[".qoder-cn", "settings.json"]],
    format: "mcpServersJson",
  },
  {
    agent: "trae",
    projectFiles: [[".trae", "settings.json"]],
    globalFiles: [[".trae", "settings.json"]],
    format: "mcpServersJson",
  },
  {
    agent: "kiroCli",
    projectFiles: [[".kiro", "settings.json"]],
    globalFiles: [[".kiro", "settings.json"]],
    format: "mcpServersJson",
  },
  {
    agent: "roo",
    projectFiles: [[".roo", "settings.json"]],
    globalFiles: [[".roo", "settings.json"]],
    format: "mcpServersJson",
  },
  {
    agent: "codeBuddy",
    projectFiles: [[".codebuddy", "settings.json"]],
    globalFiles: [[".codebuddy", "settings.json"]],
    format: "mcpServersJson",
  },
  // R7.1 本批新增来源。
  {
    agent: "cursor",
    projectFiles: [[".cursor", "mcp.json"]],
    globalFiles: [[".cursor", "mcp.json"]],
    format: "mcpServersJson",
  },
  {
    agent: "gemini",
    projectFiles: [[".gemini", "settings.json"]],
    globalFiles: [[".gemini", "settings.json"]],
    format: "mcpServersJson",
  },
  {
    agent: "vscode",
    // 官方 schema 用 `servers` 包装键，且允许注释/尾逗号 → JSONC（R7.2 借 Fynvra locateMcpSources 平台分支形状）。
    projectFiles: [[".vscode", "mcp.json"]],
    globalFiles: [],
    format: "jsonc",
    wrapperKey: "servers",
    resolveGlobalFiles: (home, env) => resolveVsCodeUserMcpFiles(home, env),
  },
  {
    agent: "openCode",
    // 与既有 opencode.json 并列：jsonc 变体（`mcp` 包装键 → 沿用 OpenCode 归一）。
    projectFiles: [[".opencode", "opencode.jsonc"]],
    globalFiles: [[".config", "opencode", "opencode.jsonc"]],
    format: "jsonc",
    wrapperKey: "mcp",
  },
  {
    agent: "ccSwitch",
    // 表 mcp_servers；复制 db + -wal 后只读（与 provider 侧同一 readCcSwitchRows，R7.1）。
    projectFiles: [],
    globalFiles: [[".cc-switch", "cc-switch.db"]],
    format: "ccSwitchSqlite",
  },
  {
    agent: "agents",
    projectFiles: [[".agents", "mcp.json"]],
    globalFiles: [[".agents", "mcp.json"]],
    format: "mcpServersJson",
  },
];

/**
 * VS Code 用户级 MCP 配置候选（平台分支形状沿用仓库既有先例
 * `packages/services/src/terminal/terminalProfile.ts`：一次列出 win/mac/linux 候选，
 * 不按 process.platform 硬分支，缺失路径自然不存在）。
 */
export function resolveVsCodeUserMcpFiles(home: string, env: NodeJS.ProcessEnv): string[] {
  const appData = env.APPDATA?.trim();
  const xdgConfigHome = env.XDG_CONFIG_HOME?.trim();
  const candidates = [
    appData ? join(appData, "Code", "User", "mcp.json") : undefined,
    appData ? join(appData, "Code - Insiders", "User", "mcp.json") : undefined,
    xdgConfigHome ? join(xdgConfigHome, "Code", "User", "mcp.json") : undefined,
    xdgConfigHome ? join(xdgConfigHome, "Code - Insiders", "User", "mcp.json") : undefined,
    join(home, ".config", "Code", "User", "mcp.json"),
    join(home, ".config", "Code - Insiders", "User", "mcp.json"),
    join(home, "Library", "Application Support", "Code", "User", "mcp.json"),
    join(home, "Library", "Application Support", "Code - Insiders", "User", "mcp.json"),
  ];
  return candidates.filter((candidate): candidate is string => Boolean(candidate));
}

/** 展开外部来源的候选文件路径（home 与 env 可注入以便测试）。 */
export function collectExternalMcpSourceRoots(
  home: string,
  workspacePath?: string,
  env: NodeJS.ProcessEnv = process.env,
): McpSourceRoot[] {
  const userRoots: McpSourceRoot[] = SUPPORTED_MCP_AGENT_SOURCES.flatMap((source) => {
    const paths = [
      ...source.globalFiles.map((segments) => join(home, ...segments)),
      ...(source.resolveGlobalFiles?.(home, env) ?? []),
    ];
    return paths.map((rootPath) => rootFrom(source, rootPath, "user"));
  });
  if (!workspacePath) return userRoots;
  const projectRoots: McpSourceRoot[] = SUPPORTED_MCP_AGENT_SOURCES.flatMap((source) =>
    source.projectFiles.map((segments) => rootFrom(source, join(workspacePath, ...segments), "workspace")),
  );
  return [...userRoots, ...projectRoots];
}

function rootFrom(
  source: ExternalAgentMcpPathSource,
  rootPath: string,
  scope: McpSourceScope,
): McpSourceRoot {
  return {
    agent: source.agent,
    rootPath,
    scope,
    format: source.format,
    ...(source.wrapperKey ? { wrapperKey: source.wrapperKey } : {}),
  };
}

/** 读单个来源文件的 MCP server map；任何失败返回空（与既有「坏文件不产候选」口径一致）。 */
export async function readMcpServersFromSourceFile(
  filePath: string,
  format: McpConfigFormat,
  wrapperKey?: McpWrapperKey,
): Promise<Record<string, McpServerConfig>> {
  try {
    if (format === "ccSwitchSqlite") {
      const read = await readCcSwitchRows(
        filePath,
        MAX_CC_SWITCH_DB_COPY_BYTES,
        undefined,
        "mcp_servers",
      );
      return readCcSwitchMcpServers(read.rows);
    }
    const raw = await readFile(filePath, "utf-8");
    if (format === "codexToml") {
      const parsed = parseToml(raw) as Record<string, unknown>;
      return normalizeMcpServerMap(parsed.mcp_servers ?? parsed.mcpServers);
    }
    if (format === "jsonc") {
      return readJsoncMcpServers(raw, wrapperKey ?? "mcpServers");
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return {};
    return format === "mcpJson"
      ? readOpenCodeMcpServers(parsed)
      : normalizeMcpServerMap(parsed.mcpServers);
  } catch {
    return {};
  }
}

/** JSONC 来源：先去注释/尾逗号再按来源包装键归一（缺失时按常见键顺序回退，仍是尽力而为只读）。 */
function readJsoncMcpServers(raw: string, wrapperKey: McpWrapperKey): Record<string, McpServerConfig> {
  const parsed = parseJsonc(raw);
  if (!parsed.ok || !isRecord(parsed.value)) return {};
  const source = parsed.value;
  const order = [wrapperKey, ...JSONC_WRAPPER_FALLBACK_ORDER.filter((key) => key !== wrapperKey)];
  for (const key of order) {
    if (!isRecord(source[key])) continue;
    return key === "mcp" ? readOpenCodeMcpServers(source) : normalizeMcpServerMap(source[key]);
  }
  return {};
}

/**
 * cc-switch `mcp_servers` 行 → server map。列名按常见命名容忍（schema 未采样，见 spec 附录 A）；
 * `enabled`/`is_enabled` 显式关闭时落 `enabled:false`（启用是 ACode 缺省态，不落冗余字段）。
 */
function readCcSwitchMcpServers(
  rows: readonly Record<string, unknown>[],
): Record<string, McpServerConfig> {
  const servers: Record<string, McpServerConfig> = {};
  for (const row of rows) {
    const name = readTrimmedString(row.name) ?? readTrimmedString(row.id);
    if (!name || servers[name]) continue;
    const config = readCcSwitchRowConfig(row);
    if (!config) continue;
    servers[name] = withRowEnabled(config, row);
  }
  return servers;
}

function readCcSwitchRowConfig(row: Record<string, unknown>): McpServerConfig | null {
  for (const column of CC_SWITCH_MCP_CONFIG_COLUMNS) {
    const value = row[column];
    if (isRecord(value)) return value as McpServerConfig;
    if (typeof value === "string") {
      const parsed = parseJsonc(value);
      if (parsed.ok && isRecord(parsed.value)) return parsed.value as McpServerConfig;
    }
  }
  return null;
}

function withRowEnabled(config: McpServerConfig, row: Record<string, unknown>): McpServerConfig {
  const flag = row.enabled ?? row.is_enabled;
  const disabled = flag === 0 || flag === false || flag === "0";
  return disabled ? { ...config, enabled: false } : config;
}

function readOpenCodeMcpServers(parsed: Record<string, unknown>): Record<string, McpServerConfig> {
  const servers = normalizeMcpServerMap(parsed.mcp);
  return Object.fromEntries(
    Object.entries(servers).map(([name, config]) => [name, normalizeOpenCodeMcpConfig(config)]),
  );
}

function normalizeOpenCodeMcpConfig(config: McpServerConfig): McpServerConfig {
  const rawCommand = (config as Record<string, unknown>).command;
  if (Array.isArray(rawCommand)) {
    const [firstCommand, ...args] = rawCommand.filter(
      (item): item is string => typeof item === "string",
    );
    if (firstCommand) {
      const { command: _command, type, ...rest } = config;
      return {
        ...rest,
        command: firstCommand,
        args,
        ...(type === "local" ? { type: "stdio" } : type === "remote" ? { type: "http" } : {}),
      };
    }
  }
  if (config.type === "local" && typeof rawCommand === "string" && rawCommand.trim()) {
    return {
      ...config,
      type: "stdio",
      command: rawCommand.trim(),
    };
  }
  return config;
}

/** 归一 `mcpServers`/`mcp`/`servers` 形态的 name→config map；同时供 settings-sync 读 ACode 自身配置复用。 */
export function normalizeMcpServerMap(value: unknown): Record<string, McpServerConfig> {
  if (!isRecord(value)) return {};
  const servers: Record<string, McpServerConfig> = {};
  for (const [name, config] of Object.entries(value)) {
    if (!name.trim() || !isRecord(config)) continue;
    servers[name] = config as McpServerConfig;
  }
  return servers;
}

/**
 * 变量引用检测（R7.6）：`${VAR}` / `${input:…}` / `{env:VAR}` / `{file:…}` 原样保留不展开，
 * 只回「位置 + 键名」（env 键、header 键、args 序号、url），**绝不含值**（R7.7）。
 */
export function detectMcpVariableReferences(
  config: McpServerConfig,
): SettingsSyncMcpVariableReferenceWarning[] {
  const record = config as Record<string, unknown>;
  const warnings: SettingsSyncMcpVariableReferenceWarning[] = [];
  const env = isRecord(record.env) ? record.env : undefined;
  if (env) {
    const keys = Object.keys(env).filter((key) => containsReference(env[key]));
    if (keys.length > 0) warnings.push({ kind: "variable-reference", location: "env", keys });
  }
  const headers = isRecord(record.headers)
    ? record.headers
    : isRecord(record.http_headers)
      ? record.http_headers
      : undefined;
  if (headers) {
    const keys = Object.keys(headers).filter((key) => containsReference(headers[key]));
    if (keys.length > 0) warnings.push({ kind: "variable-reference", location: "headers", keys });
  }
  if (Array.isArray(record.args)) {
    const indexes = record.args
      .map((arg, index) => (containsReference(arg) ? String(index) : null))
      .filter((index): index is string => index !== null);
    if (indexes.length > 0) warnings.push({ kind: "variable-reference", location: "args", keys: indexes });
  }
  if (containsReference(record.url)) {
    warnings.push({ kind: "variable-reference", location: "url", keys: [] });
  }
  return warnings;
}

function containsReference(value: unknown): boolean {
  return typeof value === "string" && VARIABLE_REFERENCE_PATTERN.test(value);
}

function readTrimmedString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}