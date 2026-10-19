// Ported from oh-my-pi (MIT) — packages/coding-agent/src/lsp/diagnostics.ts（等待切片）, Copyright (c) 2025 Mario Zechner & Stencil Labs
// ============================================================
// 等待新鲜诊断：版本守门、静默窗口、拉取式（pull）兜底
// ============================================================

import { sendRequest, throwIfAborted } from "./client-io.js";
import { supportsDocumentDiagnostics } from "./client-reader.js";
import { DEFERRED_DIAGNOSTICS_WAIT_TIMEOUT_MS } from "./diagnostics.js";
import type { Diagnostic, LspClient, Position, PublishedDiagnostics } from "./types.js";
import { logger } from "./logger.js";

const DIAGNOSTICS_POLL_MS = 100;
const DIAGNOSTICS_SETTLE_MS = 250;

export interface WaitForDiagnosticsOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  minVersion?: number;
  expectedDocumentVersion?: number;
  /**
   * 静默窗口毫秒。typescript-language-server 不回显文档版本且多源分批发布，
   * 没有「完整且版本匹配」的单一发布可守门：不做精确版本匹配时，只在
   * 此窗口内没有更新发布后才接受最新发布，让在途的写前发布被覆盖。
   */
  settleMs?: number;
}

interface PullDiagnosticsOutcome {
  diagnostics?: Diagnostic[];
  failed?: unknown;
}

function comparePosition(a: Position, b: Position): number {
  return a.line === b.line ? a.character - b.character : a.line - b.line;
}

function rangeContainsPosition(range: { start: Position; end: Position }, position: Position): boolean {
  return comparePosition(range.start, position) <= 0 && comparePosition(position, range.end) <= 0;
}

export function isOnlyQueriedDeclaration(
  locations: Array<{ uri: string; range: { start: Position; end: Position } }>,
  uri: string,
  position: Position,
): boolean {
  return locations.length === 1 && locations[0]?.uri === uri && rangeContainsPosition(locations[0].range, position);
}

/** Location | LocationLink（含数组与 null）→ 统一 Location[]。 */
export function normalizeLocationResult(
  result:
    | { uri: string; range: { start: Position; end: Position } }
    | { targetUri: string; targetRange: { start: Position; end: Position }; targetSelectionRange?: { start: Position; end: Position } }
    | Array<unknown>
    | null,
): Array<{ uri: string; range: { start: Position; end: Position } }> {
  if (!result) return [];
  const raw = Array.isArray(result) ? result : [result];
  const out: Array<{ uri: string; range: { start: Position; end: Position } }> = [];
  for (const loc of raw) {
    if (loc && typeof loc === "object" && "uri" in loc) {
      out.push(loc as { uri: string; range: { start: Position; end: Position } });
    } else if (loc && typeof loc === "object" && "targetUri" in loc) {
      const link = loc as {
        targetUri: string;
        targetRange: { start: Position; end: Position };
        targetSelectionRange?: { start: Position; end: Position };
      };
      out.push({ uri: link.targetUri, range: link.targetSelectionRange ?? link.targetRange });
    }
  }
  return out;
}

