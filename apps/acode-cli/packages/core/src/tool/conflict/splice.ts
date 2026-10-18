// ============================================================
// 冲突块拼接（specs/conflict-uri-resolution.md R5）
// ============================================================
// Mechanism ported from oh-my-pi (MIT) packages/coding-agent/src/tools/
// conflict-detect.ts 的 spliceConflict 语义, Copyright (c) 2025 Mario
// Zechner & Stencil Labs.
// 纪律：写前磁盘重验证（out-of-band 编辑 fail-loud 拒绝盲拼）、同文件多块
// 自底向上（保上方锚有效）、文件内 all-or-nothing（任一块失败零写入）。

import type { ConflictBlock } from "./detect.js";
import type { ConflictEntry } from "./history.js";

export type ConflictSideToken = "@ours" | "@theirs" | "@base" | "@both";

export const CONFLICT_SIDE_TOKENS: readonly ConflictSideToken[] = [
  "@ours",
  "@theirs",
  "@base",
  "@both",
];

export function isConflictSideToken(value: string): value is ConflictSideToken {
  return (CONFLICT_SIDE_TOKENS as readonly string[]).includes(value);
}

/** token → 替换行（LF 归一形态）。@base 无 base 段时返回错误信息而非抛异常。 */
export function expandConflictToken(
  token: ConflictSideToken,
  block: ConflictBlock,
): { lines: string[] } | { error: string } {
  switch (token) {
    case "@ours":
      return { lines: block.oursLines };
    case "@theirs":
      return { lines: block.theirsLines };
    case "@base":
      if (!block.hasBase || block.baseLines === undefined) {
        return {
          error:
            "This conflict block has no base section (||||||| marker absent; merge was not diff3-style). Use @ours, @theirs, @both, or write the merged content directly.",
        };
      }
      return { lines: block.baseLines };
    case "@both":
      return { lines: [...block.oursLines, ...block.theirsLines] };
  }
}

/**
 * 注册区域与磁盘当前内容的逐字节重验证（R5 stale 防线）：
 * 行号窗口内的块行必须与注册时 LF 归一形态完全一致；不一致 = 文件被外部
 * 编辑过，锚已陈旧，拒绝拼接。
 */
export function revalidateRegion(
  fileLinesLf: readonly string[],
  entry: ConflictEntry,
): { ok: true } | { ok: false; reason: string } {
  const { startLine, endLine } = entry.block;
  if (startLine < 1 || endLine > fileLinesLf.length || endLine < startLine) {
    return {
      ok: false,
      reason: `conflict://${entry.id} region (lines ${startLine}-${endLine}) is out of range (file now has ${fileLinesLf.length} lines)`,
    };
  }
  const window = fileLinesLf.slice(startLine - 1, endLine);
  const expected = entry.block.lines;
  if (window.length !== expected.length) {
    return { ok: false, reason: `conflict://${entry.id} region size changed on disk` };
  }
  for (let index = 0; index < expected.length; index += 1) {
    if (window[index] !== expected[index]) {
      return {
        ok: false,
        reason: `conflict://${entry.id} region content changed on disk (line ${startLine + index})`,
      };
    }
  }
  return { ok: true };
}

export interface SpliceOutcome {
  /** 拼接后的完整文件文本（保持原 EOL 形态与末尾换行语义）。 */
  text: string;
  /** 实际替换的块 id（自底向上序）。 */
  splicedIds: number[];
}

/**
 * 对单个文件执行多块拼接（all-or-nothing）：任一块重验证失败 → 返回错误、
 * 零写入。replacements: id → 替换行（LF 归一）。originalText 为磁盘当前全文
 * 的 **LF 归一形态**（FileSystemPort.readTextFile 返回值即此形态）；EOL 恢复
 * 是 port writeTextFile(lineEndings) 的职责，本层不重复换算（双重换算会产
 * 生 \r\r\n）。末尾换行语义按 LF 保留。
 */
export function spliceConflicts(
  originalText: string,
  entries: readonly ConflictEntry[],
  replacements: ReadonlyMap<number, readonly string[]>,
): SpliceOutcome | { error: string } {
  const fileLinesLf = splitLinesLf(originalText);
  // 收集本文件涉及的条目并按起始行**降序**（自底向上，保上方锚行号有效）。
  const targeted = entries
    .filter((entry) => replacements.has(entry.id))
    .sort((left, right) => right.block.startLine - left.block.startLine);
  if (targeted.length === 0) {
    return { error: "no target conflict ids belong to this file" };
  }
  // 重叠区域防御（同文件注册面理论上不重叠，防御陈旧状态）：降序遍历时
  // 下一块的 endLine 必须严格小于上一块的 startLine。
  const lines = [...fileLinesLf];
  const splicedIds: number[] = [];
  let previousStart = Number.POSITIVE_INFINITY;
  for (const entry of targeted) {
    const validation = revalidateRegion(fileLinesLf, entry);
    if (!validation.ok) {
      // all-or-nothing：返回错误时未做任何写入（lines 是本地副本）。
      return { error: `${validation.reason}; file left untouched — re-read the file to refresh conflict ids` };
    }
    const { startLine, endLine } = entry.block;
    if (endLine >= previousStart) {
      return {
        error: `conflict://${entry.id} region overlaps another targeted block; file left untouched`,
      };
    }
    previousStart = startLine;
    const replacement = replacements.get(entry.id)!;
    lines.splice(startLine - 1, endLine - startLine + 1, ...replacement);
    splicedIds.push(entry.id);
  }
  const eol = "\n";
  let text = lines.join(eol);
  // 保留原文件的末尾换行语义：原文以换行结尾则结果同样以换行结尾。
  const originalEndsWithEol = originalText.endsWith("\n");
  if (originalEndsWithEol && !text.endsWith(eol)) {
    text += eol;
  }
  return { text, splicedIds };
}

/** 按行拆分并 LF 归一（剥尾部 \r），保留空行结构。 */
export function splitLinesLf(text: string): string[] {
  return text.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}
