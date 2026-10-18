// Ported from oh-my-pi (MIT) — packages/coding-agent/src/lsp/client.ts（applyEdit 调和切片）, Copyright (c) 2025 Mario Zechner & Stencil Labs
// ============================================================
// WorkspaceEdit 落盘 + overlay/watched-files 调和（工具运行时入口）
// ============================================================

import * as path from "node:path";
import { FileChangeType, notifyWorkspaceWatchedFiles, refreshFile, type WatchedFileChange } from "./client-files.js";
import { sendNotification } from "./client-io.js";
import { getRegisteredClients } from "./client-registry.js";
import { applyWorkspaceEdit, type ExecutedWorkspaceChange } from "./edits.js";
import type { WorkspaceEdit } from "./types.js";
import { uriToFile } from "./uri.js";

/** 从实际执行的操作推导 overlay 刷新与 watched-files 通知。 */
async function reconcileChanges(executed: ExecutedWorkspaceChange[], cwd: string, signal?: AbortSignal): Promise<void> {
  if (executed.length === 0) return;
  const finalUris = new Set<string>();
  const deletedRoots = new Set<string>();
  const watchedFiles: WatchedFileChange[] = [];
  const watch = (uri: string, type: FileChangeType) => watchedFiles.push({ filePath: uriToFile(uri), type });

  for (const change of executed) {
    if (change.kind === "edit") {
      finalUris.add(change.uri);
      watch(change.uri, FileChangeType.Changed);
    } else if (change.kind === "create") {
      finalUris.add(change.uri);
      watch(change.uri, FileChangeType.Created);
    } else if (change.kind === "rename") {
      deletedRoots.add(change.oldUri);
      finalUris.add(change.newUri);
      watch(change.oldUri, FileChangeType.Deleted);
      watch(change.newUri, FileChangeType.Created);
    } else {
      deletedRoots.add(change.uri);
      watch(change.uri, FileChangeType.Deleted);
    }
  }

  const workspace = path.resolve(cwd);
  const activeClients = getRegisteredClients().filter(
    (client) => client.status === "ready" && path.resolve(client.cwd) === workspace,
  );
  for (const activeClient of activeClients) {
    for (const uri of Array.from(activeClient.openFiles.keys())) {
      let deleted = false;
      for (const root of deletedRoots) {
        if (uri === root || uri.startsWith(root.endsWith("/") ? root : `${root}/`)) {
          deleted = true;
          break;
        }
      }
      if (!deleted) continue;
      await sendNotification(activeClient, "textDocument/didClose", { textDocument: { uri } }, signal);
      activeClient.openFiles.delete(uri);
      activeClient.diagnostics.delete(uri);
    }
    for (const uri of finalUris) {
      if (!activeClient.openFiles.has(uri)) continue;
      await refreshFile(activeClient, uriToFile(uri), signal);
    }
  }
  await notifyWorkspaceWatchedFiles(cwd, watchedFiles, signal);
}

/**
 * 应用服务端提供的 workspace edit 并调和全部受影响的打开 LSP 文档：
 * 后续语义请求看到的是已提交文件。调和基于实际执行的操作——被
 * ignoreIfExists/ignoreIfNotExists 跳过的操作既不关闭 overlay 也不通知
 * watcher；中途失败时已执行前缀仍被调和后上抛，被改文件绝不留陈旧 overlay。
 */
export async function applyWorkspaceEditWithLsp(
  edit: WorkspaceEdit,
  cwd: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const executed: ExecutedWorkspaceChange[] = [];
  let applied: string[];
  try {
    applied = await applyWorkspaceEdit(edit, cwd, (change) => executed.push(change));
  } catch (err) {
    // 尽力而为：被改前缀的 overlay 不得保持陈旧，但调和故障不掩盖原始失败。
    try {
      await reconcileChanges(executed, cwd, signal);
    } catch (reconcileError) {
      void reconcileError;
    }
    throw err;
  }
  await reconcileChanges(executed, cwd, signal);
  return applied;
}
