// Ported from oh-my-pi (MIT) — packages/coding-agent/src/lsp/client.ts（创建切片）, Copyright (c) 2025 Mario Zechner & Stencil Labs
// ============================================================
// LSP 客户端创建：惰性 spawn、initialize 握手、并发去重
// ============================================================

import { spawn as nodeSpawn } from "node:child_process";
import * as path from "node:path";
import { fileToUri } from "./uri.js";
import {
  sendNotification,
  sendRequest,
  setWedgedClientTeardown,
  throwIfAborted,
} from "./client-io.js";
import { startMessageReader } from "./client-reader.js";
import {
  consumeInitFailure,
  deleteInitFailure,
  recordInitFailure,
  reconcileIdleChecker,
} from "./client-idle.js";
import {
  clientKey,
  deleteClientLockIfCurrent,
  deleteRegisteredClientIfCurrent,
  getReloadBarrier,
  getClientLock,
  getRegisteredClient,
  isClientKeyInvalidated,
  setClientLock,
  setRegisteredClient,
} from "./client-registry.js";
import { CLIENT_CAPABILITIES } from "./capabilities.js";
import { logger } from "./logger.js";
import { EquivalentUriMap } from "./uri.js";
import type { LspClient, ServerConfig } from "./types.js";

// =============================================================================
// 进程传输
// =============================================================================

function spawnRealTransport(config: ServerConfig, cwd: string): LspClient["proc"] {
  const command = config.resolvedCommand ?? config.command;
  const args = config.args ?? [];
  const child = nodeSpawn(command, args, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const stderrTail: string[] = [];
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrTail.push(chunk.toString("utf8"));
    if (stderrTail.length > 50) stderrTail.shift();
  });
  if (!child.stdin || !child.stdout) {
    throw new Error(`LSP server spawn produced no stdio pipes: ${command}`);
  }
  const stdin = child.stdin;
  const stdout = child.stdout;
  return {
    stdin,
    stdout,
    kill: () => {
      try {
        child.kill();
      } catch {
        // 进程已消失——退出回调完成清理。
      }
    },
    get exitCode() {
      return child.exitCode;
    },
    exited: new Promise<number>((resolve) => {
      child.once("exit", (code) => resolve(code ?? -1));
      child.once("error", () => resolve(-1));
    }),
    peekStderr: () => stderrTail.join(""),
    pid: child.pid,
  };
}

/** 测试接缝：替换 spawn 行为（stub 语言服务器）。返回 null 走真实 spawn。 */
export type SpawnTransportOverride = (config: ServerConfig, cwd: string) => LspClient["proc"] | null;
let spawnOverride: SpawnTransportOverride | null = null;

export function setSpawnTransportOverride(override: SpawnTransportOverride | null): void {
  spawnOverride = override;
}

// =============================================================================
// 客户端创建
// =============================================================================

const PROJECT_LOAD_TIMEOUT_MS = 15000;

/**
 * 取或建指定配置与 cwd 的 LSP 客户端。并发调用共享同一次初始化；
 * 确定性失败走负缓存快速失败。
 */
