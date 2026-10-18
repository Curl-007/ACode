// Ported from oh-my-pi (MIT) — packages/coding-agent/src/lsp/servers.ts, Copyright (c) 2025 Mario Zechner & Stencil Labs
// ============================================================
// 服务器面助手：只读 action 分级、内容/保存同步、reload
// ============================================================

import { throwIfAborted, sendNotification } from "./client-io.js";
import { getActiveOrPendingClient, getOrCreateClient } from "./client.js";
import { getRegisteredClients } from "./client-registry.js";
import { notifySaved, refreshFile, syncContent } from "./client-files.js";
import { getServersForFile } from "./config.js";
import { shutdownClientInstance } from "./client-shutdown.js";
import type { LspClient, ServerConfig } from "./types.js";
import { uriToFile } from "./uri.js";

/**
 * 不改写 workspace 或语言服务器状态的 LSP action。
 * 不在集合里的（rename、apply 的 code_actions、reload、request 等）按写入分级审批。
 */
export const LSP_READONLY_ACTIONS: ReadonlySet<string> = new Set([
  "diagnostics",
  "definition",
  "type_definition",
  "implementation",
  "references",
  "hover",
  "symbols",
  "status",
  "capabilities",
]);

/** 内容同步到全部适用 LSP 服务器（didOpen/didChange）。 */
export async function syncFileContent(
  absolutePath: string,
  content: string,
  cwd: string,
  servers: ReadonlyArray<[string, ServerConfig]>,
  signal?: AbortSignal,
  createMissing = true,
): Promise<void> {
  throwIfAborted(signal);
  await Promise.allSettled(
    servers.map(async ([, serverConfig]) => {
      throwIfAborted(signal);
      const client = createMissing
        ? await getOrCreateClient(serverConfig, cwd, undefined, signal)
        : await getActiveOrPendingClient(serverConfig, cwd, signal);
      if (!client) return;
      throwIfAborted(signal);
      await syncContent(client, absolutePath, content, signal);
    }),
  );
  throwIfAborted(signal);
}

/** 通知全部服务器文件已保存（内容已由 syncFileContent 同步）。 */
export async function notifyFileSaved(
  absolutePath: string,
  cwd: string,
  servers: ReadonlyArray<[string, ServerConfig]>,
  signal?: AbortSignal,
  createMissing = true,
): Promise<void> {
  throwIfAborted(signal);
  await Promise.allSettled(
    servers.map(async ([, serverConfig]) => {
      throwIfAborted(signal);
      const client = createMissing
        ? await getOrCreateClient(serverConfig, cwd, undefined, signal)
        : await getActiveOrPendingClient(serverConfig, cwd, signal);
      if (!client) return;
      await notifySaved(client, absolutePath, signal);
    }),
  );
  throwIfAborted(signal);
}

export function getLspServers(config: { servers: Record<string, ServerConfig> }): Array<[string, ServerConfig]> {
  return Object.entries(config.servers);
}

/** 扩展名适用的全部服务器（config.ts 的路由规则，类型智能在前）。 */
export function getLspServersForFile(
  config: { servers: Record<string, ServerConfig> },
  filePath: string,
): Array<[string, ServerConfig]> {
  return getServersForFile(config, filePath);
}

/** 主服务器（类型智能优先），definition/hover 等用它。 */
export function getLspServerForFile(
  config: { servers: Record<string, ServerConfig> },
  filePath: string,
): [string, ServerConfig] | null {
  const servers = getServersForFile(config, filePath);
  return servers.length > 0 ? servers[0]! : null;
}

/** 项目感知（非 linter）服务器：类型智能与工程索引语义。 */
export function isProjectAwareLspServer(serverConfig: ServerConfig): boolean {
  return !serverConfig.isLinter;
}

/** LSP 错误是否说明服务器未实现所请求方法。 */
export function isMethodNotFoundError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes("method not found") ||
    msg.includes("unhandled method") ||
    msg.includes("not supported") ||
    msg.includes("-32601")
  );
}

/**
 * reload 单服务器：workspace/didChangeConfiguration 回推同源设置（初始化握手
 * 推过什么就回推什么——裸 `{}` 意为「配置清空」，服务器会静默丢掉配置化的
 * 行为，omp #8383）。通知送不进去（连接卡死/进程已死）则拆掉客户端，下次
 * 请求冷启动新客户端；kill 后未确认退出不算重启成功。
 */
export async function reloadServer(client: LspClient, serverName: string, signal?: AbortSignal): Promise<string> {
  throwIfAborted(signal);
  try {
    await sendNotification(client, "workspace/didChangeConfiguration", { settings: client.config.settings ?? {} }, signal);
  } catch {
    throwIfAborted(signal);
    if (!(await shutdownClientInstance(client))) {
      throw new Error(`Failed to restart ${serverName}: server process did not exit after kill`);
    }
    return `Restarted ${serverName}`;
  }
  await Promise.all(Array.from(client.openFiles.keys(), (uri) => refreshFile(client, uriToFile(uri), signal)));
  return `Reloaded ${serverName}`;
}

/** 状态投影：当前活跃客户端。 */
export function getLspStatus() {
  return getRegisteredClients().map((client) => ({
    name: client.config.command,
    status: client.status,
    fileTypes: client.config.fileTypes,
  }));
}
