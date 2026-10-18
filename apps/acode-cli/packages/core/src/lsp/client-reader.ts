// Ported from oh-my-pi (MIT) — packages/coding-agent/src/lsp/client.ts（读取循环/服务端请求切片）, Copyright (c) 2025 Mario Zechner & Stencil Labs
// ============================================================
// LSP 入站：后台消息读取循环与服务端发起的请求应答
// ============================================================

import * as nodeUrl from "node:url";
import { MessageFramer } from "./message-framing.js";
import { sendResponse } from "./client-io.js";
import { applyWorkspaceEdit } from "./edits.js";
import { refreshFile } from "./client-files.js";
import { logger } from "./logger.js";
import type {
  Diagnostic,
  LspClient,
  LspJsonRpcNotification,
  LspJsonRpcRequest,
  LspJsonRpcResponse,
  PublishDiagnosticsParams,
  WorkspaceEdit,
} from "./types.js";
import { uriToFile } from "./uri.js";

// -----------------------------------------------------------------------------
// 服务端发起的请求
// -----------------------------------------------------------------------------

interface DynamicCapabilityRegistration {
  id?: unknown;
  method?: unknown;
}

function updateDynamicCapabilities(client: LspClient, message: LspJsonRpcRequest): void {
  const params = message.params as {
    registrations?: DynamicCapabilityRegistration[];
    unregisterations?: DynamicCapabilityRegistration[];
    unregistrations?: DynamicCapabilityRegistration[];
  };
  if (message.method === "client/registerCapability") {
    if (!Array.isArray(params.registrations)) return;
    for (const registration of params.registrations) {
      if (typeof registration.id === "string" && typeof registration.method === "string") {
        client.dynamicCapabilityRegistrations.set(registration.id, registration.method);
      }
    }
    return;
  }
  const unregistrations = params.unregisterations ?? params.unregistrations;
  if (!Array.isArray(unregistrations)) return;
  for (const registration of unregistrations) {
    if (typeof registration.id === "string") client.dynamicCapabilityRegistrations.delete(registration.id);
  }
}

/** 服务端是否（静态或动态）声明了 LSP 3.17 文档拉取式诊断。 */
export function supportsDocumentDiagnostics(client: LspClient): boolean {
  if (client.serverCapabilities?.diagnosticProvider) return true;
  for (const method of client.dynamicCapabilityRegistrations.values()) {
    if (method === "textDocument/diagnostic") return true;
  }
  return false;
}

/** 应答服务端请求；headless 场景按 spec 拒绝 UI 类请求。 */
async function handleServerRequest(client: LspClient, message: LspJsonRpcRequest): Promise<void> {
  if (message.method === "workspace/configuration") {
    const params = message.params as { items?: Array<{ section?: string }> };
    const items = params?.items ?? [];
    const result = items.map((item) => client.config.settings?.[item.section ?? ""] ?? null);
    await sendResponse(client, message.id, result, message.method);
    return;
  }
  if (message.method === "workspace/workspaceFolders") {
    await sendResponse(
      client,
      message.id,
      [{ uri: nodeUrl.pathToFileURL(client.cwd).href, name: client.cwd.split(/[\\/]/).pop() || "workspace" }],
      message.method,
    );
    return;
  }
  if (message.method === "workspace/applyEdit") {
    await handleApplyEditRequest(client, message);
    return;
  }
  if (
    message.method === "client/registerCapability" ||
    message.method === "client/unregisterCapability"
  ) {
    // 部分服务器阻塞语义请求直到动态注册应答成功，必须先更新再应答。
    updateDynamicCapabilities(client, message);
    await sendResponse(client, message.id, null, message.method);
    return;
  }
  if (message.method === "window/showDocument") {
    // headless：spec 结果形为 { success: boolean }。
    await sendResponse(client, message.id, { success: false }, message.method);
    return;
  }
  // 进度令牌创建与各 workspace/*/refresh：按 spec 以空结果确认。
  if (
    message.method === "window/workDoneProgress/create" ||
    message.method === "window/showMessageRequest" ||
    (message.method.startsWith("workspace/") && message.method.endsWith("/refresh"))
  ) {
    await sendResponse(client, message.id, null, message.method);
    return;
  }
  // 未知方法按 spec 回 method-not-found，探测型调用方据此降级。
  await sendResponse(client, message.id, null, message.method, {
    code: -32601,
    message: `Method not found: ${message.method}`,
  });
}

/** 服务端主动 applyEdit：落盘后刷新受影响的打开 overlay，避免 overlay 陈旧。 */
async function handleApplyEditRequest(client: LspClient, message: LspJsonRpcRequest): Promise<void> {
  const params = message.params as { edit?: WorkspaceEdit };
  if (!params?.edit) {
    await sendResponse(client, message.id, { applied: false, failureReason: "No edit provided" }, message.method);
    return;
  }
  const touchedUris = collectWorkspaceEditUris(params.edit);
  try {
    await applyWorkspaceEdit(params.edit, client.cwd);
    await sendResponse(client, message.id, { applied: true }, message.method);
  } catch (err) {
    await sendResponse(client, message.id, { applied: false, failureReason: logger.formatError(err) }, message.method);
    return;
  }
  for (const uri of touchedUris) {
    if (!client.openFiles.has(uri)) continue;
    try {
      await refreshFile(client, uriToFile(uri));
    } catch (error) {
      logger.debug("LSP server-initiated applyEdit overlay refresh failed", {
        server: client.name,
        error: logger.formatError(error),
      });
    }
  }
}

