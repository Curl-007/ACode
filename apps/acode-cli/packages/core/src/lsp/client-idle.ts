// Ported from oh-my-pi (MIT) — packages/coding-agent/src/lsp/client.ts（负缓存/空闲关停切片）, Copyright (c) 2025 Mario Zechner & Stencil Labs
// ============================================================
// 初始化失败负缓存与空闲超时关停
// ============================================================

import { getConfig } from "./config.js";
import { clientKey as clientIdentityKey } from "./client-registry.js";
import { allClientLocks, getRegisteredClients, type PendingClient } from "./client-registry.js";
import { shutdownClient } from "./client-shutdown.js";
import type { LspClient, ServerConfig } from "./types.js";

// =============================================================================
// 负缓存：确定性初始化失败快速失败
// =============================================================================

export const INIT_FAILURE_BACKOFF_MS = 3 * 60 * 1000;
const initFailures = new Map<string, { at: number; message: string }>();

/** 显式 reload 允许立即重试匹配身份的初始化失败。 */
export function clearInitializationFailure(config: ServerConfig, cwd: string): void {
  initFailures.delete(clientIdentityKey(config, cwd));
}

/** 命中未过期负缓存时返回失败错误，否则清除过期条目并返回 undefined。 */
export function consumeInitFailure(key: string, command: string): Error | undefined {
  const recentFailure = initFailures.get(key);
  if (!recentFailure) return undefined;
  if (Date.now() - recentFailure.at < INIT_FAILURE_BACKOFF_MS) {
    return new Error(`LSP server ${command} failed to initialize recently: ${recentFailure.message}`);
  }
  initFailures.delete(key);
  return undefined;
}

/** 记录确定性初始化失败。 */
export function recordInitFailure(key: string, message: string): void {
  initFailures.set(key, { at: Date.now(), message });
}

export function deleteInitFailure(key: string): void {
  initFailures.delete(key);
}

/** 测试接缝：清空负缓存。 */
export function resetInitFailures(): void {
  initFailures.clear();
}

// =============================================================================
// 空闲关停
// =============================================================================

let idleCheckInterval: NodeJS.Timeout | null = null;
const IDLE_CHECK_INTERVAL_MS = 60 * 1000;

/**
 * 有在途请求的客户端是 busy，绝不回收；lastActivity 在请求结算时刷新，
 * 所以空闲窗口从最后一次交换完成起算（omp #8390）。导出供测试。
 */
export function isIdleClient(client: LspClient, now: number, timeoutMs: number): boolean {
  if (client.pendingRequests.size > 0) return false;
  return now - client.lastActivity > timeoutMs;
}

export function isIdleCheckerRunning(): boolean {
  return idleCheckInterval !== null;
}

function configuredIdleTimeoutMs(cwd: string): number {
  return getConfig(cwd).idleTimeoutMs ?? 0;
}

/** 依当前配置启动/停掉后台空闲 checker。 */
export function reconcileIdleChecker(): void {
  const anyTimeout =
    getRegisteredClients().some((client) => configuredIdleTimeoutMs(client.cwd) > 0) ||
    allClientLocks().some(([, pending]) => configuredIdleTimeoutMs(pending.cwd) > 0);
  if (anyTimeout && idleCheckInterval === null) {
    idleCheckInterval = setInterval(() => {
      void checkIdleClients();
    }, IDLE_CHECK_INTERVAL_MS);
    idleCheckInterval.unref();
  } else if (!anyTimeout && idleCheckInterval !== null) {
    clearInterval(idleCheckInterval);
    idleCheckInterval = null;
  }
}

/** 扫描全部客户端按各自 cwd 的空闲超时关停。导出供测试。 */
export async function checkIdleClients(): Promise<void> {
  const now = Date.now();
  for (const client of getRegisteredClients()) {
    const timeoutMs = configuredIdleTimeoutMs(client.cwd);
    if (timeoutMs > 0 && isIdleClient(client, now, timeoutMs)) {
      await shutdownClient(client.name);
    }
  }
}

// PendingClient 类型仅在注册表 API 里流转，这里保留重导出便于同族模块引用。
export type { PendingClient };
