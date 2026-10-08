// 项目 MCP 信任的 CLI 面（specs/project-mcp-trust-gate.md R9）。
// 与 workspace-hook-trust-cli.ts 对称：inspect（status/review）、grant（按当前配置
// 内容钉 digest）、revoke；store 损坏时 grant/revoke fail-closed 拒绝执行。
// 信任记录的持久所有者是 FileWorkspaceMcpTrustStore（adapters/storage），本文件
// 只是它的命令入口，不自持任何状态。
import { resolve } from "node:path";
import {
  createDefaultFileWorkspaceMcpTrustStore,
  type WorkspaceMcpTrustRecord,
} from "@acode/adapters/storage";
import { createConfig } from "@acode/adapters/config";
import type { McpStdioServerConfig } from "@acode/contracts";
import {
  computeProjectMcpServerDigest,
  formatProjectMcpServerDisplayCommand,
  resolveProjectMcpTrustIdentity,
} from "./app/project-mcp-trust.js";

export interface ProjectMcpTrustCliTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  userConfigPath?: string;
  /** 测试注入临时 HOME；生产不传。 */
  homeDir?: string;
}

export interface ProjectMcpTrustCliItem {
  serverName: string;
  displayCommand: string;
  digest: string;
  trustState: "trusted_persistent" | "pending_trust";
}

export interface ProjectMcpTrustCliStatus {
  workspacePath: string;
  workspaceIdentity: string;
  reasonCode:
    | "project_mcp_not_applicable"
    | "project_mcp_pending_trust"
    | "project_mcp_trusted_persistent"
    // status 必须与 grant/revoke 的失败语义一致——损坏 store 若伪装成 pending，
    // 用户按提示 grant 只会撞上 corrupt，恢复指引矛盾（与 hooks 同款裁决）。
    | "project_mcp_trust_store_corrupt";
  items: ProjectMcpTrustCliItem[];
}

interface DiscoveredProjectMcpServer {
  name: string;
  config: McpStdioServerConfig;
  digest: string;
  displayCommand: string;
}

export async function inspectProjectMcpTrust(
  input: ProjectMcpTrustCliTarget,
): Promise<ProjectMcpTrustCliStatus> {
  const discovered = await discoverProjectMcpServers(input);
  const store = await createDefaultFileWorkspaceMcpTrustStore(storeOptions(input));
  const loaded = await store.load();
  const pendingItems = discovered.servers.map((server) => ({
    serverName: server.name,
    displayCommand: server.displayCommand,
    digest: server.digest,
    trustState: "pending_trust" as const,
  }));
  // 损坏 store 优先于任何信任计算：load 已 fail-closed 返回空 records 并改名留证。
  if (loaded.status === "corrupt") {
    return {
      workspacePath: discovered.workspacePath,
      workspaceIdentity: discovered.workspaceIdentity,
      reasonCode: "project_mcp_trust_store_corrupt",
      items: pendingItems,
    };
  }
  const trustedDigests = new Map(
    loaded.records
      .filter((record) => record.workspaceIdentity === discovered.workspaceIdentity)
      .map((record) => [record.serverName, record.mcpServerDigest] as const),
  );
  const items = discovered.servers.map((server) => ({
    serverName: server.name,
    displayCommand: server.displayCommand,
    digest: server.digest,
    trustState:
      trustedDigests.get(server.name) === server.digest
        ? ("trusted_persistent" as const)
        : ("pending_trust" as const),
  }));
  const reasonCode =
    items.length === 0
      ? "project_mcp_not_applicable"
      : items.every((item) => item.trustState === "trusted_persistent")
        ? "project_mcp_trusted_persistent"
        : "project_mcp_pending_trust";
  return {
    workspacePath: discovered.workspacePath,
    workspaceIdentity: discovered.workspaceIdentity,
    reasonCode,
    items,
  };
}

