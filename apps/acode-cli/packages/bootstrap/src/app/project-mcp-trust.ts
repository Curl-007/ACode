// 项目作用域 MCP server 信任门（specs/project-mcp-trust-gate.md，安全修复 H2）。
//
// 唯一事实源与收敛点：
// - 「哪些 server 属于项目作用域」→ config-factory 的 serverSources（不在这里重新解析配置）；
// - 「digest 怎么算」→ computeProjectMcpServerDigest（grant、gate、CLI inspect 三处共用）；
// - 「信任记录在哪」→ FileWorkspaceMcpTrustStore（adapters/storage，唯一持久所有者）；
// - 「谁被剔除」→ resolveUntrustedProjectMcpServers（纯函数，resolveAppRuntimeConfig 与
//   acode-protocol mcp/list 共用，不再有第二份空集/真值）。
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import {
  createDefaultFileWorkspaceMcpTrustStore,
  type FileWorkspaceMcpTrustStore,
} from "@acode/adapters/storage";
import type { McpServerConfigSource } from "@acode/adapters/config";
import type { Logger, McpServerConfig, McpStdioServerConfig } from "@acode/contracts";

/** 身份 key 全局约定（AGENTS Workspace Identity）：identity 优先，缺省回落绝对路径。 */
export function resolveProjectMcpTrustIdentity(input: {
  workspaceIdentity?: string;
  workingDirectory: string;
}): string {
  return input.workspaceIdentity?.trim() || resolve(input.workingDirectory);
}

/**
 * 内容 digest：sha256(server 名 + 规范化 stdio 配置)。
 * 规范化覆盖影响执行的全部字段（command/args/cwd/env），键序稳定（env 排序、
 * args 保留顺序——顺序即语义），缺省值归一（args→[]、cwd→null、env→{}）。
 * 配置任何内容变化 → digest 变化 → 旧信任记录不再匹配（spec R5）。
 */
export function computeProjectMcpServerDigest(
  serverName: string,
  config: McpStdioServerConfig,
): string {
  const canonical = JSON.stringify({
    serverName,
    type: "stdio",
    command: config.command,
    args: config.args ?? [],
    cwd: config.cwd ?? null,
    env: sortStringRecord(config.env ?? {}),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/** 审查面展示命令（与 hooks 的 formatCommand 同形态），不参与 digest。 */
export function formatProjectMcpServerDisplayCommand(config: McpStdioServerConfig): string {
  return config.args?.length ? [config.command, ...config.args].join(" ") : config.command;
}

/**
 * R10 内容键：规范化可执行内容（command/args/env；env 键序归一、args 保留顺序）。
 * 不含名字与 cwd——它回答的是「这段内容是否可能来自某个 workspace 声明文件」，
 * 名字参与 digest（工具身份），cwd 在 wire 面（legacy 冻结 schema）不可靠。
 */
export function projectMcpServerContentKey(config: McpStdioServerConfig): string {
  return JSON.stringify({
    command: config.command,
    args: config.args ?? [],
    env: sortStringRecord(config.env ?? {}),
  });
}

/**
 * 收集 agent 发现面的项目声明 stdio server（serverSources === "project"）。
 * R10 的内容命中判定集：显式/用户层 server 的内容与这里任何一条一致，即视为
 * 「可能来自 workspace 文件」，必须过 digest 门。
 */
export function collectProjectDeclaredStdioServers(input: {
  servers: Record<string, McpServerConfig>;
  serverSources: Record<string, McpServerConfigSource> | undefined;
}): Record<string, McpStdioServerConfig> {
  const declared: Record<string, McpStdioServerConfig> = {};
  for (const [name, config] of Object.entries(input.servers)) {
    if (input.serverSources?.[name] !== "project") continue;
    if (config.type !== "stdio") continue;
    declared[name] = config;
  }
  return declared;
}

/**
 * R10 显式层候选的 cwd 归一：legacy wire schema（acodeProtocolMcpServerSchema，
 * 冻结面）没有 cwd 字段，显式 server 的实际执行 cwd 缺省落到 workingDirectory
 * （adapters/mcp createTransport 语义）。归一后与根级项目声明的 grant digest
 * 对齐——已 grant 的 server 经 desktop 显式路径真的生效（B1 后果②收口）。
 */
export function normalizeExplicitProjectMcpCandidate(
  config: McpStdioServerConfig,
  workingDirectory: string,
): McpStdioServerConfig {
  return { ...config, cwd: resolve(workingDirectory, config.cwd ?? ".") };
}

export function projectMcpTrustKey(serverName: string, digest: string): string {
  return `${serverName}\u0000${digest}`;
}

function sortStringRecord(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, record[key]] as const),
  );
}

