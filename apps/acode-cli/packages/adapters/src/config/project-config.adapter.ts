import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { McpServerConfig, RuntimeConfigPatch } from "@acode/contracts";
import {
  createWorkspaceHookSourceInput,
  discoverWorkspaceHookConfigPaths,
  workspaceHooksConfigSchema,
  type WorkspaceHookSourceInput,
} from "@acode/shared/workspace-hook-discovery";
import { loadFileConfig, type LoadedConfig } from "./file-config.adapter.js";
import { parseConfigFileToRuntimePatchWithDiagnostics, type ConfigDiagnostic } from "./schema.js";

const CURRENT_DIRECTORY = ".";

/**
 * 项目配置里「放宽权限」的字段（安全加固 P1-6）。
 *
 * 背景：仓库携带的项目配置（`.acode/config.json` 等）此前会被无条件合并，其中
 * `permission.allowedTools` 命中 `permission/service.ts` 的 `config.allowedTools.has(toolName)`
 * 即**按裸工具名整体放行**，绕过 build 模式的审批弹窗；`autoApproveHighRisk` /
 * `allowMediumRiskInAuto` / `mode:"yolo"` 同理放宽。克隆恶意仓库即可静默预放行 Bash/Write/Edit。
 * 同一份配置文件里的 `hooks` 却走了完整信任门（`config_project_hooks_pending_trust`）——
 * 即「明知仓库配置要门控，却独漏了更危险的 permission」。
 *
 * 修法采用**「项目配置只能收紧、不能放宽」**（restrictive floor，与 Claude Code policySettings、
 * Codex requirements.toml 同一哲学）：项目来源的放宽字段一律剥离，`disallowedTools`
 * （收紧，只会减少放行）保留。这比把 permission 接进 hooks 的 digest 信任管线简单得多，
 * 且不需要异步信任状态——本函数是同步的。
 *
 * **不影响用户自己的授权**：用户在会话里点「Always allow in this project」写入的是 session store
 * 的 projectRules（经 `permission/service.ts` 的 `matchesProjectRules` 路径），与仓库携带的
 * `config.allowedTools`（`this.config.allowedTools` 路径）是两条不同的来源，前者照常生效。
 */
const PROJECT_PERMISSION_LOOSENING_KEYS = [
  "allowedTools",
  "autoApproveHighRisk",
  "allowMediumRiskInAuto",
  "mode",
] as const;

/**
 * 剥离项目配置中会放宽权限的字段，返回剩余 permission（可能为空对象）与被剥离的键名。
 * `disallowedTools` 属于收紧，保留。
 */
function restrictProjectPermission(
  permission: NonNullable<RuntimeConfigPatch["permission"]>,
): {
  retained: NonNullable<RuntimeConfigPatch["permission"]>;
  stripped: string[];
} {
  const retained: Record<string, unknown> = {};
  const stripped: string[] = [];
  for (const [key, value] of Object.entries(permission)) {
    if (value === undefined) {
      continue;
    }
    if ((PROJECT_PERMISSION_LOOSENING_KEYS as readonly string[]).includes(key)) {
      stripped.push(key);
      continue;
    }
    retained[key] = value;
  }
  return {
    retained: retained as NonNullable<RuntimeConfigPatch["permission"]>,
    stripped,
  };
}

export interface ProjectConfigFile {
  baseDir: string;
  config: RuntimeConfigPatch;
  diagnostics: LoadedConfig["diagnostics"];
  hookCandidate?: WorkspaceHookSourceInput;
  loaded: boolean;
  path: string;
}

export interface ProjectConfigDiscovery {
  files: ProjectConfigFile[];
  diagnostics: LoadedConfig["diagnostics"];
  hookCandidates: WorkspaceHookSourceInput[];
  loaded: boolean;
  paths: string[];
  mcpServerNames: string[];
}