export async function grantProjectMcpTrust(
  input: ProjectMcpTrustCliTarget & {
    serverNames?: readonly string[];
    all?: boolean;
    appVersion?: string;
  },
): Promise<ProjectMcpTrustCliStatus> {
  const names = unique(input.serverNames ?? []);
  if ((input.all === true) === names.length > 0) {
    throw new Error("Specify exactly one of --all or --server.");
  }
  const discovered = await discoverProjectMcpServers(input);
  const missing = names.filter(
    (name) => !discovered.servers.some((server) => server.name === name),
  );
  if (missing.length > 0) {
    // 只允许授权当前配置里真实存在的项目 stdio server：grant 的是「即将执行的内容」，
    // 名字对不上说明配置已变化，必须让用户重新 review（与 hooks 的 snapshot_mismatch 同理）。
    throw new Error(`project_mcp_server_not_found: ${missing.join(", ")}`);
  }
  const selected = input.all
    ? discovered.servers
    : discovered.servers.filter((server) => names.includes(server.name));
  const store = await createDefaultFileWorkspaceMcpTrustStore(storeOptions(input));
  // 首次显式授权必须 fail closed：corrupt 下直接 grant 会被 store 的恢复逻辑当作
  // 空记录立即覆盖，把恢复副作用伪装成一次成功授权（与 hooks grant 同一裁决）。
  const loaded = await store.load();
  if (loaded.status === "corrupt") {
    throw new Error("project_mcp_trust_store_corrupt");
  }
  const grantedAt = new Date().toISOString();
  const records: WorkspaceMcpTrustRecord[] = selected.map((server) => ({
    workspaceIdentity: discovered.workspaceIdentity,
    serverName: server.name,
    mcpServerDigest: server.digest,
    digestAlgorithm: "sha256",
    decision: "trusted",
    grantedAt,
    displayCommandAtGrant: server.displayCommand,
    ...(input.appVersion ? { appVersionAtGrant: input.appVersion } : {}),
  }));
  await store.grant(records);
  return inspectProjectMcpTrust(input);
}

export async function revokeProjectMcpTrustCli(
  input: ProjectMcpTrustCliTarget & {
    serverNames?: readonly string[];
    all?: boolean;
  },
): Promise<ProjectMcpTrustCliStatus> {
  const names = unique(input.serverNames ?? []);
  if ((input.all === true) === names.length > 0) {
    throw new Error("Specify exactly one of --all or --server.");
  }
  const discovered = await discoverProjectMcpServers(input);
  const store = await createDefaultFileWorkspaceMcpTrustStore(storeOptions(input));
  // R9：corrupt 下 revoke 同样拒绝执行——store 的恢复逻辑会把损坏文件当空记录
  // 重置并返回「成功」，把恢复副作用伪装成一次成功撤销；与 grant 的 fail-closed
  // 及 CLI 帮助文案的恢复指引保持一致（先修复/移除损坏文件，再重新操作）。
  const loaded = await store.load();
  if (loaded.status === "corrupt") {
    throw new Error("project_mcp_trust_store_corrupt");
  }
  await store.revoke({
    workspaceIdentity: discovered.workspaceIdentity,
    ...(input.all ? {} : { serverNames: names }),
  });
  return inspectProjectMcpTrust(input);
}

async function discoverProjectMcpServers(target: ProjectMcpTrustCliTarget): Promise<{
  workspacePath: string;
  workspaceIdentity: string;
  servers: DiscoveredProjectMcpServer[];
}> {
  const workspacePath = resolve(target.workspacePath);
  const workspaceIdentity = resolveProjectMcpTrustIdentity({
    ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
    workingDirectory: workspacePath,
  });
  // 与运行时同一配置解析入口（createConfig）：serverSources 是「项目作用域」的
  // 单一事实源，CLI 不另行扫描 .acode/config.json，避免两条解析路径漂移。
  const configResult = createConfig({
    workingDirectory: workspacePath,
    ...(target.userConfigPath ? { userConfigPath: target.userConfigPath } : {}),
  });
  const serverSources = configResult.sources.mcp?.serverSources ?? {};
  const servers = Object.entries(configResult.config.mcp.servers)
    .filter(
      (entry): entry is [string, McpStdioServerConfig] =>
        serverSources[entry[0]] === "project" && entry[1].type === "stdio",
    )
    .map(([name, config]) => ({
      name,
      config,
      digest: computeProjectMcpServerDigest(name, config),
      displayCommand: formatProjectMcpServerDisplayCommand(config),
    }));
  return { workspacePath, workspaceIdentity, servers };
}

function storeOptions(target: ProjectMcpTrustCliTarget) {
  return {
    ...(target.userConfigPath ? { userConfigPath: target.userConfigPath } : {}),
    ...(target.homeDir ? { homeDir: target.homeDir } : {}),
  };
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