export interface ProjectMcpTrustSnapshot {
  /**
   * ok/missing：store 正常读取（missing = 尚无任何记录）；
   * corrupt：store 文件损坏（已按 hooks 同款语义改名留证）；
   * unavailable：IO 异常。后两者均 fail-closed（空信任集）+ warn 日志（spec R6）。
   */
  status: "ok" | "missing" | "corrupt" | "unavailable";
  workspaceIdentity: string;
  /** `${serverName}\u0000${digest}`；只含本 workspace 身份的记录。 */
  trustedKeys: ReadonlySet<string>;
}

/**
 * 加载只读信任快照。每次 App 装配加载一次（与 hooks 的 per-session load 同哲学）；
 * 运行中通过 CLI grant 的信任在下次装配生效——本修复不提供会话内热加载，
 * 会话内启用走设置页显式 connect（spec R8，不写信任存储）。
 */
export async function loadProjectMcpTrustSnapshot(input: {
  workspaceIdentity?: string;
  workingDirectory: string;
  userConfigPath?: string;
  /** 测试注入临时 HOME；生产不传，store 落在真实 ~/.acode/security。 */
  homeDir?: string;
  logger?: Logger;
  /** 测试注入 store；生产走 createDefaultFileWorkspaceMcpTrustStore。 */
  store?: FileWorkspaceMcpTrustStore;
}): Promise<ProjectMcpTrustSnapshot> {
  const workspaceIdentity = resolveProjectMcpTrustIdentity(input);
  const failClosed = (status: ProjectMcpTrustSnapshot["status"]): ProjectMcpTrustSnapshot => ({
    status,
    workspaceIdentity,
    trustedKeys: new Set<string>(),
  });
  const warn = (message: string, error?: unknown): void => {
    input.logger?.warn(message, {
      errorType: error instanceof Error ? error.name : typeof error,
      event: "mcp.project_trust.store_failed",
      module: "bootstrap.project_mcp_trust",
      reasonCode: "project_mcp_trust_store_unavailable",
      status: "failed",
      workspaceIdentity,
    });
  };
  try {
    const store =
      input.store ??
      (await createDefaultFileWorkspaceMcpTrustStore({
        ...(input.userConfigPath ? { userConfigPath: input.userConfigPath } : {}),
        ...(input.homeDir ? { homeDir: input.homeDir } : {}),
      }));
    const loaded = await store.load();
    if (loaded.status === "corrupt") {
      warn("Workspace MCP Trust store is corrupt; project MCP servers fail closed");
      return failClosed("corrupt");
    }
    const trustedKeys = new Set(
      loaded.records
        .filter((record) => record.workspaceIdentity === workspaceIdentity)
        .map((record) => projectMcpTrustKey(record.serverName, record.mcpServerDigest)),
    );
    return { status: loaded.status, workspaceIdentity, trustedKeys };
  } catch (error) {
    warn("Workspace MCP Trust store read failed; project MCP servers fail closed", error);
    return failClosed("unavailable");
  }
}

export interface UntrustedProjectMcpServer {
  name: string;
  digest: string;
  displayCommand: string;
}