export function loadProjectConfigs(
  workingDirectory?: string,
  explicitProjectConfigPath?: string,
): ProjectConfigDiscovery {
  const resolvedWorkingDirectory = resolve(workingDirectory ?? process.cwd());
  const files = discoverWorkspaceHookConfigPaths({
    workingDirectory: resolvedWorkingDirectory,
    ...(explicitProjectConfigPath ? { explicitProjectConfigPath } : {}),
  }).map((ref, discoveryOrder) =>
    loadProjectConfigFile(ref.path, {
      discoveryOrder,
      explicitProjectConfig: ref.explicitProjectConfig,
      workingDirectory: resolvedWorkingDirectory,
    }),
  );

  // B1 收口（specs/project-mcp-trust-gate.md R11）：`.agents/mcp.json` 是 desktop
  // main 的 workspace MCP fallback 来源；此前 agent 项目发现面对它不可见——仓库只放
  // `.agents/mcp.json` 时 serverSources 无 project 标记，信任门被整体绕过（显式
  // params 回声路径直接 spawn）。这里把它并入项目层**最低优先级**（unshift：项目层
  // 按名合并、后合并者胜，于是同名 server 仍以 acode.json/.acode/config.json 为准，
  // 对齐 desktop 的「.acode 强优先」；.agents 独有条目同样进入 serverSources=project，
  // 保证 R10 的内容命中判定对任何 workspace 声明都不留盲区）。
  const agentsMcpFile = loadAgentsMcpJsonProjectConfig(
    join(resolvedWorkingDirectory, ".agents", "mcp.json"),
    resolvedWorkingDirectory,
  );
  if (agentsMcpFile) {
    files.unshift(agentsMcpFile);
  }

  return summarizeProjectConfigs(files);
}

/**
 * 读取 `.agents/mcp.json`（`{ mcpServers: {...} }` 通用目录格式）并折算成项目配置
 * 文件条目。解析/诊断/cwd 绝对化全部复用既有 config 文件管线（单一所有者）：
 * `parseConfigFileToRuntimePatchWithDiagnostics`（type 推断、env 归一、逐 server
 * `config_mcp_server_invalid` 诊断）+ `normalizeProjectConfig`（permission 剥离、
 * cwd 规范化）。文件不存在或没有 mcpServers 映射 → undefined（不参与发现）。
 */