function requestDocumentDiagnostics(
  client: LspClient,
  uri: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<PullDiagnosticsOutcome> {
  return sendRequest(client, "textDocument/diagnostic", { textDocument: { uri } }, signal, timeoutMs).then(
    (report) => {
      if (!report || typeof report !== "object" || !("kind" in report) || (report as { kind?: unknown }).kind !== "full") {
        return {};
      }
      const items = (report as { items?: unknown }).items;
      if (!Array.isArray(items)) return {};
      return { diagnostics: items as Diagnostic[] };
    },
    (err: unknown) => {
      if (!signal?.aborted) {
        logger.debug("LSP document diagnostic pull failed", { server: client.name, uri, error: logger.formatError(err) });
      }
      return { failed: err };
    },
  );
}

/** 新启服务器的空无版本发布多半是分析前占位，继续等让 writethrough 走 deferred。 */
function isProvisionalColdPublish(
  client: LspClient,
  published: PublishedDiagnostics,
  expectedDocumentVersion: number | undefined,
  now: number,
): boolean {
  return (
    expectedDocumentVersion !== undefined &&
    published.version === null &&
    published.diagnostics.length === 0 &&
    now - client.startedAt < DEFERRED_DIAGNOSTICS_WAIT_TIMEOUT_MS
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 等待 uri 的新鲜诊断：publish 缓存按 minVersion（写前基线）守门；
 * 服务器支持 3.17 拉取式诊断时并发发 textDocument/diagnostic 兜底。
 * 预算耗尽：拉取成功用拉取结果；拉取失败上抛（状态未知绝不渲染成 "OK"）；
 * 无拉取结果但有已静默的发布则接受之。
 */
export async function waitForDiagnostics(
  client: LspClient,
  uri: string,
  options: WaitForDiagnosticsOptions = {},
): Promise<Diagnostic[]> {
  const { timeoutMs = 3000, signal, minVersion, expectedDocumentVersion, settleMs = DIAGNOSTICS_SETTLE_MS } = options;
  const deadline = Date.now() + timeoutMs;
  let pullAttempted = false;
  let pullResultPromise: Promise<PullDiagnosticsOutcome> | undefined;
  let pulled: Diagnostic[] | undefined;
  let pullFailure: unknown;
  let settledRef: PublishedDiagnostics | undefined;
  let settledAt = 0;

  const acceptCheck = (): Diagnostic[] | undefined => {
    const versionOk = minVersion === undefined || client.diagnosticsVersion > minVersion;
    const published = client.diagnostics.get(uri);
    if (!published || !versionOk) return undefined;
    // 服务器精确回显文档版本 → 权威，立即接受。
    if (expectedDocumentVersion !== undefined && published.version === expectedDocumentVersion) {
      return published.diagnostics;
    }
    const now = Date.now();
    if (published !== settledRef) {
      settledRef = published;
      settledAt = now;
      return undefined;
    }
    if (now - settledAt >= settleMs && !isProvisionalColdPublish(client, published, expectedDocumentVersion, now)) {
      return published.diagnostics;
    }
    return undefined;
  };

  while (Date.now() < deadline) {
    throwIfAborted(signal);
    if (!pullAttempted && supportsDocumentDiagnostics(client)) {
      pullAttempted = true;
      pullResultPromise = requestDocumentDiagnostics(client, uri, signal, Math.max(1, deadline - Date.now()));
    }
    const accepted = acceptCheck();
    if (accepted) return accepted;

    const pollMs = Math.min(DIAGNOSTICS_POLL_MS, Math.max(0, deadline - Date.now()));
    if (!pullResultPromise) {
      await sleep(pollMs);
      continue;
    }
    const pullResult = await Promise.race([pullResultPromise, sleep(pollMs).then(() => undefined)]);
    if (pullResult) {
      pullResultPromise = undefined;
      if (pullResult.diagnostics !== undefined) {
        pulled = pullResult.diagnostics;
        break;
      }
      if (pullResult.failed !== undefined) {
        // 拉取失败 = 状态未知，但双模服务器仍可能在剩余预算内发布新诊断。
        pullFailure = pullResult.failed;
      }
    }
  }

  const accepted = acceptCheck();
  if (accepted) return accepted;
  if (pullResultPromise) {
    const outcome = await pullResultPromise;
    if (outcome.diagnostics !== undefined) pulled = outcome.diagnostics;
    else if (outcome.failed !== undefined) pullFailure = outcome.failed;
  }
  throwIfAborted(signal);
  if (pulled === undefined) {
    // 拉取失败（超时/RPC 错误）= 文件状态未知；绝不折叠成调用方渲染为 "OK"
    // 的干净空结果。
    if (pullFailure !== undefined) {
      throw pullFailure instanceof Error ? pullFailure : new Error(String(pullFailure));
    }
    return [];
  }
  client.diagnostics.set(uri, {
    diagnostics: pulled,
    version: expectedDocumentVersion ?? client.openFiles.get(uri)?.version ?? null,
  });
  client.diagnosticsVersion += 1;
  return pulled;
}
