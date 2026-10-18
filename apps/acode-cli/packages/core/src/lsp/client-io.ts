// Ported from oh-my-pi (MIT) — packages/coding-agent/src/lsp/client.ts（消息读写切片）, Copyright (c) 2025 Mario Zechner & Stencil Labs
// ============================================================
// LSP 出站：帧写入、出站队列、请求/通知/响应
// ============================================================

import { encodeMessageFrame } from "./message-framing.js";
import type { LspClient, LspJsonRpcId, LspJsonRpcNotification, LspJsonRpcRequest, LspJsonRpcResponse } from "./types.js";
import { logger } from "./logger.js";

export class LspAbortError extends Error {
  constructor(message = "LSP operation aborted") {
    super(message);
    this.name = "LspAbortError";
  }
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new LspAbortError();
  }
}

class LspDrainAbortError extends Error {
  constructor(readonly reason: Error) {
    super(reason.message);
    this.name = "LspDrainAbortError";
  }
}

/** client.ts 注入的 wedged 客户端拆毁回调（避免 io→client 循环依赖）。 */
let wedgedTeardown: ((client: LspClient) => void) | undefined;

export function setWedgedClientTeardown(fn: (client: LspClient) => void): void {
  wedgedTeardown = fn;
}

// -----------------------------------------------------------------------------
// 出站写
// -----------------------------------------------------------------------------

async function writeMessage(
  client: LspClient,
  message: LspJsonRpcRequest | LspJsonRpcNotification | LspJsonRpcResponse,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  // node:child_process 的 stdin 是 WritableStream；传输接口只声明 write 的
  // 最小形，这里按实现面收窄使用。
  const stdin = client.proc.stdin as unknown as NodeJS.WritableStream;
  const drain = new Promise<void>((resolve, reject) => {
    const ok = stdin.write(encodeMessageFrame(message), (error?: Error | null) => {
      if (error) reject(error);
    });
    // write() 返回 false 表示内核缓冲已满；等 drain 事件再算排空。
    if (ok) resolve();
    else stdin.once("drain", () => resolve());
  });
  const writeSettled = drain.catch(() => {});
  if (!signal) {
    await drain;
    return;
  }
  // 服务器停止读 stdin 时内核管道排空会无限阻塞：与调用方 signal 竞速，
  // 卡死的服务器以工具的正常超时/取消形态浮现。
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const onAbort = () => {
    signal.removeEventListener("abort", onAbort);
    drain.catch(() => {}); // 后台排空的最终结算不外抛
    reject(new LspDrainAbortError(signal.reason instanceof Error ? signal.reason : new LspAbortError()));
  };
  signal.addEventListener("abort", onAbort, { once: true });
  drain.then(
    () => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    },
    (error: unknown) => {
      signal.removeEventListener("abort", onAbort);
      reject(error);
    },
  );
  await promise;
  void writeSettled;
}

function queueWriteMessage(
  client: LspClient,
  message: LspJsonRpcRequest | LspJsonRpcNotification | LspJsonRpcResponse,
  signal?: AbortSignal,
): Promise<void> {
  const write = client.writeQueue.catch(() => {}).then(() => writeMessage(client, message, signal));
  const result = write.catch((error: unknown) => {
    if (error instanceof LspDrainAbortError) {
      // 只有与本写入在途排空竞速的 abort 才会留下 pending 的 sink——这类卡死
      // 要拆客户端；预写 abort 与排队中的调用方超时不得杀死健康客户端。
      wedgedTeardown?.(client);
      throw error.reason;
    }
    throw error;
  });
  client.writeQueue = result.catch(() => {});
  return result;
}

// -----------------------------------------------------------------------------
// 请求 / 通知 / 响应
// -----------------------------------------------------------------------------

const DEFAULT_REQUEST_TIMEOUT_MS = 30000;

/**
 * 发送 LSP 请求并等待响应。
 *
 * 超时策略：显式 `timeoutMs` 优先；否则有 `signal` 时不装内部定时器（调用方
 * 拥有 deadline）；否则回退 30s 默认，防止 pending 永久泄漏。
 */
export async function sendRequest(
  client: LspClient,
  method: string,
  params: unknown,
  signal?: AbortSignal,
  timeoutMs?: number,
): Promise<unknown> {
  const id = ++client.requestId;
  throwIfAborted(signal);
  client.lastActivity = Date.now();

  const { promise, resolve, reject } = Promise.withResolvers<unknown>();
  let timeout: NodeJS.Timeout | undefined;
  const cleanup = () => {
    signal?.removeEventListener("abort", abortHandler);
  };
  const abortHandler = () => {
    client.pendingRequests.delete(id);
    void sendNotification(client, "$/cancelRequest", { id }).catch(() => {});
    if (timeout) clearTimeout(timeout);
    cleanup();
    reject(signal?.reason instanceof Error ? signal.reason : new LspAbortError());
  };

  const effectiveTimeoutMs = timeoutMs ?? (signal ? undefined : DEFAULT_REQUEST_TIMEOUT_MS);
  if (effectiveTimeoutMs !== undefined) {
    timeout = setTimeout(() => {
      if (!client.pendingRequests.has(id)) return;
      client.pendingRequests.delete(id);
      void sendNotification(client, "$/cancelRequest", { id }).catch(() => {});
      cleanup();
      reject(new Error(`LSP request ${method} timed out after ${effectiveTimeoutMs}ms`));
    }, effectiveTimeoutMs);
  }
  if (signal) {
    signal.addEventListener("abort", abortHandler, { once: true });
    if (signal.aborted) {
      abortHandler();
      return promise;
    }
  }

  // 结算时刷新 lastActivity：空闲窗口从交换完成起算——长请求若不刷新，
  // 落地瞬间即被空闲回收（omp #8390）。
  client.pendingRequests.set(id, {
    resolve: (result) => {
      if (timeout) clearTimeout(timeout);
      client.lastActivity = Date.now();
      cleanup();
      resolve(result);
    },
    reject: (error) => {
      if (timeout) clearTimeout(timeout);
      client.lastActivity = Date.now();
      cleanup();
      reject(error);
    },
    method,
  });

  queueWriteMessage(client, { jsonrpc: "2.0", id, method, params }, signal).catch((error: unknown) => {
    if (timeout) clearTimeout(timeout);
    client.pendingRequests.delete(id);
    cleanup();
    reject(error instanceof Error ? error : new Error(String(error)));
  });
  return promise;
}

/** 发送通知（无响应期待）。signal 限制底层 flush，防服务器停读 stdin 卡死队列。 */
export async function sendNotification(
  client: LspClient,
  method: string,
  params: unknown,
  signal?: AbortSignal,
): Promise<void> {
  client.lastActivity = Date.now();
  await queueWriteMessage(client, { jsonrpc: "2.0", method, params }, signal);
}

export async function sendResponse(
  client: LspClient,
  id: LspJsonRpcId,
  result: unknown,
  method: string,
  error?: { code: number; message: string; data?: unknown },
): Promise<void> {
  const response: LspJsonRpcResponse = { jsonrpc: "2.0", id, ...(error ? { error } : { result }) };
  try {
    await queueWriteMessage(client, response);
  } catch (err) {
    logger.error("LSP failed to respond.", { method, error: logger.formatError(err) });
  }
}

export function waitForExit(client: LspClient, timeoutMs: number): Promise<boolean> {
  return Promise.race([
    client.proc.exited.then(
      () => true,
      () => true,
    ),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}
