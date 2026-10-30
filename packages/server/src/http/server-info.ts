import { basename } from "node:path";
import { hostname } from "node:os";
import {
  ACODE_VERSION,
  SERVER_REMOTE_PROTOCOL_VERSION,
  type ServerRemoteInfo,
  type ServerRemoteWorkspaceInfo,
} from "@acode/shared";

export interface HttpServerOptions {
  serverId?: string;
  name?: string;
  host?: string;
  authRequired?: boolean;
  authToken?: string;
  spaFallback?: boolean;
  staticRoot?: string;
  workspaces?: ServerRemoteWorkspaceInfo[];
  /** `/ws/host` 升级允许的非 loopback Origin 白名单（DNS-rebinding / 恶意网页防护）。 */
  allowedOrigins?: string[];
  /**
   * 待认领连接惰性过期的时钟源（注入点，供测试用虚拟时间；默认 `Date.now`）。
   * 与 `createHostCapabilityStore({ now })` 同一注入范式，不新增常驻定时器。
   */
  pendingConnectionClock?: () => number;
  /** 待认领连接存活上限（ms），默认 `PENDING_REMOTE_CONNECTION_TTL_MS`；测试可注入更小值。 */
  pendingConnectionTtlMs?: number;
}

function readTrimmedEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function resolveServerId(options: HttpServerOptions): string {
  return (
    options.serverId?.trim() || readTrimmedEnv("ACODE_SERVER_ID") || hostname() || "acode-server"
  );
}

function resolveServerWorkspaces(options: HttpServerOptions): ServerRemoteWorkspaceInfo[] {
  if (options.workspaces) {
    return options.workspaces;
  }
  const workspacePath = readTrimmedEnv("ACODE_SERVER_WORKSPACE") || process.cwd();
  return [
    {
      path: workspacePath,
      label: basename(workspacePath) || workspacePath,
    },
  ];
}

export function createServerInfo(
  options: HttpServerOptions,
  resolvedAuthToken?: string,
): ServerRemoteInfo {
  return {
    serverId: resolveServerId(options),
    ...(options.name?.trim() || readTrimmedEnv("ACODE_SERVER_NAME")
      ? { name: options.name?.trim() || readTrimmedEnv("ACODE_SERVER_NAME") }
      : {}),
    version: ACODE_VERSION,
    protocolVersion: SERVER_REMOTE_PROTOCOL_VERSION,
    // M2 修复：authRequired 必须如实反映「鉴权中间件是否真的挂载」。此前 fallback 读
    // ACODE_SERVER_TOKEN，而真实强制点（entry-http.ts）只读 ACODE_SERVER_AUTH_TOKEN 并经
    // options.authToken 传入——按文档配置旧变量名会得到「自报已鉴权、实际无鉴权」。
    // 现在以调用方实际用于挂中间件的 resolvedAuthToken 为准，不再读任何环境变量；
    // 全仓唯一鉴权 env 名 = ACODE_SERVER_AUTH_TOKEN（本包读取点在 entry-http.ts；
    // Server Core 在 server-core/http.ts 另有自己的单一读取点，见 server-auth.md）。
    authRequired: options.authRequired ?? Boolean(resolvedAuthToken),
    workspaces: resolveServerWorkspaces(options),
    capabilities: {
      desktopContinuous: true,
      websocketRpc: true,
    },
  };
}
