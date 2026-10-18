// Ported from oh-my-pi (MIT) — packages/coding-agent/src/lsp/client.ts（注册表切片）, Copyright (c) 2025 Mario Zechner & Stencil Labs
// ============================================================
// LSP 客户端注册表：身份键、并发创建锁、reload 墓碑与屏障
// ============================================================

import * as path from "node:path";
import type { LspClient, ServerConfig } from "./types.js";

/** 活跃客户端注册表：key = 客户端身份键。 */
const clients = new Map<string, LspClient>();

export interface PendingClient {
  promise: Promise<LspClient>;
  cwd: string;
  config: ServerConfig;
  token: symbol;
}

/** 并发创建锁：同身份键的初始化只跑一次。 */
const clientLocks = new Map<string, PendingClient>();

/** reload 墓碑：被新配置取代的身份键，禁止再解析到旧客户端。 */
const invalidatedClientKeys = new Set<string>();

/** 同 cwd 的 reload 串行屏障。 */
const clientReloadBarriers = new Map<string, Promise<unknown>>();

/**
 * 服务器进程与初始化的完整身份：决定两个配置能否共享一个客户端。
 * 只用 command+cwd 曾把不同 args/settings 的配置错接到别人的进程（omp #8382），
 * reload 后换配置也解析到陈旧客户端（omp #8384）。JSON 编码杜绝分隔符伪造。
 */
export function clientKey(config: ServerConfig, cwd: string): string {
  const spawnCommand = config.resolvedCommand ?? config.command;
  const identity = JSON.stringify([
    config.args ?? [],
    config.initOptions ?? null,
    config.settings ?? null,
    config.languageId ?? null,
  ]);
  return `${spawnCommand}:${cwd}:${identity}`;
}

// ---- 注册表访问器（client.ts / client-idle / client-shutdown 的唯一共享面） ----

export function getRegisteredClient(key: string): LspClient | undefined {
  return clients.get(key);
}

export function getRegisteredClients(): LspClient[] {
  return Array.from(clients.values());
}

export function setRegisteredClient(key: string, client: LspClient): void {
  clients.set(key, client);
}

export function deleteRegisteredClientIfCurrent(key: string, client: LspClient): boolean {
  if (clients.get(key) === client) {
    clients.delete(key);
    return true;
  }
  return false;
}

export function hasRegisteredClient(key: string): boolean {
  return clients.has(key);
}

// ---- 创建锁访问器 ----

export function getClientLock(key: string): PendingClient | undefined {
  return clientLocks.get(key);
}

export function setClientLock(key: string, pending: PendingClient): void {
  clientLocks.set(key, pending);
}

export function deleteClientLockIfCurrent(key: string, token: symbol): boolean {
  if (clientLocks.get(key)?.token === token) {
    clientLocks.delete(key);
    return true;
  }
  return false;
}

export function allClientLocks(): Array<[string, PendingClient]> {
  return Array.from(clientLocks.entries());
}

export function clearClientLocks(): void {
  clientLocks.clear();
}

// ---- reload 墓碑 / 屏障访问器 ----

export function isClientKeyInvalidated(key: string): boolean {
  return invalidatedClientKeys.has(key);
}

export function invalidateClientKey(key: string): void {
  invalidatedClientKeys.add(key);
}

export function removeInvalidatedClientKey(key: string): void {
  invalidatedClientKeys.delete(key);
}

export function clearInvalidatedClientKeys(): void {
  invalidatedClientKeys.clear();
}

export function getReloadBarrier(cwd: string): Promise<unknown> | undefined {
  return clientReloadBarriers.get(path.resolve(cwd));
}

export function setReloadBarrier(cwd: string, barrier: Promise<unknown>): void {
  clientReloadBarriers.set(path.resolve(cwd), barrier);
}

export function clearReloadBarrierIfCurrent(cwd: string, barrier: Promise<unknown>): void {
  const resolved = path.resolve(cwd);
  if (clientReloadBarriers.get(resolved) === barrier) clientReloadBarriers.delete(resolved);
}

export function clearReloadBarriers(): void {
  clientReloadBarriers.clear();
}