export interface ProjectMcpTrustGateInput {
  /** 最终生效的 server 表（builtin/plugin 合并后；宿主 authority 判定用）。 */
  configuredMcpServers: Record<string, McpServerConfig>;
  /** 配置层生效 server 表：options.runtimeConfig?.mcp?.servers ?? configResult.config.mcp.servers。 */
  configLayerServers: Record<string, McpServerConfig>;
  /** config-factory 的有效来源标记（单一事实源）。 */
  serverSources: Record<string, McpServerConfigSource> | undefined;
  /** 信任快照；缺省 = 空信任集 = fail-closed（spec R6）。 */
  trust?: ProjectMcpTrustSnapshot;
  /**
   * agent 发现面收集的项目声明 stdio server（collectProjectDeclaredStdioServers，
   * 与 configLayerServers 同一 configResult）。R1 直判与 R10 内容命中判定的共同
   * 输入；缺省 = 两条规则都不激活（兼容既有直接调用的测试替身形态）。
   */
  projectDeclaredServers?: Record<string, McpServerConfig>;
  /** R10 显式层 cwd 归一基准（会话 workingDirectory）；缺省 = R10 不激活。 */
  workingDirectory?: string;
}

/**
 * 计算被信任门拦下的项目 stdio server（spec R1-R4 + R10）。纯函数：
 * - R4 引用相等判定宿主遮蔽：configuredMcpServers[name] !== 配置层对象 → 实际执行的
 *   是 builtin/宿主内容而非本层声明 → 不门控（同时防「声明同名 node_repl」DoS 宿主工具）；
 * - R2 仅 stdio 进门（http/sse 不 spawn 本地进程）；
 * - R1 项目层直判：配置层对象即 agent 发现的项目声明对象（未被显式/用户层覆盖）→
 *   按声明内容 digest 门控（cwd 已由 adapter 绝对化，与 grant 侧一致）；
 * - R10（B1 收口）显式/用户/env/cli 层：wire 面不携带可信来源（desktop 会把仓库
 *   携带的 .acode/.agents server 作为显式 params 下发，legacy schema 又丢 cwd），
 *   判定依据改为「内容可能来自 workspace 文件」——规范化内容命中任一项目声明 →
 *   按自身名字 + 归一 cwd 过 digest 门；不命中 → R3 放行。
 */
export function resolveUntrustedProjectMcpServers(input: ProjectMcpTrustGateInput): {
  untrustedServerNames: Set<string>;
  pendingServers: UntrustedProjectMcpServer[];
} {
  const untrustedServerNames = new Set<string>();
  const pendingServers: UntrustedProjectMcpServer[] = [];
  // R10 命中集：全部项目声明 stdio server 的规范化内容，不看名字——改名回声
  //（仓库内容 + 新名字）也必须命中；digest 键含名字，grant 记录不会为改名背书。
  const declaredContentKeys = new Set<string>();
  for (const declared of Object.values(input.projectDeclaredServers ?? {})) {
    if (declared.type !== "stdio") continue;
    declaredContentKeys.add(projectMcpServerContentKey(declared));
  }
  const gateByDigest = (name: string, config: McpStdioServerConfig): void => {
    const digest = computeProjectMcpServerDigest(name, config);
    if (input.trust?.trustedKeys.has(projectMcpTrustKey(name, digest))) return;
    untrustedServerNames.add(name);
    pendingServers.push({
      name,
      digest,
      displayCommand: formatProjectMcpServerDisplayCommand(config),
    });
  };
  for (const [name, config] of Object.entries(input.configLayerServers)) {
    if (input.configuredMcpServers[name] !== config) continue;
    if (config.type !== "stdio") continue;
    const declared =
      input.serverSources?.[name] === "project" ? input.projectDeclaredServers?.[name] : undefined;
    if (declared === config) {
      gateByDigest(name, config);
      continue;
    }
    if (input.workingDirectory && declaredContentKeys.has(projectMcpServerContentKey(config))) {
      gateByDigest(name, normalizeExplicitProjectMcpCandidate(config, input.workingDirectory));
    }
  }
  return { untrustedServerNames, pendingServers };
}
