// ============================================================
// 合并冲突块检测（specs/conflict-uri-resolution.md R1）
// ============================================================
// Mechanism ported from oh-my-pi (MIT) packages/coding-agent/src/tools/
// conflict-detect.ts, Copyright (c) 2025 Mario Zechner & Stencil Labs.
// 标记形态从严：仅列 0 起始、精确前缀长度后接行尾或「单空格+标签」的行才是
// marker——普通以 < / = 开头的代码行（JSX、装饰线、缩进 marker）永不误判。

import { createHash } from "node:crypto";

const OURS_PREFIX = "<<<<<<<";
const BASE_PREFIX = "|||||||";
const SEPARATOR = "=======";
const THEIRS_PREFIX = ">>>>>>>";

/** 单块行数上限：超出视为伪块丢弃（防装饰线海构造病态内存）。 */
const MAX_BLOCK_LINES = 10_000;

export interface ConflictBlock {
  /** 1-based，`<<<<<<<` 行号（相对整文件；窗口读取时由 firstLineNumber 折算）。 */
  startLine: number;
  /** 1-based，`>>>>>>>` 行号。 */
  endLine: number;
  oursLabel?: string;
  baseLabel?: string;
  theirsLabel?: string;
  hasBase: boolean;
  /** 整块行（含 marker），LF 归一（拼接回写时按文件原 EOL 恢复）。 */
  lines: string[];
  oursLines: string[];
  baseLines?: string[];
  theirsLines: string[];
}

/** 块身份指纹：文件绝对路径 + 内容哈希（行号不参与——同块位移后仍应复用 id）。 */
export function conflictBlockFingerprint(absolutePath: string, block: ConflictBlock): string {
  const hash = createHash("sha1").update(block.lines.join("\n")).digest("hex").slice(0, 16);
  return `${absolutePath}#${hash}`;
}

function stripTrailingCr(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

/** 精确 marker 匹配：前缀后必须是行尾或单空格+标签；返回标签（可空串）或 null。 */
function matchMarker(line: string, prefix: string): string | null {
  if (!line.startsWith(prefix)) return null;
  const rest = line.slice(prefix.length);
  if (rest.length === 0) return "";
  if (rest.startsWith(" ")) return rest.slice(1);
  return null;
}

interface PartialBlock {
  startLine: number;
  oursLabel?: string;
  oursLines: string[];
  baseLabel?: string;
  baseLines?: string[];
  theirsLabel?: string;
  theirsLines: string[];
  hasBase: boolean;
  collected: string[];
}

/**
 * 扫描已收集的行找**完整闭合**冲突块（opener+separator+closer 齐备）。
 * firstLineNumber = lines[0] 的 1-based 行号（窗口读取传窗口起点）。
 * closer 超出窗口的块丢弃——模型看到开标记后可加宽读取（R1）。
 */
export function scanConflictLines(
  lines: readonly string[],
  firstLineNumber: number,
): ConflictBlock[] {
  const blocks: ConflictBlock[] = [];
  let phase: "idle" | "ours" | "base" | "theirs" = "idle";
  let partial: PartialBlock | null = null;

  const reset = (): void => {
    phase = "idle";
    partial = null;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = stripTrailingCr(lines[index]!);
    const lineNumber = firstLineNumber + index;

    const oursLabel = matchMarker(line, OURS_PREFIX);
    if (oursLabel !== null) {
      // 新 opener 一律重置前一个未闭合块（嵌套/畸形不开新层级，omp 同款）。
      partial = {
        startLine: lineNumber,
        oursLabel: oursLabel || undefined,
        oursLines: [],
        theirsLines: [],
        hasBase: false,
        collected: [line],
      };
      phase = "ours";
      continue;
    }
    if (phase === "idle" || partial === null) continue;
    partial.collected.push(line);
    if (partial.collected.length > MAX_BLOCK_LINES) {
      reset();
      continue;
    }

    if (phase === "ours" || phase === "base") {
      const baseLabel = matchMarker(line, BASE_PREFIX);
      if (baseLabel !== null) {
        if (phase !== "ours") {
          reset();
          continue;
        }
        partial.baseLabel = baseLabel || undefined;
        partial.baseLines = [];
        partial.hasBase = true;
        phase = "base";
        continue;
      }
      if (matchMarker(line, SEPARATOR) !== null) {
        phase = "theirs";
        continue;
      }
      if (phase === "ours") partial.oursLines.push(line);
      else partial.baseLines!.push(line);
      continue;
    }

    // phase === "theirs"
    const theirsLabel = matchMarker(line, THEIRS_PREFIX);
    if (theirsLabel !== null) {
      // closer 行不进 theirs 内容；块完整闭合，产出。
      partial.theirsLabel = theirsLabel || undefined;
      blocks.push({
        startLine: partial.startLine,
        endLine: lineNumber,
        ...(partial.oursLabel ? { oursLabel: partial.oursLabel } : {}),
        ...(partial.baseLabel ? { baseLabel: partial.baseLabel } : {}),
        ...(partial.theirsLabel ? { theirsLabel: partial.theirsLabel } : {}),
        hasBase: partial.hasBase,
        lines: partial.collected,
        oursLines: partial.oursLines,
        ...(partial.baseLines ? { baseLines: partial.baseLines } : {}),
        theirsLines: partial.theirsLines,
      });
      reset();
      continue;
    }
    partial.theirsLines.push(line);
  }
  return blocks;
}
