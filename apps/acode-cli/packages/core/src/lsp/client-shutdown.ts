// Ported from oh-my-pi (MIT) — packages/coding-agent/src/lsp/client.ts（关停/reload 切片）, Copyright (c) 2025 Mario Zechner & Stencil Labs
// ============================================================
// 客户端关停：shutdown/exit 握手、陈旧配置关停、进程退出清理
// ============================================================

import * as path from "node:path";
import {
  sendNotification,
  sendRequest,
  throwIfAborted,
  waitForExit,
} from "./client-io.js";
import { reconcileIdleChecker } from "./client-idle.js";
import {
  clearClientLocks,
  clearInvalidatedClientKeys,
  clearReloadBarrierIfCurrent,
  clearReloadBarriers,
  clientKey,
  deleteRegisteredClientIfCurrent,
  getRegisteredClient,
  getRegisteredClients,
  hasRegisteredClient,
  invalidateClientKey,
  removeInvalidatedClientKey,
  setRegisteredClient,
  setReloadBarrier,
  getReloadBarrier,
  allClientLocks,
  clearClientLocks as clearLocks,
} from "./client-registry.js";
import { logger } from "./logger.js";
import type { LspClient, LspServerStatus, ServerConfig } from "./types.js";

// =============================================================================
// 陈旧配置关停（reload 语义）
// =============================================================================

/** 关停 cwd 下身份不在 configs 里的客户端，返回被停服务器的命令名。 */
export function shutdownStaleClients(
  cwd: string,
  configs: readonly ServerConfig[],
  signal?: AbortSignal,
): Promise<string[]> {
  const fresh = new Set(configs.map((config) => clientKey(config, cwd)));
  const resolvedCwd = path.resolve(cwd);
  const previousBarrier = getReloadBarrier(cwd);
  const cleanup = (async (): Promise<string[]> => {
    if (previousBarrier) {
      try {
        await previousBarrier;
      } catch {
        throwIfAborted(signal);
        // 上一次 reload 失败后，本次显式 reload 重试 teardown；
        // 期间普通客户端创建仍被屏障阻塞。
      }
    }
    for (const key of fresh) removeInvalidatedClientKey(key);
    // 先墓碑化陈旧身份再等初始化：在途调用者继续共享 promise，
    // 后来的调用者在 reload 期间不能再 spawn 陈旧进程。
    const stalePending = allClientLocks().filter(
      ([key, pending]) => path.resolve(pending.cwd) === resolvedCwd && !fresh.has(key),
    );
    for (const [key] of stalePending) invalidateClientKey(key);
    for (const client of getRegisteredClients()) {
      if (path.resolve(client.cwd) === resolvedCwd && !fresh.has(client.name)) {
        invalidateClientKey(client.name);
      }
    }
    await Promise.all(
      stalePending.map(async ([, pending]) => {
        try {
          await pending.promise;
        } catch {
          throwIfAborted(signal);
        }
      }),
    );

    const stale = getRegisteredClients().filter(
      (client) => path.resolve(client.cwd) === resolvedCwd && !fresh.has(client.name),
    );
    const results = await Promise.all(stale.map((client) => shutdownClientInstance(client)));
    const failed = stale.filter((_, index) => results[index] !== true);
    if (failed.length > 0) {
      throw new Error(
        "Failed to stop LSP server(s) with superseded configuration: " +
          failed.map((client) => client.config.command).join(", "),
      );
    }
    return stale.map((client) => client.config.command);
  })();
  setReloadBarrier(cwd, cleanup);
  void cleanup.then(
    () => clearReloadBarrierIfCurrent(cwd, cleanup),
    () => {},
  );
  return cleanup;
}

// =============================================================================
// 关停
// =============================================================================

const SHUTDOWN_TIMEOUT_MS = 5000;
const EXIT_TIMEOUT_MS = 1000;

/**
 * 用 shutdown/exit 握手拆掉一个客户端实例：先按身份移除注册（绝不顶替同键的
 * 新客户端），再有界优雅关停，超时强杀并确认退出。
 * @returns 进程确认退出返回 true；超出关停预算返回 false（重启语义上算失败）。
 */
export async function shutdownClientInstance(client: LspClient): Promise<boolean> {
  deleteRegisteredClientIfCurrent(client.name, client);
  const error = new Error("LSP client shutdown");
  for (const pending of Array.from(client.pendingRequests.values())) pending.reject(error);
  client.pendingRequests.clear();

  const shutdownCompleted = await sendRequest(client, "shutdown", null, undefined, SHUTDOWN_TIMEOUT_MS).then(
    () => true,
    () => false,
  );
  if (shutdownCompleted) {
    await sendNotification(client, "exit", undefined).catch(() => {});
    if (await waitForExit(client, EXIT_TIMEOUT_MS)) {
      reconcileIdleChecker();
      return true;
    }
  }

  client.proc.kill();
  const exited = await waitForExit(client, EXIT_TIMEOUT_MS);
  if (!exited && !hasRegisteredClient(client.name)) {
    // 进程杀不掉：恢复注册让空闲 checker 继续盯，不留半死注册。
    setRegisteredClient(client.name, client);
  }
  reconcileIdleChecker();
  return exited;
}

export async function shutdownClient(key: string): Promise<boolean> {
  const client = getRegisteredClient(key);
  if (!client) return true;
  return shutdownClientInstance(client);
}

/** 关停全部客户端（进程退出前清理）。 */
export async function shutdownAll(): Promise<void> {
  clearInvalidatedClientKeys();
  clearReloadBarriers();
  const toShutdown = getRegisteredClients();
  for (const client of toShutdown) deleteRegisteredClientIfCurrent(client.name, client);
  const pendingClients = allClientLocks().map(([, pending]) => pending.promise);
  clearLocks();
  const seen = new Set<LspClient>(toShutdown);
  await Promise.allSettled([
    ...toShutdown.map((client) => shutdownClientInstance(client)),
    ...pendingClients.map((pending) =>
      pending.then((client) => {
        if (seen.has(client)) return;
        seen.add(client);
        return shutdownClientInstance(client);
      }),
    ),
  ]);
  reconcileIdleChecker();
}

// =============================================================================
// 状态投影
// =============================================================================

export function getActiveClients(): LspServerStatus[] {
  return getRegisteredClients().map((client) => ({
    name: client.config.command,
    status: client.status,
    fileTypes: client.config.fileTypes,
  }));
}

// 进程清理挂到 beforeExit（不抢 SIGINT/SIGTERM——那是宿主进程围堵的职责）。
if (typeof process !== "undefined") {
  process.on("beforeExit", () => {
    void shutdownAll();
  });
}

// 保留显式引用防 lint 误报（clearClientLocks 与 clearLocks 同名别名二选一使用）。
void clearClientLocks;
void logger;
