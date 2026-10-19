// Ported from oh-my-pi (MIT) — packages/coding-agent/src/lsp/writethrough.ts, Copyright (c) 2025 Mario Zechner & Stencil Labs
// ============================================================
// Writethrough：落盘 → didChange 同步 → 按文档版本等新诊断 → format-on-write
// ============================================================

import * as fs from "node:fs/promises";
import { beginPendingDiskWrite, endPendingDiskWrite, FileChangeType, notifyWorkspaceWatchedFiles } from "./client-files.js";
import { getActiveOrPendingClient } from "./client.js";
import { sendRequest, throwIfAborted } from "./client-io.js";
import { getConfig, getServersForFile } from "./config.js";
import {
  captureDiagnosticVersions,
  captureOpenFileVersions,
  deferredDiagnosticsWaitMs,
  formatContent,
  getDiagnosticsForFile,
  INLINE_DIAGNOSTICS_WAIT_TIMEOUT_MS,
  DIAGNOSTICS_PIPELINE_GRACE_MS,
  type ServerVersionMap,
} from "./diagnostics.js";
import { notifyFileSaved, syncFileContent } from "./servers.js";
import { FileFormatResult } from "./types.js";
import type { FileDiagnosticsResult, LspClient, ServerConfig } from "./types.js";
import { isEnoent } from "./uri.js";

interface ResolvedWritethroughOptions {
  enableFormat: boolean;
  enableDiagnostics: boolean;
  transformDiagnostics?: (absPath: string, result: FileDiagnosticsResult) => FileDiagnosticsResult;
  /** 迟到诊断的每服务器等待预算（毫秒）。 */
  deferredWaitMs: number;
}

/** tsserver 专用命令：创建路径后强制重载工程，防 didOpen 钉死缓存解析。 */
const TSSERVER_REQUEST_COMMAND = "typescript.tsserverRequest";

function supportsTsserverRequest(capabilities: unknown): boolean {
  if (typeof capabilities !== "object" || capabilities === null) return false;
  const executeCommandProvider = (capabilities as { executeCommandProvider?: unknown }).executeCommandProvider;
  if (typeof executeCommandProvider !== "object" || executeCommandProvider === null) return false;
  const commands = (executeCommandProvider as { commands?: unknown }).commands;
  return Array.isArray(commands) && commands.includes(TSSERVER_REQUEST_COMMAND);
}

async function reloadTypeScriptProjectsAfterCreate(
  cwd: string,
  servers: ReadonlyArray<[string, ServerConfig]>,
  signal?: AbortSignal,
): Promise<void> {
  await Promise.all(
    servers.map(async ([, serverConfig]) => {
      let client: LspClient | undefined;
      try {
        client = await getActiveOrPendingClient(serverConfig, cwd, signal);
      } catch {
        signal?.throwIfAborted();
        return;
      }
      if (!client || !supportsTsserverRequest(client.serverCapabilities)) return;
      await sendRequest(
        client,
        "workspace/executeCommand",
        {
          command: TSSERVER_REQUEST_COMMAND,
          arguments: ["reloadProjects", {}, { executionTarget: 0, expectsResult: true, isAsync: false, lowPriority: false }],
        },
        signal,
      ).catch(() => {});
    }),
  );
}

export interface WritethroughOptions {
  enableFormat?: boolean;
  enableDiagnostics?: boolean;
  transformDiagnostics?: (absPath: string, result: FileDiagnosticsResult) => FileDiagnosticsResult;
  /** lsp.requestTimeout 秒；抬高迟到诊断等待预算。 */
  requestTimeoutSec?: number;
}

