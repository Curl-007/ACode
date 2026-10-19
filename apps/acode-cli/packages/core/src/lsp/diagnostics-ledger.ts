// Ported from oh-my-pi (MIT) — packages/coding-agent/src/lsp/diagnostics-ledger.ts, Copyright (c) 2025 Mario Zechner & Stencil Labs
// ============================================================
// 诊断 ledger：按「去位置的诊断身份」记录每文件已见集合，只把新增诊断
// 附进工具结果，消除每轮重复错误刷上下文。
// ============================================================

import type { FileDiagnosticsResult } from "./types.js";
import { summarizeDiagnosticMessages } from "./format.js";

const DIAGNOSTIC_LOCATION_PREFIX_RE = /^.*?:\d+:\d+\s+/;

/** 诊断身份：剥掉 `path:line:col ` 位置前缀后的消息文本。 */
export function diagnosticIdentity(message: string): string {
  return message.replace(DIAGNOSTIC_LOCATION_PREFIX_RE, "");
}

export class DiagnosticsLedger {
  readonly #seen = new Map<string, Set<string>>();

  /** 返回只含新增诊断的结果；身份集合为空时删除该文件条目。 */
  reduce(absPath: string, result: FileDiagnosticsResult): FileDiagnosticsResult {
    const previous = this.#seen.get(absPath);
    const currentIdentities = new Set<string>();
    const fresh: string[] = [];

    for (const message of result.messages) {
      const identity = diagnosticIdentity(message);
      currentIdentities.add(identity);
      if (!previous?.has(identity)) {
        fresh.push(message);
      }
    }

    if (currentIdentities.size === 0) {
      this.#seen.delete(absPath);
    } else {
      this.#seen.set(absPath, currentIdentities);
    }

    if (fresh.length === result.messages.length) {
      return result;
    }

    return {
      ...result,
      messages: fresh,
      ...summarizeDiagnosticMessages(fresh),
    };
  }

  /** 测试/排障接缝：某文件当前已见身份集合快照。 */
  seenIdentitiesFor(absPath: string): ReadonlySet<string> {
    return this.#seen.get(absPath) ?? new Set();
  }
}
