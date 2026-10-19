// ============================================================
// conflict:// URI 解析与批量指派（specs/conflict-uri-resolution.md R4/R5）
// ============================================================
// Mechanism ported from oh-my-pi (MIT) packages/coding-agent/src/tools/
// conflict-uri.ts + internal-urls/conflict-protocol.ts, Copyright (c) 2025
// Mario Zechner & Stencil Labs.

import { isConflictSideToken, type ConflictSideToken } from "./splice.js";

const CONFLICT_SCHEME_PATTERN = /^conflict:\/\//i;

export function isConflictUri(path: string): boolean {
  return CONFLICT_SCHEME_PATTERN.test(path.trim());
}

export type ConflictUri =
  | { kind: "single"; id: number; side?: "ours" | "theirs" | "base" }
  | { kind: "bulk" };

export function parseConflictUri(raw: string): ConflictUri | { error: string } {
  const trimmed = raw.trim();
  if (!CONFLICT_SCHEME_PATTERN.test(trimmed)) {
    return { error: `Not a conflict:// URI: ${raw}` };
  }
  const rest = trimmed.slice(trimmed.indexOf("//") + 2);
  if (rest === "*") return { kind: "bulk" };
  // conflict://<id>[/<ours|theirs|base>]
  const slash = rest.indexOf("/");
  const idPart = slash >= 0 ? rest.slice(0, slash) : rest;
  const sidePart = slash >= 0 ? rest.slice(slash + 1) : undefined;
  if (!/^\d+$/.test(idPart)) {
    return {
      error: `Malformed conflict URI "${raw}": expected conflict://<id>, conflict://<id>/<ours|theirs|base>, or conflict://*`,
    };
  }
  const id = Number.parseInt(idPart, 10);
  if (id <= 0) {
    return { error: `Malformed conflict id in "${raw}": ids start at 1` };
  }
  if (sidePart !== undefined) {
    if (sidePart !== "ours" && sidePart !== "theirs" && sidePart !== "base") {
      return {
        error: `Unknown conflict side "${sidePart}" in "${raw}": expected ours, theirs, or base`,
      };
    }
    return { kind: "single", id, side: sidePart };
  }
  return { kind: "single", id };
}

export interface BulkDirective {
  id: number;
  token: ConflictSideToken;
}

/**
 * conflict://* 批量指派解析（omp BULK_DIRECTIVE_RE 语义）：
 * 每个非空行必须是 `<id>: @token`（`#` 行前缀容错，`:`/`=` 皆可）；
 * 出现任何非指派行 → fail-loud 拒绝混合形态（防「共享内容被当指派」歧义，
 * 错误信息给正确示例）。
 */
export function parseBulkDirectives(content: string): BulkDirective[] | { error: string } {
  const directives: BulkDirective[] = [];
  const lines = content.split("\n");
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const match = /^#?(\d+)\s*[:=]\s*(@ours|@theirs|@base|@both)$/.exec(line);
    if (!match) {
      return {
        error:
          `Bulk conflict://* content must be pure per-id directives, one per line: ` +
          `"<id>: @ours" (or @theirs/@base/@both). Offending line: ${JSON.stringify(line)}. ` +
          `To resolve a single block with custom merged content, write conflict://<id> directly.`,
      };
    }
    const token = match[2] as ConflictSideToken;
    if (!isConflictSideToken(token)) {
      return { error: `Unknown side token "${token}" in bulk directive line: ${line}` };
    }
    directives.push({ id: Number.parseInt(match[1]!, 10), token });
  }
  if (directives.length === 0) {
    return {
      error: 'Bulk conflict://* requires at least one directive line ("<id>: @ours|@theirs|@base|@both").',
    };
  }
  const seen = new Set<number>();
  for (const directive of directives) {
    if (seen.has(directive.id)) {
      return { error: `Duplicate id ${directive.id} in bulk directives — one side per id` };
    }
    seen.add(directive.id);
  }
  return directives;
}

export interface ConflictFooterEntry {
  id: number;
  path: string;
  startLine: number;
  hasBase: boolean;
}

/** read 尾注上限（R3）：块数超限截断清单只给总数，防巨型冲突文件刷屏。 */
const FOOTER_MAX_ENTRIES = 50;

/**
 * read 输出尾注（仅存在冲突时调用方追加）：紧凑清单 + 用法一行。
 * path 用调用方已 relativize 的展示形态（与 read 输出同口径）。
 */
export function buildConflictFooter(entries: readonly ConflictFooterEntry[]): string {
  if (entries.length === 0) return "";
  const shown = entries.slice(0, FOOTER_MAX_ENTRIES);
  const lines = shown.map((entry) => {
    const sides = entry.hasBase ? "ours/base/theirs" : "ours/theirs";
    return `conflict://${entry.id} ${entry.path}:${entry.startLine} (sides: ${sides})`;
  });
  if (entries.length > shown.length) {
    lines.push(`... and ${entries.length - shown.length} more conflict block(s)`);
  }
  lines.push(
    `⚠ ${entries.length} merge conflict block(s) registered. Resolve with Write: ` +
      `file_path "conflict://<id>", content "@ours" | "@theirs" | "@base" | "@both" ` +
      `(or the merged text). Bulk: file_path "conflict://*", content = one "<id>: @token" directive per line. ` +
      `Read "conflict://<id>[/<ours|theirs|base>]" to inspect a block or one side.`,
  );
  return lines.join("\n");
}
