// Ported from oh-my-pi (MIT) — packages/coding-agent/src/lsp/diagnostics.ts（聚合/格式化切片）, Copyright (c) 2025 Mario Zechner & Stencil Labs
// ============================================================
// 诊断聚合与 format-on-write：版本基线、按文件聚合、预算硬墙
// ============================================================

import { sendRequest, throwIfAborted } from "./client-io.js";
import { getOrCreateClient, waitForProjectLoaded } from "./client.js";
import { formatDiagnostic, formatDiagnosticsSummary, formatPathRelativeToCwd, limitDiagnosticMessages, sortDiagnostics } from "./format.js";
import { resolveFormatOptions } from "./format-options.js";
import { isProjectAwareLspServer } from "./servers.js";
import { applyTextEditsToString } from "./edits.js";
import { waitForDiagnostics } from "./diagnostics-wait.js";
import type { Diagnostic, FileDiagnosticsResult, ServerConfig, TextEdit } from "./types.js";
import { fileToUri } from "./uri.js";
import { logger } from "./logger.js";

export const SINGLE_DIAGNOSTICS_WAIT_TIMEOUT_MS = 3000;
export const BATCH_DIAGNOSTICS_WAIT_TIMEOUT_MS = 400;
/**
 * edit/write writethrough 内联等新诊断的时长上限；超过则把慢服务器交给
 * deferred 通道。常见快服务器保持内联，大 monorepo tsserver 慢发布时编辑
 * 也能及时返回。
 */
export const INLINE_DIAGNOSTICS_WAIT_TIMEOUT_MS = 500;
/** 后台/deferred 拉取的每服务器内层等待预算。 */
export const DEFERRED_DIAGNOSTICS_WAIT_TIMEOUT_MS = 12000;
/**
 * 每服务器整条管线（客户端初始化/工程加载/lint）在等待预算之上的硬墙钟。
 * 调用方 signal 通常是「仅用户取消」型（edit 工具正是如此：有 signal 时
 * sendRequest 不装默认超时），卡死的服务器会把编辑永久悬挂且后续编辑全部
 * 排队（omp #4910）。超预算服务器本轮跳过，编辑照常返回。
 */
export const DIAGNOSTICS_PIPELINE_GRACE_MS = 10000;

/** 迟到诊断的每服务器等待预算：至少 12s，抬到 lsp.requestTimeout 供冷启动。 */
export function deferredDiagnosticsWaitMs(requestTimeoutSec: number | undefined): number {
  return Math.max(DEFERRED_DIAGNOSTICS_WAIT_TIMEOUT_MS, (requestTimeoutSec ?? 0) * 1000);
}

export const WORKSPACE_SYMBOL_LIMIT = 200;
export const REFERENCE_CONTEXT_LIMIT = 50;
export const REFERENCES_RETRY_COUNT = 2;
export const REFERENCES_RETRY_DELAY_MS = 250;

/** 依赖工程索引的 action（对项目感知服务器需先等工程加载）。 */
export const PROJECT_INDEXED_ACTIONS: ReadonlySet<string> = new Set([
  "definition",
  "type_definition",
  "implementation",
  "references",
  "rename",
  "hover",
]);

export { waitForDiagnostics } from "./diagnostics-wait.js";
export { isOnlyQueriedDeclaration, normalizeLocationResult } from "./diagnostics-wait.js";

// -----------------------------------------------------------------------------
// 版本基线与按文件聚合
// -----------------------------------------------------------------------------

export type ServerVersionMap = Map<string, number>;

/** 同步前抓当前诊断版本基线，用于之后拒收陈旧结果。 */
export async function captureDiagnosticVersions(
  cwd: string,
  servers: ReadonlyArray<[string, ServerConfig]>,
  initTimeoutMs?: number,
  signal?: AbortSignal,
): Promise<ServerVersionMap> {
  const versions = new Map<string, number>();
  await Promise.allSettled(
    servers.map(async ([serverName, serverConfig]) => {
      const client = await getOrCreateClient(serverConfig, cwd, initTimeoutMs, signal);
      versions.set(serverName, client.diagnosticsVersion);
    }),
  );
  return versions;
}

export async function captureOpenFileVersions(
  absolutePath: string,
  cwd: string,
  servers: ReadonlyArray<[string, ServerConfig]>,
  signal?: AbortSignal,
): Promise<ServerVersionMap> {
  const uri = fileToUri(absolutePath);
  const versions = new Map<string, number>();
  await Promise.allSettled(
    servers.map(async ([serverName, serverConfig]) => {
      const client = await getOrCreateClient(serverConfig, cwd, undefined, signal);
      const version = client.openFiles.get(uri)?.version;
      if (version !== undefined) versions.set(serverName, version);
    }),
  );
  return versions;
}

interface GetDiagnosticsForFileOptions {
  signal?: AbortSignal;
  minVersions?: ServerVersionMap;
  expectedDocumentVersions?: ServerVersionMap;
  timeoutMs?: number;
  pipelineBudgetMs?: number;
}