function collectWorkspaceEditUris(edit: WorkspaceEdit): string[] {
  const uris = new Set<string>();
  if (edit.changes) for (const uri of Object.keys(edit.changes)) uris.add(uri);
  if (edit.documentChanges) {
    for (const change of edit.documentChanges) {
      if ("textDocument" in change && change.textDocument) uris.add(change.textDocument.uri);
      else if ("uri" in change) uris.add(change.uri);
      else if ("oldUri" in change) {
        uris.add(change.oldUri);
        uris.add(change.newUri);
      }
    }
  }
  return Array.from(uris);
}

// -----------------------------------------------------------------------------
// 后台读取循环
// -----------------------------------------------------------------------------

const READER_EXIT_GRACE_MS = 100;

/**
 * 启动后台消息读取循环：响应路由到 pending 请求，通知更新诊断缓存/进度令牌。
 * 单条坏消息或 handler 抛错不杀死循环——后续消息仍成帧完好。
 */
export async function startMessageReader(client: LspClient, onDiagnostics?: () => void): Promise<void> {
  if (client.isReading) return;
  client.isReading = true;
  const stream = client.proc.stdout;
  const framer = new MessageFramer();

  const processMessage = async (messageText: string): Promise<void> => {
    try {
      const message = JSON.parse(messageText) as LspJsonRpcResponse | (LspJsonRpcRequest & LspJsonRpcNotification);
      // method 优先判别：服务端请求 id 与客户端在途 id 常撞号，先匹配 pending
      // 会把服务端配置拉取吞成假响应、卡死冷启动握手（omp #3001）。
      if ("method" in message) {
        if ("id" in message && message.id !== undefined) {
          await handleServerRequest(client, message as LspJsonRpcRequest);
        } else if (
          message.method === "textDocument/publishDiagnostics" &&
          message.params &&
          typeof message.params === "object"
        ) {
          const params = message.params as PublishDiagnosticsParams;
          client.diagnostics.set(params.uri, {
            diagnostics: params.diagnostics as Diagnostic[],
            version: params.version ?? null,
          });
          client.diagnosticsVersion += 1;
          onDiagnostics?.();
        } else if (message.method === "$/progress" && message.params && typeof message.params === "object") {
          const params = message.params as { token: string | number; value?: { kind?: string } };
          if (params.value?.kind === "begin") {
            client.activeProgressTokens.add(params.token);
          } else if (params.value?.kind === "end") {
            client.activeProgressTokens.delete(params.token);
            if (client.activeProgressTokens.size === 0) client.resolveProjectLoaded();
          }
        }
      } else if ("id" in message && message.id !== undefined) {
        const pending = client.pendingRequests.get(message.id);
        if (pending) {
          client.pendingRequests.delete(message.id);
          if ("error" in message && message.error) {
            // 带 JSON-RPC 错误码：method-not-found 靠 -32601 子串识别，
            // 不依赖服务器措辞（如 "Unknown request"）。
            const code = message.error.code;
            pending.reject(
              new Error(`LSP error${typeof code === "number" ? ` ${code}` : ""}: ${message.error.message}`),
            );
          } else {
            pending.resolve(message.result);
          }
        }
      }
    } catch (err) {
      logger.warn("LSP message handling failed", {
        server: client.name,
        error: logger.formatError(err),
      });
    }
  };

  let readerFailed = false;
  try {
    // 异步迭代读取：close/end 自然结束循环，阻塞读不会空转。
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      framer.push(chunk);
      const messages = framer.drain((headerText) => {
        logger.warn("LSP framing resync: header block without Content-Length", {
          server: client.name,
          header: headerText.slice(0, 200),
        });
      });
      for (const messageText of messages) {
        await processMessage(messageText);
      }
    }
  } catch (error) {
    readerFailed = true;
    for (const pending of Array.from(client.pendingRequests.values())) {
      pending.reject(new Error(`LSP connection closed: ${error}`));
    }
    client.pendingRequests.clear();
  } finally {
    client.isReading = false;
    if (!readerFailed && client.proc.exitCode === null) {
      // 正常流结束但进程未退出：给一小段宽限等退出回调。
      await Promise.race([
        client.proc.exited.then(
          () => true,
          () => true,
        ),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), READER_EXIT_GRACE_MS)),
      ]);
    }
    // 读取循环退出但进程还活着（不可恢复读错误）：没有东西再路由响应，
    // 拆掉客户端——下次调用重新 spawn 而不是超时。
    if (client.proc.exitCode === null) {
      client.status = "error";
      const teardownError = new Error("LSP reader stopped; client torn down");
      for (const pending of client.pendingRequests.values()) pending.reject(teardownError);
      client.pendingRequests.clear();
      client.resolveProjectLoaded();
      client.proc.kill();
    }
  }
}
