// Ported from oh-my-pi (MIT) — packages/coding-agent/src/lsp/deferred-diagnostics.ts, Copyright (c) 2025 Mario Zechner & Stencil Labs
// ============================================================
// 迟到诊断：工具结果已返回后才到达的诊断，经 ledger 去重后进入注入队列，
// 以 system-reminder 形态进入后续轮次（本波落点：下一次 Edit/Write 模型内容
// 尾随块；运行时轮次级 drain 为共享桶申请，见 spec §6）。
// ============================================================

import { DiagnosticsLedger, diagnosticIdentity } from "./diagnostics-ledger.js";
import type { DeferredDiagnosticsEntry, FileDiagnosticsResult } from "./types.js";
import { summarizeDiagnosticMessages } from "./format.js";

/** writethrough 的迟到诊断句柄（omp WritethroughDeferredHandle 同形）。 */
export type WritethroughDeferredHandle = {
  onDeferredDiagnostics: (diagnostics: FileDiagnosticsResult) => void;
  signal: AbortSignal;
  finalize: (diagnostics: FileDiagnosticsResult | undefined) => void;
};

/** 同文件变更版本单调计数（stale 判定的唯一依据）。 */
export class FileMutationVersions {
  readonly #versions = new Map<string, number>();

  bump(path: string): number {
    const next = (this.#versions.get(path) ?? 0) + 1;
    this.#versions.set(path, next);
    return next;
  }

  current(path: string): number {
    return this.#versions.get(path) ?? 0;
  }
}

/**
 * 为一次变更工具调用协调迟到诊断：begin 发放句柄 → writethrough 内联等待
 * 超时转后台 → onDeferredDiagnostics 送达 → 队列承载、由下一次注入消费。
 */
export class DeferredDiagnostics {
  readonly #pendingFetches = new Map<string, AbortController>();
  readonly #ledger: DiagnosticsLedger;
  readonly #versions: FileMutationVersions;
  readonly #queue: DeferredDiagnosticsQueue;

  constructor(options: { ledger: DiagnosticsLedger; versions: FileMutationVersions; queue: DeferredDiagnosticsQueue }) {
    this.#ledger = options.ledger;
    this.#versions = options.versions;
    this.#queue = options.queue;
  }

  /** 开始一次文件变更；返回 writethrough 消费的句柄。 */
  begin(path: string): WritethroughDeferredHandle {
    const existing = this.#pendingFetches.get(path);
    if (existing) {
      existing.abort();
      this.#pendingFetches.delete(path);
    }

    const controller = new AbortController();
    const mutationVersion = this.#versions.bump(path);
    return {
      onDeferredDiagnostics: (diagnostics) => {
        this.#pendingFetches.delete(path);
        this.#inject(path, diagnostics, mutationVersion);
      },
      signal: controller.signal,
      finalize: (diagnostics) => {
        if (!diagnostics) {
          // 内联没等到结果：挂起句柄，后台 fetch 送达时注入。
          this.#pendingFetches.set(path, controller);
        } else {
          controller.abort();
        }
      },
    };
  }

  #inject(path: string, diagnostics: FileDiagnosticsResult, mutationVersion: number): void {
    const effective = this.#ledger.reduce(path, diagnostics);
    if (effective.messages.length === 0) return;

    const { summary, errored } = summarizeDiagnosticMessages(effective.messages);
    const entry: DeferredDiagnosticsEntry = {
      path,
      summary: effective.summary || summary,
      messages: effective.messages,
      errored: effective.errored || errored,
      isStale: () => this.#versions.current(path) !== mutationVersion,
    };
    this.#queue.enqueue(entry);
  }
}

/**
 * 迟到诊断注入队列（FIFO）。默认内存实现；运行时轮次级 drain 接线后由
 * runtime 在每轮开始消费并投影为 mid-conversation system reminder。
 */
export class DeferredDiagnosticsQueue {
  readonly #entries: DeferredDiagnosticsEntry[] = [];

  enqueue(entry: DeferredDiagnosticsEntry): void {
    this.#entries.push(entry);
  }

  /** 注入时求值 isStale：同文件被更新变更超越的条目丢弃，其余按序弹出。 */
  drain(): DeferredDiagnosticsEntry[] {
    const fresh: DeferredDiagnosticsEntry[] = [];
    while (this.#entries.length > 0) {
      const entry = this.#entries.shift()!;
      if (!entry.isStale()) fresh.push(entry);
    }
    return fresh;
  }

  get size(): number {
    return this.#entries.length;
  }

  clear(): void {
    this.#entries.length = 0;
  }
}

/** 组装 reminder 正文（omp `<system-notice>` 形态在 ACode 走 system-reminder）。 */
export function formatDeferredDiagnosticsReminder(entries: readonly DeferredDiagnosticsEntry[]): string {
  const lines: string[] = ["Deferred diagnostics arrived after the previous tool result returned:"];
  for (const entry of entries) {
    lines.push(`${entry.path}: ${entry.summary}`);
    for (const message of entry.messages) lines.push(`  ${message}`);
  }
  return lines.join("\n");
}

/** 供编辑回环钩子使用的会话级单例（每 workspace 一份）。 */
const owners = new Map<string, { ledger: DiagnosticsLedger; versions: FileMutationVersions; queue: DeferredDiagnosticsQueue; deferred: DeferredDiagnostics }>();

export function getDeferredDiagnosticsOwner(workspaceKey: string): {
  ledger: DiagnosticsLedger;
  versions: FileMutationVersions;
  queue: DeferredDiagnosticsQueue;
  deferred: DeferredDiagnostics;
} {
  let owner = owners.get(workspaceKey);
  if (!owner) {
    const ledger = new DiagnosticsLedger();
    const versions = new FileMutationVersions();
    const queue = new DeferredDiagnosticsQueue();
    owner = { ledger, versions, queue, deferred: new DeferredDiagnostics({ ledger, versions, queue }) };
    owners.set(workspaceKey, owner);
  }
  return owner;
}

/** 测试接缝：清空全部 owner 状态。 */
export function resetDeferredDiagnosticsOwners(): void {
  owners.clear();
}

export { diagnosticIdentity };
