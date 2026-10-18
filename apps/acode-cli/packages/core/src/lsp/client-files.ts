// Ported from oh-my-pi (MIT) — packages/coding-agent/src/lsp/client.ts（文件同步切片）, Copyright (c) 2025 Mario Zechner & Stencil Labs
// ============================================================
// 文档 overlay：didOpen/didChange/didSave、磁盘 reconcile、watched-files 通知
// ============================================================

import { createHash } from "node:crypto";
import * as path from "node:path";
import { detectLanguageId, fileToUri, isEnoent, readTextFromDisk, uriToFile } from "./uri.js";
import { getRegisteredClients } from "./client-registry.js";
import { sendNotification, throwIfAborted } from "./client-io.js";
import { logger } from "./logger.js";
import type { LspClient } from "./types.js";

/** LSP FileChangeType（workspace/didChangeWatchedFiles）。 */
export enum FileChangeType {
  Created = 1,
  Changed = 2,
  Deleted = 3,
}

/** harness 发起、向活跃 LSP 客户端广播的文件系统变更。 */
export interface WatchedFileChange {
  filePath: string;
  type: FileChangeType;
}

/** 文档签名：最近交给服务器的文本哈希，用于检测外部磁盘编辑分叉。 */
function documentSignature(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

// =============================================================================
// 在途写标记
// =============================================================================

/**
 * writethrough 有意为在途写把服务器 overlay 推进到磁盘之前：先把新文本
 * （可能已格式化）同步给服务器、再落盘。写挂起期间磁盘比 overlay 旧。
 * 按引用计数标记，重叠写共享同一标记直到最后一个提交。
 */
const pendingDiskWrites = new Map<string, number>();

/** 每次调用必须由 {@link endPendingDiskWrite} 平衡。 */
export function beginPendingDiskWrite(filePath: string): void {
  const uri = fileToUri(filePath);
  pendingDiskWrites.set(uri, (pendingDiskWrites.get(uri) ?? 0) + 1);
}

export function endPendingDiskWrite(filePath: string): void {
  const uri = fileToUri(filePath);
  const count = pendingDiskWrites.get(uri);
  if (count === undefined) return;
  if (count > 1) pendingDiskWrites.set(uri, count - 1);
  else pendingDiskWrites.delete(uri);
}

// =============================================================================
// 文件操作锁（按 client:uri 串行化）
// =============================================================================

const fileOperationLocks = new Map<string, Promise<void>>();

async function withFileLock<T>(lockKey: string, operation: () => Promise<T>): Promise<T> {
  const existingLock = fileOperationLocks.get(lockKey);
  if (existingLock) await existingLock.catch(() => {});
  const promise = operation();
  const tracked: Promise<void> = promise.then(
    () => {},
    () => {},
  );
  fileOperationLocks.set(lockKey, tracked);
  try {
    return await promise;
  } finally {
    fileOperationLocks.delete(lockKey);
  }
}

// =============================================================================
// didOpen / didChange / didSave
// =============================================================================

/** 确保文件已在客户端打开；未跟踪则读盘发送 didOpen。 */
export async function ensureFileOpen(client: LspClient, filePath: string, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  const uri = fileToUri(filePath);
  if (client.openFiles.has(uri)) return;
  await withFileLock(`${client.name}:${uri}`, async () => {
    if (client.openFiles.has(uri)) return;
    let content: string;
    try {
      content = await readTextFromDisk(filePath);
      throwIfAborted(signal);
    } catch (error) {
      if (isEnoent(error)) return;
      throw error;
    }
    const languageId = client.config.languageId ?? detectLanguageId(filePath);
    await sendNotification(
      client,
      "textDocument/didOpen",
      { textDocument: { uri, languageId, version: 1, text: content } },
      signal,
    );
    client.openFiles.set(uri, { version: 1, languageId, syncedHash: documentSignature(content) });
    client.lastActivity = Date.now();
  });
}

/** 把内存内容同步给 LSP 客户端（不读盘）：writethrough 落盘前后用它提供即时文本。 */
export async function syncContent(
  client: LspClient,
  filePath: string,
  content: string,
  signal?: AbortSignal,
): Promise<void> {
  const uri = fileToUri(filePath);
  await withFileLock(`${client.name}:${uri}`, async () => {
    // 同步新内容前丢弃陈旧诊断缓存。
    client.diagnostics.delete(uri);
    const info = client.openFiles.get(uri);
    if (!info) {
      const languageId = client.config.languageId ?? detectLanguageId(filePath);
      throwIfAborted(signal);
      await sendNotification(
        client,
        "textDocument/didOpen",
        { textDocument: { uri, languageId, version: 1, text: content } },
        signal,
      );
      client.openFiles.set(uri, { version: 1, languageId, syncedHash: documentSignature(content) });
      client.lastActivity = Date.now();
      return;
    }
    const version = ++info.version;
    throwIfAborted(signal);
    await sendNotification(
      client,
      "textDocument/didChange",
      { textDocument: { uri, version }, contentChanges: [{ text: content }] },
      signal,
    );
    info.syncedHash = documentSignature(content);
    client.lastActivity = Date.now();
  });
}

/** 服务器在 didSave 里要不要全文（textDocumentSync.save.includeText）。 */
function saveIncludesText(client: LspClient): boolean {
  const sync = client.serverCapabilities?.textDocumentSync;
  const save = typeof sync === "object" && sync !== null ? sync.save : undefined;
  return typeof save === "object" && save !== null && save.includeText === true;
}

/** 通知已保存；前提是内容已经 syncContent 过。需要全文的服务器才回读磁盘。 */
export async function notifySaved(client: LspClient, filePath: string, signal?: AbortSignal): Promise<void> {
  const uri = fileToUri(filePath);
  if (!client.openFiles.has(uri)) return;
  throwIfAborted(signal);
  const text = saveIncludesText(client) ? await readTextFromDisk(filePath) : undefined;
  throwIfAborted(signal);
  await sendNotification(
    client,
    "textDocument/didSave",
    text === undefined ? { textDocument: { uri } } : { textDocument: { uri }, text },
    signal,
  );
  client.lastActivity = Date.now();
}

/**
 * 语义查询前把已打开文档与磁盘对齐。
 *
 * {@link ensureFileOpen} 只处理未跟踪文件；不经过 write/edit 工具的外部编辑
 * 会让服务器拿着编辑前文档，而调用方按磁盘内容算查询位置。内容分叉时推
 * didChange 使服务器副本与磁盘一致。返回 true = 推过 didChange（调用方可等
 * 新诊断）；在途写标记的文件完全跳过：overlay 领先磁盘，读盘回灌会把服务器
 * 打回写前内容。
 */
export async function reconcileFileFromDisk(
  client: LspClient,
  filePath: string,
  signal?: AbortSignal,
): Promise<boolean> {
  throwIfAborted(signal);
  const uri = fileToUri(filePath);
  if (!client.openFiles.has(uri)) {
    await ensureFileOpen(client, filePath, signal);
    return false;
  }
  if (pendingDiskWrites.has(uri)) return false;

  let didChange = false;
  await withFileLock(`${client.name}:${uri}`, async () => {
    throwIfAborted(signal);
    const info = client.openFiles.get(uri);
    if (!info) {
      await ensureFileOpen(client, filePath, signal);
      return;
    }
    let content: string;
    try {
      content = await readTextFromDisk(filePath);
      throwIfAborted(signal);
    } catch (error) {
      if (isEnoent(error)) return;
      throw error;
    }
    // 读盘（awaited）之后复查：写可能已开始并同步了 overlay，磁盘快照已陈旧。
    if (pendingDiskWrites.has(uri)) return;
    const signature = documentSignature(content);
    if (signature === info.syncedHash) return;

    // 先丢弃陈旧文档算出的诊断缓存，服务器重算前不再误用。
    client.diagnostics.delete(uri);
    const version = ++info.version;
    throwIfAborted(signal);
    await sendNotification(
      client,
      "textDocument/didChange",
      { textDocument: { uri, version }, contentChanges: [{ text: content }] },
      signal,
    );
    info.syncedHash = signature;
    client.lastActivity = Date.now();
    didChange = true;
  });
  return didChange;
}

/** 刷新已打开文档：版本递增 + didChange + didSave（writethrough 与 reload 用）。 */
export async function refreshFile(client: LspClient, filePath: string, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  const uri = fileToUri(filePath);
  await withFileLock(`${client.name}:${uri}`, async () => {
    throwIfAborted(signal);
    client.diagnostics.delete(uri);
    const info = client.openFiles.get(uri);
    if (!info) {
      await ensureFileOpen(client, filePath, signal);
      return;
    }
    let content: string;
    try {
      content = await readTextFromDisk(filePath);
      throwIfAborted(signal);
    } catch (error) {
      if (isEnoent(error)) return;
      throw error;
    }
    const version = ++info.version;
    throwIfAborted(signal);
    await sendNotification(
      client,
      "textDocument/didChange",
      { textDocument: { uri, version }, contentChanges: [{ text: content }] },
      signal,
    );
    throwIfAborted(signal);
    await sendNotification(
      client,
      "textDocument/didSave",
      saveIncludesText(client) ? { textDocument: { uri }, text: content } : { textDocument: { uri } },
      signal,
    );
    info.syncedHash = documentSignature(content);
    client.lastActivity = Date.now();
  });
}

// =============================================================================
// watched-files 通知
// =============================================================================

/** 单向 watched-files 通知预算：卡死的服务器绝不悬挂触发它的文件变更。 */
const WATCHED_FILES_NOTIFY_TIMEOUT_MS = 2000;

function isPathInsideWorkspace(filePath: string, workspace: string): boolean {
  const relative = path.relative(workspace, path.resolve(filePath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * 把 harness 发起的文件系统变更广播给 cwd 的活跃 LSP 客户端。
 * 创建/删除会改变其它打开文档的模块解析，通知后再刷新那些 overlay。
 */
export async function notifyWorkspaceWatchedFiles(
  cwd: string,
  changes: readonly WatchedFileChange[],
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  if (changes.length === 0) return;
  const workspace = path.resolve(cwd);
  const activeClients = Array.from(getRegisteredClients()).filter(
    (client) => client.status === "ready" && path.resolve(client.cwd) === workspace,
  );
  if (activeClients.length === 0) return;

  const timeoutSignal = AbortSignal.timeout(WATCHED_FILES_NOTIFY_TIMEOUT_MS);
  const sendSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const results = await Promise.allSettled(
    activeClients.map(async (client) => {
      const clientChanges = changes
        .filter((change) => isPathInsideWorkspace(change.filePath, workspace))
        .map((change) => {
          const uri = fileToUri(change.filePath);
          client.diagnostics.delete(uri);
          return { uri, type: change.type };
        });
      if (clientChanges.length === 0) return;
      await sendNotification(client, "workspace/didChangeWatchedFiles", { changes: clientChanges }, sendSignal);
      if (clientChanges.every((change) => change.type === FileChangeType.Changed)) return;
      await Promise.all(Array.from(client.openFiles.keys(), (uri) => refreshFile(client, uriToFile(uri), sendSignal)));
    }),
  );
  throwIfAborted(signal);
  for (const result of results) {
    if (result.status === "rejected") {
      logger.debug("LSP watched-files notification failed", { cwd, error: logger.formatError(result.reason) });
    }
  }
}