export interface WritethroughResult {
  diagnostics?: FileDiagnosticsResult;
  finalContent: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 内联只短暂等待新鲜结果；新鲜度由写前 minVersions 基线强制：精确文档版本
 * 匹配立即返回，无版本/不匹配的发布必须在静默窗口内无更新发布才算数。
 * 内联窗口空转且有 deferred 通道时，在途 fetch 移交后台迟达；无通道（直连
 * 调用方）按标准预算阻塞等内联结果。
 */
async function fetchDiagnosticsWithDeferral(args: {
  dst: string;
  cwd: string;
  servers: ReadonlyArray<[string, ServerConfig]>;
  minVersions: ServerVersionMap | undefined;
  expectedDocumentVersions: ServerVersionMap | undefined;
  transformDiagnostics?: ResolvedWritethroughOptions["transformDiagnostics"];
  deferredWaitMs: number;
  deferred?: { onDeferredDiagnostics: (diagnostics: FileDiagnosticsResult) => void; signal: AbortSignal };
  signal?: AbortSignal;
}): Promise<FileDiagnosticsResult | undefined> {
  const { dst, cwd, servers, minVersions, expectedDocumentVersions, transformDiagnostics, deferredWaitMs, deferred, signal } = args;
  const apply = (d: FileDiagnosticsResult | undefined) => (d && transformDiagnostics ? transformDiagnostics(dst, d) : d);

  if (!deferred) {
    return apply(await getDiagnosticsForFile(dst, cwd, servers, { signal, minVersions, expectedDocumentVersions }));
  }

  const fetchPromise = getDiagnosticsForFile(dst, cwd, servers, {
    signal: deferred.signal,
    minVersions,
    expectedDocumentVersions,
    timeoutMs: deferredWaitMs,
  });
  const INLINE_TIMEOUT = Symbol("inline-diagnostics-timeout");
  const raced = await Promise.race([
    fetchPromise,
    sleep(INLINE_DIAGNOSTICS_WAIT_TIMEOUT_MS).then(() => INLINE_TIMEOUT),
  ]);
  if (raced !== INLINE_TIMEOUT) {
    return apply(raced as FileDiagnosticsResult | undefined);
  }
  // 慢服务器：经 deferred 通道迟达；deferred sink（编辑钩子）自己做去重，
  // 这里交原始结果。
  void fetchPromise
    .then((diagnostics) => {
      if (diagnostics && !deferred.signal.aborted) deferred.onDeferredDiagnostics(diagnostics);
    })
    .catch(() => {});
  return undefined;
}

/** 单文件 writethrough（omp 的批量 flush 未移植，见 spec §8）。 */
export async function runLspWritethrough(
  dst: string,
  content: string,
  cwd: string,
  options: WritethroughOptions,
  changeType: FileChangeType,
  signal?: AbortSignal,
  deferred?: { onDeferredDiagnostics: (diagnostics: FileDiagnosticsResult) => void; signal: AbortSignal },
): Promise<WritethroughResult> {
  const resolvedOptions: ResolvedWritethroughOptions = {
    enableFormat: options.enableFormat ?? false,
    enableDiagnostics: options.enableDiagnostics ?? false,
    transformDiagnostics: options.transformDiagnostics,
    deferredWaitMs: deferredDiagnosticsWaitMs(options.requestTimeoutSec),
  };
  const { enableFormat, enableDiagnostics } = resolvedOptions;
  let finalContent = content;
  const config = getConfig(cwd);
  const servers = getServersForFile(config, dst);
  if (servers.length === 0) {
    await notifyWorkspaceWatchedFiles(cwd, [{ filePath: dst, type: changeType }], signal).catch(() => {});
    return { finalContent, diagnostics: undefined };
  }

  const minVersions = enableDiagnostics
    ? await captureDiagnosticVersions(cwd, servers, 5000, signal).catch(() => undefined)
    : undefined;
  let expectedDocumentVersions: ServerVersionMap | undefined;
  let formatter: FileFormatResult | undefined;
  let diagnostics: FileDiagnosticsResult | undefined;
  let timedOut = false;
  let synced = false;

  // overlay 从第一次 sync 起领先磁盘直至提交；屏蔽该文件的磁盘 reconcile，
  // 防并发语义查询把服务器打回写前内容。
  beginPendingDiskWrite(dst);
  try {
    const timeoutSignal = AbortSignal.timeout(5000);
    timeoutSignal.addEventListener("abort", () => {
      timedOut = true;
    }, { once: true });
    const operationSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    throwIfAborted(operationSignal);

    // 1. 同步原始内容
    await syncFileContent(dst, content, cwd, servers, operationSignal);

    // 2. 内存格式化（format-on-write）：改动的正文落盘并再同步给服务器，
    // 保证后续诊断针对格式化后的文本。
    if (enableFormat) {
      const formatted = await formatContent(dst, content, cwd, servers, operationSignal);
      if (formatted.failed) formatter = FileFormatResult.FAILED;
      else if (formatted.unsupported) formatter = FileFormatResult.UNSUPPORTED;
      else if (formatted.content !== content) formatter = FileFormatResult.FORMATTED;
      else formatter = FileFormatResult.UNCHANGED;
      if (formatted.content !== content) {
        await fs.writeFile(dst, formatted.content, "utf8");
        await syncFileContent(dst, formatted.content, cwd, servers, operationSignal);
        finalContent = formatted.content;
      }
    }

    // 3. 落盘后通知 watched files（created 路径先 tsserver 工程重载）
    await notifyWorkspaceWatchedFiles(cwd, [{ filePath: dst, type: changeType }], operationSignal);
    if (changeType === FileChangeType.Created) {
      await reloadTypeScriptProjectsAfterCreate(cwd, servers, operationSignal);
    }

    if (enableDiagnostics) {
      expectedDocumentVersions = await captureOpenFileVersions(dst, cwd, servers, operationSignal);
    }

    // 4. didSave
    await notifyFileSaved(dst, cwd, servers, operationSignal);
    synced = true;
  } catch {
    if (!timedOut) {
      endPendingDiskWrite(dst);
      throw signal?.aborted ? signal.reason : new Error("LSP writethrough failed");
    }
    // 预算耗尽：写已落盘，后台兜一次诊断；本调用不阻塞返回。
    endPendingDiskWrite(dst);
    if (deferred && !deferred.signal.aborted && enableDiagnostics) {
      void scheduleDeferredDiagnosticsFetch(dst, cwd, servers, minVersions, expectedDocumentVersions, resolvedOptions.deferredWaitMs, deferred);
    }
    return { finalContent, diagnostics: undefined };
  }
  endPendingDiskWrite(dst);

  if (synced && enableDiagnostics) {
    diagnostics = await fetchDiagnosticsWithDeferral({
      dst,
      cwd,
      servers,
      minVersions,
      expectedDocumentVersions,
      transformDiagnostics: resolvedOptions.transformDiagnostics,
      deferredWaitMs: resolvedOptions.deferredWaitMs,
      deferred,
      signal,
    });
  }

  if (formatter !== undefined) {
    diagnostics ??= { server: servers.map(([name]) => name).join(", "), messages: [], summary: "OK", errored: false };
    diagnostics.formatter = formatter;
  }

  return { finalContent, diagnostics };
}

async function scheduleDeferredDiagnosticsFetch(
  dst: string,
  cwd: string,
  servers: ReadonlyArray<[string, ServerConfig]>,
  minVersions: ServerVersionMap | undefined,
  expectedDocumentVersions: ServerVersionMap | undefined,
  waitMs: number,
  deferred: { onDeferredDiagnostics: (diagnostics: FileDiagnosticsResult) => void; signal: AbortSignal },
): Promise<void> {
  try {
    const deferredTimeout = AbortSignal.timeout(Math.max(25000, waitMs + DIAGNOSTICS_PIPELINE_GRACE_MS));
    const combined = AbortSignal.any([deferred.signal, deferredTimeout]);
    const diagnostics = await getDiagnosticsForFile(dst, cwd, servers, {
      signal: combined,
      minVersions,
      expectedDocumentVersions,
      timeoutMs: waitMs,
    });
    if (deferred.signal.aborted || diagnostics === undefined) return;
    deferred.onDeferredDiagnostics(diagnostics);
  } catch {
    // 取消或 LSP 放弃：静默丢弃。
  }
}

/** 判定落盘路径的变更类型（存在=Changed，否则 Created）。 */
export async function detectChangeType(dst: string): Promise<FileChangeType> {
  try {
    await fs.stat(dst);
    return FileChangeType.Changed;
  } catch (error) {
    if (isEnoent(error)) return FileChangeType.Created;
    throw error;
  }
}