function loadAgentsMcpJsonProjectConfig(
  path: string,
  workingDirectory: string,
): ProjectConfigFile | undefined {
  if (!existsSync(path)) return undefined;
  const invalidFile = (message: string, loaded: boolean): ProjectConfigFile => ({
    baseDir: workingDirectory,
    config: {},
    diagnostics: [
      {
        code: "config_file_invalid",
        filePath: path,
        message,
        severity: "warning",
      },
    ],
    loaded,
    path,
  });
  let serverMap: unknown;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (!isPlainRecord(parsed) || !isPlainRecord(parsed.mcpServers)) return undefined;
    serverMap = parsed.mcpServers;
  } catch (error) {
    return invalidFile(
      `Failed to parse .agents/mcp.json: ${error instanceof Error ? error.message : String(error)}`,
      false,
    );
  }
  try {
    const result = parseConfigFileToRuntimePatchWithDiagnostics({
      mcp: { servers: serverMap },
    });
    const diagnostics: ConfigDiagnostic[] = result.diagnostics.map((diagnostic) => ({
      ...diagnostic,
      filePath: diagnostic.filePath ?? path,
    }));
    return {
      baseDir: workingDirectory,
      config: normalizeProjectConfig(result.config, workingDirectory),
      diagnostics,
      loaded: true,
      path,
    };
  } catch (error) {
    return invalidFile(
      `Invalid .agents/mcp.json: ${error instanceof Error ? error.message : String(error)}`,
      false,
    );
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function loadProjectConfigFile(
  path: string,
  options: {
    discoveryOrder?: number;
    explicitProjectConfig?: boolean;
    workingDirectory?: string;
  } = {},
): ProjectConfigFile {
  const result = loadFileConfig(path);
  const baseDir = getProjectConfigBaseDir(result.path);
  const diagnostics = [...result.diagnostics];
  const hooks = result.loaded ? result.config.hooks : undefined;

  if (hooks) {
    diagnostics.push({
      code: "config_project_hooks_pending_trust",
      filePath: result.path,
      message: "Project hooks are pending workspace trust and remain blocked",
      path: "hooks",
      severity: "warning",
    });
  }

  // 安全加固 P1-6：项目配置里放宽权限的字段（allowedTools/autoApproveHighRisk/
  // allowMediumRiskInAuto/mode）在 normalizeProjectConfig 里被剥离；这里同步报一条 warning，
  // 让用户知道仓库携带的权限放宽未生效（与 hooks 的 pending_trust 诊断同一风格）。
  if (result.loaded && result.config.permission) {
    const { stripped } = restrictProjectPermission(result.config.permission);
    if (stripped.length > 0) {
      diagnostics.push({
        code: "config_project_permission_restricted",
        filePath: result.path,
        message: `Project permission overrides ignored (only tightening is allowed): ${stripped.join(", ")}`,
        path: "permission",
        severity: "warning",
      });
    }
  }

  return {
    baseDir,
    config: result.loaded ? normalizeProjectConfig(result.config, baseDir) : {},
    diagnostics,
    ...(hooks
      ? {
          hookCandidate: createWorkspaceHookSourceInput({
            path: result.path,
            workingDirectory: resolve(options.workingDirectory ?? baseDir),
            // hooks 字段已由 loadFileConfig 经 ACodeConfigFileSchema（shared 单源
            // schema）完成运行时校验；这里的 parse 仅做类型桥接——HooksRuntimeConfigPatch
            // 与 WorkspaceHooksConfig 是两个领域类型（执行 side vs 配置 side，字段语义有
            // 微差），不共享 TS 结构。禁止改成 as 断言绕过校验。
            hooks: workspaceHooksConfigSchema.parse(hooks),
            discoveryOrder: options.discoveryOrder ?? 0,
            explicitProjectConfig: options.explicitProjectConfig,
          }),
        }
      : {}),
    loaded: result.loaded,
    path: result.path,
  };
}

export function summarizeProjectConfigs(files: ProjectConfigFile[]): ProjectConfigDiscovery {
  const loadedFiles = files.filter((file) => file.loaded);
  const mcpServerNames = new Set<string>();

  for (const file of loadedFiles) {
    for (const name of Object.keys(file.config.mcp?.servers ?? {})) {
      mcpServerNames.add(name);
    }
  }

  return {
    diagnostics: files.flatMap((file) => file.diagnostics),
    files: loadedFiles,
    hookCandidates: loadedFiles.flatMap((file) => (file.hookCandidate ? [file.hookCandidate] : [])),
    loaded: loadedFiles.length > 0,
    paths: loadedFiles.map((file) => file.path),
    mcpServerNames: [...mcpServerNames],
  };
}

function getProjectConfigBaseDir(path: string): string {
  const configDirectory = dirname(path);
  return basename(configDirectory) === ".acode" ? dirname(configDirectory) : configDirectory;
}

function normalizeProjectConfig(config: RuntimeConfigPatch, baseDir: string): RuntimeConfigPatch {
  const withoutHooks: RuntimeConfigPatch = config.hooks
    ? (() => {
        const { hooks: _hooks, ...safeConfig } = config;
        // Project Hook declarations are retained only in the immutable candidate side-channel.
        // The executable RuntimeConfigPatch remains hook-free until a later admission phase.
        return safeConfig;
      })()
    : { ...config };

  // 安全加固 P1-6：剥离项目配置中「放宽权限」的字段（见 PROJECT_PERMISSION_LOOSENING_KEYS）。
  // 仓库携带的 allowedTools 会命中 permission/service.ts 的 config.allowedTools.has(toolName)
  // 而按裸工具名整体放行，绕过 build 模式审批；mode/autoApproveHighRisk 同理放宽。
  // 收紧字段 disallowedTools 保留——剥离它会**削弱**安全。
  const normalized: RuntimeConfigPatch = withoutHooks.permission
    ? (() => {
        const { retained } = restrictProjectPermission(withoutHooks.permission);
        if (Object.keys(retained).length === 0) {
          const { permission: _permission, ...rest } = withoutHooks;
          return rest;
        }
        return { ...withoutHooks, permission: retained };
      })()
    : withoutHooks;

  if (!normalized.mcp?.servers) return normalized;

  return {
    ...normalized,
    mcp: {
      ...normalized.mcp,
      servers: Object.fromEntries(
        Object.entries(normalized.mcp.servers).map(([name, server]) => [
          name,
          normalizeProjectMcpServer(server, baseDir),
        ]),
      ),
    },
  };
}

function normalizeProjectMcpServer(server: McpServerConfig, baseDir: string): McpServerConfig {
  if (server.type !== "stdio") return server;

  const cwd = server.cwd ?? CURRENT_DIRECTORY;
  return {
    ...server,
    cwd: isAbsolute(cwd) ? cwd : resolve(baseDir, cwd),
  };
}