export async function getOrCreateClient(
  config: ServerConfig,
  cwd: string,
  initTimeoutMs?: number,
  signal?: AbortSignal,
): Promise<LspClient> {
  const key = clientKey(config, cwd);
  const existingClient = getRegisteredClient(key);
  if (existingClient && !isClientKeyInvalidated(key)) {
    existingClient.lastActivity = Date.now();
    return existingClient;
  }

  const existingLock = getClientLock(key);
  if (existingLock) return existingLock.promise;
  if (isClientKeyInvalidated(key)) {
    throw new Error(`LSP configuration was superseded during reload: ${config.command}`);
  }

  // 不在陈旧进程确认停止前启动新身份（reload 屏障）。
  const reloadBarrier = getReloadBarrier(cwd);
  if (reloadBarrier) {
    try {
      await reloadBarrier;
    } catch (error) {
      throwIfAborted(signal);
      throw error instanceof Error ? error : new Error(String(error));
    }
    const clientAfterReload = getRegisteredClient(key);
    if (clientAfterReload && !isClientKeyInvalidated(key)) {
      clientAfterReload.lastActivity = Date.now();
      return clientAfterReload;
    }
    const lockAfterReload = getClientLock(key);
    if (lockAfterReload) return lockAfterReload.promise;
    if (isClientKeyInvalidated(key)) {
      throw new Error(`LSP configuration was superseded during reload: ${config.command}`);
    }
  }

  const recentFailure = consumeInitFailure(key, config.command);
  if (recentFailure) throw recentFailure;

  const lockToken = Symbol();
  const clientPromise = (async (): Promise<LspClient> => {
    const transport: LspClient["proc"] =
      spawnOverride !== null
        ? (spawnOverride(config, cwd) ?? spawnRealTransport(config, cwd))
        : spawnRealTransport(config, cwd);

    let resolveProjectLoaded!: () => void;
    const projectLoaded = new Promise<void>((resolve) => {
      resolveProjectLoaded = resolve;
    });
    // 服务器不用进度令牌时按超时自动放行。
    const projectLoadTimeout = setTimeout(resolveProjectLoaded, PROJECT_LOAD_TIMEOUT_MS);
    projectLoadTimeout.unref();
    const originalResolve = resolveProjectLoaded;
    resolveProjectLoaded = () => {
      clearTimeout(projectLoadTimeout);
      originalResolve();
    };

    const client: LspClient = {
      name: key,
      cwd,
      proc: transport,
      config,
      requestId: 0,
      diagnostics: new EquivalentUriMap(),
      diagnosticsVersion: 0,
      dynamicCapabilityRegistrations: new Map(),
      openFiles: new Map(),
      pendingRequests: new Map(),
      isReading: false,
      status: "connecting",
      lastActivity: Date.now(),
      startedAt: Date.now(),
      writeQueue: Promise.resolve(),
      activeProgressTokens: new Set(),
      projectLoaded,
      resolveProjectLoaded,
    };

    // 崩溃恢复：进程退出即移除注册并拒绝全部 pending。
    transport.exited.then(() => {
      deleteRegisteredClientIfCurrent(key, client);
      deleteClientLockIfCurrent(key, lockToken);
      client.resolveProjectLoaded();
      if (client.pendingRequests.size > 0) {
        // 剥掉 marksman 这类 [INF] 时间戳启动噪声行——是日志不是错误。
        const rawStderr = transport.peekStderr().trim();
        const stderr = rawStderr
          .split("\n")
          .filter((line) => !/^\[\d{2}:\d{2}:\d{2} (?:INF|DBG|VRB)\]/.test(line))
          .join("\n")
          .trim();
        const code = transport.exitCode;
        const error = new Error(
          stderr ? `LSP server exited (code ${code}): ${stderr}` : `LSP server exited unexpectedly (code ${code})`,
        );
        for (const pending of client.pendingRequests.values()) pending.reject(error);
        client.pendingRequests.clear();
      }
      reconcileIdleChecker();
    });

    void startMessageReader(client);

    try {
      const initResult = (await sendRequest(
        client,
        "initialize",
        {
          processId: process.pid,
          rootUri: fileToUri(cwd),
          rootPath: cwd,
          capabilities: CLIENT_CAPABILITIES,
          initializationOptions: config.initOptions ?? {},
          workspaceFolders: [{ uri: fileToUri(cwd), name: path.basename(cwd) || "workspace" }],
        },
        signal,
        initTimeoutMs,
      )) as { capabilities?: unknown } | null;

      if (!initResult) throw new Error("Failed to initialize LSP: no response");
      client.serverCapabilities = (initResult.capabilities ?? {}) as LspClient["serverCapabilities"];

      await sendNotification(client, "initialized", {}, signal);
      await sendNotification(client, "workspace/didChangeConfiguration", { settings: config.settings ?? {} }, signal);

      client.status = "ready";
      if (isClientKeyInvalidated(key)) {
        throw new Error(`LSP configuration was superseded during initialization: ${config.command}`);
      }
      setRegisteredClient(key, client);
      deleteInitFailure(key);
      reconcileIdleChecker();
      return client;
    } catch (err) {
      client.status = "error";
      deleteRegisteredClientIfCurrent(key, client);
      transport.kill();
      const message = err instanceof Error ? err.message : String(err);
      // 只负缓存确定性失败：调用方收窄的超时（warmup/writethrough）与调用方
      // 取消是瞬态——服务器可能只是慢，或用户主动取消，换新 deadline 应重试。
      if (!signal?.aborted && !(initTimeoutMs !== undefined && message.includes("timed out"))) {
        recordInitFailure(key, message);
      }
      throw err instanceof Error ? err : new Error(message);
    } finally {
      deleteClientLockIfCurrent(key, lockToken);
    }
  })();

  setClientLock(key, { promise: clientPromise, cwd, config, token: lockToken });
  return clientPromise;
}

/** 返回活跃或正在启动的客户端，绝不 spawn（writethrough 的 createMissing=false 路径）。 */
export async function getActiveOrPendingClient(
  config: ServerConfig,
  cwd: string,
  signal?: AbortSignal,
): Promise<LspClient | undefined> {
  throwIfAborted(signal);
  const client = getRegisteredClient(clientKey(config, cwd));
  if (client) {
    client.lastActivity = Date.now();
    return client;
  }
  const pending = getClientLock(clientKey(config, cwd));
  if (!pending) return undefined;
  try {
    return await pending.promise;
  } catch {
    throwIfAborted(signal);
    return undefined;
  }
}

/**
 * 等服务器初始工程加载完成：竞速 $/progress 令牌与调用方 signal。
 * 已完成或超时放行时立即返回。（rust-analyzer 的 analyzerStatus 轮询未移植，
 * 见 spec §8 削减登记。）
 */
export async function waitForProjectLoaded(client: LspClient, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  await Promise.race([
    client.projectLoaded,
    ...(signal
      ? [new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))]
      : []),
  ]);
}

// 卡死客户端拆毁（io 层经此回调，避免 io→client 循环依赖）。
setWedgedClientTeardown((client) => {
  deleteRegisteredClientIfCurrent(client.name, client);
  try {
    client.proc.kill();
  } catch {
    // 进程已消失或不可杀——退出回调完成清理。
  }
  logger.debug("wedged LSP client torn down", { server: client.name });
});
