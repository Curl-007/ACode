/**
 * server 远端目标的端点归一与身份解析助手。
 *
 * 统一一处实现，供 remoteEnvironmentKey、remote-workspace-identity 和 desktop main
 * 的 target 比较共享；此前 desktopRemoteSessions.ts 持有同逻辑私有副本，这里收口。
 */
import type { ServerConnectOptions } from "./remoteTarget.js";

/** 身份解析所需的最小字段集（连接态与持久态快照都满足）。 */
type ServerIdentitySource = Pick<ServerConnectOptions, "url" | "name" | "serverId">;

/**
 * 把 server URL 归一为可比较的稳定形态：ws→http、wss→https，清空 hash/search，
 * 去收尾斜杠，并去掉末尾的 `/ws` 路径段（用户可能直接粘贴 ws 端点）。
 * 非法 URL 时退化为去尾斜杠的原文，保证比较仍确定。
 */
export function normalizeServerEndpoint(url: string): string {
  try {
    const parsed = new URL(url.trim());
    if (parsed.protocol === "ws:") parsed.protocol = "http:";
    if (parsed.protocol === "wss:") parsed.protocol = "https:";
    parsed.hash = "";
    parsed.search = "";
    const normalizedPath = parsed.pathname.replace(/\/+$/g, "");
    parsed.pathname = normalizedPath.endsWith("/ws")
      ? normalizedPath.slice(0, -"/ws".length) || "/"
      : normalizedPath || "/";
    return parsed.toString().replace(/\/$/g, "");
  } catch {
    return url.trim().replace(/\/+$/g, "");
  }
}

/**
 * 身份 authority 段的归一：小写，非 `[a-z0-9._-]` 连续段替换为单个 `-`，去首尾 `-`。
 * 空结果抛错——身份不允许退化成无 authority 的 key。
 */
export function normalizeServerIdForIdentity(serverId: string): string {
  const normalized = serverId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!normalized) {
    throw new Error(`无法从 server 标识推导 workspace identity: ${serverId}`);
  }
  return normalized;
}

/**
 * 解析 server 身份 id：优先 serverId，其次展示名，再次 URL host，最后原始 url。
 * 与参考实现一致，保证同一 server 在不同输入下落到同一身份段。
 */
export function resolveServerIdentityId(target: ServerIdentitySource): string {
  const serverId = target.serverId?.trim();
  if (serverId) {
    return serverId;
  }
  const name = target.name?.trim();
  if (name) {
    return name;
  }
  try {
    const host = new URL(target.url.trim()).host;
    if (host) {
      return host;
    }
  } catch {
    // 非法 URL 时回落到原始字符串，交由 normalizeServerIdForIdentity 归一。
  }
  return target.url.trim();
}