/** 工作与预算信号竞速：预算触发即整体拒绝（omp untilAborted 语义）。 */
function untilAborted<T>(signal: AbortSignal, work: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(signal.reason instanceof Error ? signal.reason : new Error(`aborted: ${signal.reason}`));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/**
 * 按文件取诊断（聚合全部适用服务器）。每服务器整条管线套硬墙钟：
 * 超预算者被拒绝、落入 allSettled 的 rejected、本轮跳过——编辑仍会返回。
 */
export async function getDiagnosticsForFile(
  absolutePath: string,
  cwd: string,
  servers: ReadonlyArray<[string, ServerConfig]>,
  options: GetDiagnosticsForFileOptions = {},
): Promise<FileDiagnosticsResult | undefined> {
  const { signal, minVersions, expectedDocumentVersions, timeoutMs } = options;
  if (servers.length === 0) return undefined;
  const waitBudgetMs = timeoutMs ?? SINGLE_DIAGNOSTICS_WAIT_TIMEOUT_MS;
  const pipelineBudgetMs = options.pipelineBudgetMs ?? waitBudgetMs + DIAGNOSTICS_PIPELINE_GRACE_MS;

  const uri = fileToUri(absolutePath);
  const relPath = formatPathRelativeToCwd(absolutePath, cwd);
  const allDiagnostics: Diagnostic[] = [];
  const serverNames: string[] = [];

  const results = await Promise.allSettled(
    servers.map(([serverName, serverConfig]) => {
      const budgetSignal = AbortSignal.timeout(pipelineBudgetMs);
      const boundSignal = signal ? AbortSignal.any([signal, budgetSignal]) : budgetSignal;
      const work = (async () => {
        throwIfAborted(boundSignal);
        const client = await getOrCreateClient(serverConfig, cwd, undefined, boundSignal);
        throwIfAborted(boundSignal);
        if (isProjectAwareLspServer(serverConfig)) {
          await waitForProjectLoaded(client, boundSignal);
          throwIfAborted(boundSignal);
        }
        return {
          serverName,
          diagnostics: await waitForDiagnostics(client, uri, {
            timeoutMs: waitBudgetMs,
            signal: boundSignal,
            minVersion: minVersions?.get(serverName),
            expectedDocumentVersion: expectedDocumentVersions?.get(serverName),
          }),
        };
      })();
      return untilAborted(boundSignal, work);
    }),
  );

  for (const result of results) {
    if (result.status === "fulfilled") {
      serverNames.push(result.value.serverName);
      allDiagnostics.push(...result.value.diagnostics);
    } else if (signal?.aborted) {
      throw signal.reason;
    }
  }
  void logger;

  if (serverNames.length === 0) return undefined;

  if (allDiagnostics.length === 0) {
    return { server: serverNames.join(", "), messages: [], summary: "OK", errored: false };
  }

  // 按 range+message 去重（不同服务器常报同类问题）。
  const seen = new Set<string>();
  const uniqueDiagnostics: Diagnostic[] = [];
  for (const d of allDiagnostics) {
    const key = `${d.range.start.line}:${d.range.start.character}:${d.range.end.line}:${d.range.end.character}:${d.message}`;
    if (!seen.has(key)) {
      seen.add(key);
      uniqueDiagnostics.push(d);
    }
  }

  sortDiagnostics(uniqueDiagnostics);
  const formatted = uniqueDiagnostics.map((d) => formatDiagnostic(d, relPath));
  const limited = limitDiagnosticMessages(formatted);
  return {
    server: serverNames.join(", "),
    messages: limited,
    summary: formatDiagnosticsSummary(uniqueDiagnostics),
    errored: uniqueDiagnostics.some((d) => d.severity === 1),
  };
}

// -----------------------------------------------------------------------------
// format-on-write
// -----------------------------------------------------------------------------

export type FormatContentResult = {
  content: string;
  failed: boolean;
  unsupported: boolean;
};

/**
 * 用 LSP 格式化内容。优先 isLinter 服务器（专用格式化器），否则类型检查器
 * ——tsserver 也声明 formatting 但只会重排缩进；无此偏好配置的外部格式化器
 * 永远抢不到（omp 同规则）。排序稳定，同类内保持原序。
 */
export async function formatContent(
  absolutePath: string,
  content: string,
  cwd: string,
  servers: ReadonlyArray<[string, ServerConfig]>,
  signal?: AbortSignal,
): Promise<FormatContentResult> {
  if (servers.length === 0) return { content, failed: false, unsupported: true };

  const uri = fileToUri(absolutePath);
  let hadFailure = false;

  const ordered =
    servers.length > 1 ? [...servers].sort((a, b) => (a[1].isLinter ? 0 : 1) - (b[1].isLinter ? 0 : 1)) : servers;

  for (const [, serverConfig] of ordered) {
    try {
      throwIfAborted(signal);
      const client = await getOrCreateClient(serverConfig, cwd, undefined, signal);
      throwIfAborted(signal);

      if (!client.serverCapabilities?.documentFormattingProvider) {
        // 服务器在但不支持格式化——不算失败，继续试下一个。
        continue;
      }

      const edits = (await sendRequest(
        client,
        "textDocument/formatting",
        { textDocument: { uri }, options: resolveFormatOptions(absolutePath, content) },
        signal,
      )) as TextEdit[] | null;

      if (!edits || edits.length === 0) {
        return { content, failed: false, unsupported: false };
      }
      return { content: applyTextEditsToString(content, edits), failed: false, unsupported: false };
    } catch {
      // 有格式化能力但请求失败：记录失败并试下一个服务器。
      hadFailure = true;
    }
  }

  // 任一适用服务器失败 > 全部不支持。
  return { content, failed: hadFailure, unsupported: !hadFailure };
}
