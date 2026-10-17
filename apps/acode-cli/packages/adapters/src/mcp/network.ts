import { accessSync, constants } from "node:fs";
import { delimiter, posix, win32 } from "node:path";
import { sanitizeACodeRuntimeEnv } from "@acode/shared";
import { applyExecHijackEnvGuard } from "../exec/exec-hijack-env-guard.js";
import { createNetworkProxyFetch } from "../network/proxy-fetch.js";
import { applyNetworkEgressEnv, type NetworkEgressEnvPolicy } from "../network/subprocess-env.js";

export type { NetworkEgressEnvPolicy };

export function buildMcpStdioEnv(options: {
  env?: NodeJS.ProcessEnv;
  network?: NetworkEgressEnvPolicy;
}): Record<string, string> {
  const sourceEnv = options.env ?? process.env;
  // 安全加固 P2：MCP stdio server 是第三方供应链执行面，在既有黑名单之上追加剥离
  // 敏感凭据键；per-server env 配置在本函数之后 spread（见 adapters/mcp 的
  // StdioClientTransport 组装），用户显式给单个 server 注入的值不受影响。
  const sanitized = sanitizeACodeRuntimeEnv(filterStringEnv(sourceEnv), {
    stripSensitiveCredentials: true,
  });
  // R4 剥离点②（specs/subprocess-env-credential-allowlist.md 接线需求①）：与 Bash 的
  // execution-command 同一漏斗、同一顺序——先剥离继承面里的执行劫持闭集键
  // （NODE_OPTIONS / LD_PRELOAD 族 / 代理族等），再让 applyNetworkEgressEnv 做代理/CA
  // 的第一方受控重建（后置注入保持优先）。per-server env 在本函数之后 spread：官方
  // 插件宿主经 bootstrap 写入的 ELECTRON_RUN_AS_NODE=1 属第一方 spawn 点重建，不受
  // 本剥离影响（R4「自有受控 spawn 在各自 spawn 点显式重建」边界）。
  applyExecHijackEnvGuard(sanitized);
  return prependRunningNodeDirectory(
    applyNetworkEgressEnv(sanitized, {
      network: options.network,
      sourceEnv,
    }),
  );
}

export function createMcpTransportFetch(options: {
  env?: NodeJS.ProcessEnv;
  network?: NetworkEgressEnvPolicy;
}): typeof globalThis.fetch {
  return createNetworkProxyFetch({
    caCertFile: options.network?.caCertFile,
    env: options.env ?? process.env,
    httpProxy: options.network?.httpProxy,
    noProxy: options.network?.noProxy,
  });
}

function filterStringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") result[key] = value;
  }
  return result;
}

interface RunningNodePathOptions {
  execPath: string;
  isExecutable: (path: string) => boolean;
  platform: NodeJS.Platform;
}

const DEFAULT_RUNNING_NODE_PATH_OPTIONS: RunningNodePathOptions = {
  execPath: process.execPath,
  isExecutable: isExecutableFile,
  platform: process.platform,
};

function prependRunningNodeDirectory(
  env: Record<string, string>,
  options: RunningNodePathOptions = DEFAULT_RUNNING_NODE_PATH_OPTIONS,
): Record<string, string> {
  const pathApi = options.platform === "win32" ? win32 : posix;
  const pathDelimiter = options.platform === "win32" ? ";" : delimiter;
  const executableName = pathApi.basename(options.execPath).toLowerCase();
  if (executableName !== "node" && executableName !== "node.exe") {
    return env;
  }

  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const currentPath = env[pathKey] ?? "";
  const nodeDirectory = pathApi.dirname(options.execPath);
  const pathEntries = currentPath.split(pathDelimiter).filter(Boolean);
  if (pathEntries.some((entry) => arePathEntriesEqual(entry, nodeDirectory, options.platform))) {
    return env;
  }

  const nodeExecutableName = options.platform === "win32" ? "node.exe" : "node";
  if (pathEntries.some((entry) => options.isExecutable(pathApi.join(entry, nodeExecutableName)))) {
    return env;
  }

  // remote Agent 由 ~/.acode/server/node 启动，但登录环境 PATH 不含该目录，
  // Plugin manifest 中标准的 command: "node" 因此无法启动 MCP。复用当前 Agent 的 Node
  // 目录可保持插件配置跨本地/SSH/WSL/Docker 可移植，同时不覆盖插件显式注入的环境。
  return {
    ...env,
    [pathKey]: currentPath ? `${nodeDirectory}${pathDelimiter}${currentPath}` : nodeDirectory,
  };
}

function arePathEntriesEqual(left: string, right: string, platform: NodeJS.Platform): boolean {
  const pathApi = platform === "win32" ? win32 : posix;
  const normalize = (value: string) => {
    const normalized = pathApi.normalize(value);
    return platform === "win32" ? normalized.toLowerCase() : normalized;
  };
  return normalize(left) === normalize(right);
}

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
