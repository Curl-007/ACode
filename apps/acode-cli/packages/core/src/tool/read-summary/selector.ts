// 路径选择器解析（specs/read-structural-summary.md R3）。
// 语法参照 oh-my-pi (MIT) read-selector.ts, Copyright (c) 2025 Mario
// Zechner & Stencil Labs；Windows 盘符安全拆分为 ACode 强化（教训⑦：
// 平台对称——最后一个冒号后的片段必须完整匹配选择器文法才拆分，且调用方
// 先按原样路径探测存在性，真实文件优先）。

export type ReadSelector =
  | { kind: "none" }
  | { kind: "raw"; ranges?: LineRange[] }
  | { kind: "lines"; ranges: LineRange[] }
  | { kind: "tail"; count: number }
  | { kind: "conflicts" };

export interface LineRange {
  /** 1-based 起始行。 */
  start: number;
  /** 1-based 结束行（含）；undefined = 到文件尾。 */
  end?: number;
}

export interface SplitSelectorResult {
  path: string;
  selector: ReadSelector;
}

const RANGE_PATTERN = /^(\d+)(?:-(\d*))?(?:\+(\d+))?$/;
/** 组合形态 `path:raw:<ranges>`——必须先于「最后一个冒号」拆分（否则 raw 前缀被内层冒号抢配）。 */
const RAW_COMBO_PATTERN = /^(.+?):raw:(.+)$/i;

/**
 * 从 file_path 输入拆出尾部选择器。返回 selector.kind === "none" 表示无
 * 选择器（原样路径）。拆分规则：
 * - 取最后一个 `:` 之后的片段做**完整文法匹配**，不匹配则整串按路径处理
 *   （Windows 盘符 "C:\..." 的冒号后是路径体，天然不匹配）；
 * - 冒号前部分为空不拆（":raw" 不是合法输入）；
 * - 组合形态 `raw:100-140` / `raw:-20`（第二段继续按行选择器解析）。
 */
export function splitPathSelector(input: string): SplitSelectorResult {
  const trimmed = input.trim();
  // 组合形态优先：path:raw:100-140 / path:raw:-20（非贪婪 path 段兼容 Windows 盘符）。
  const combo = RAW_COMBO_PATTERN.exec(trimmed);
  if (combo) {
    const inner = parseSelectorBody(combo[2]!);
    if (inner && inner.kind === "lines") {
      return { path: combo[1]!, selector: { kind: "raw", ranges: inner.ranges } };
    }
    if (inner && inner.kind === "tail") {
      return { path: combo[1]!, selector: { kind: "raw", ranges: [{ start: -inner.count }] } };
    }
  }
  const colon = trimmed.lastIndexOf(":");
  if (colon <= 0 || colon === trimmed.length - 1) {
    return { path: input, selector: { kind: "none" } };
  }
  const candidate = trimmed.slice(colon + 1);
  const path = trimmed.slice(0, colon);
  const selector = parseSelectorBody(candidate);
  if (!selector) {
    return { path: input, selector: { kind: "none" } };
  }
  return { path, selector };
}

function parseSelectorBody(body: string): ReadSelector | undefined {
  const lower = body.toLowerCase();
  if (lower === "raw") return { kind: "raw" };
  if (lower === "conflicts") return { kind: "conflicts" };
  // 组合：raw:<ranges> / raw:-N
  if (lower.startsWith("raw:")) {
    const inner = parseSelectorBody(body.slice(4));
    if (!inner) return undefined;
    if (inner.kind === "lines") return { kind: "raw", ranges: inner.ranges };
    if (inner.kind === "tail") return { kind: "raw", ranges: [{ start: -inner.count }] };
    return undefined;
  }
  if (body.startsWith("-")) {
    const count = Number.parseInt(body.slice(1), 10);
    if (/^-\d+$/.test(body) && count > 0) return { kind: "tail", count };
    return undefined;
  }
  const ranges = parseRangeList(body);
  if (ranges) return { kind: "lines", ranges };
  return undefined;
}

function parseRangeList(body: string): LineRange[] | undefined {
  const parts = body.split(",");
  const ranges: LineRange[] = [];
  for (const part of parts) {
    const range = parseSingleRange(part.trim());
    if (!range) return undefined;
    ranges.push(range);
  }
  return ranges.length > 0 ? ranges : undefined;
}

function parseSingleRange(part: string): LineRange | undefined {
  const match = RANGE_PATTERN.exec(part);
  if (!match) return undefined;
  const start = Number.parseInt(match[1]!, 10);
  if (start < 1) return undefined;
  const dashEnd = match[2];
  const plusCount = match[3];
  if (plusCount !== undefined) {
    return { start, end: start + Number.parseInt(plusCount, 10) };
  }
  if (dashEnd === undefined) {
    // "N" 单行。
    return { start, end: start };
  }
  if (dashEnd === "") {
    // "N-" 开区间到尾。
    return { start };
  }
  const end = Number.parseInt(dashEnd, 10);
  if (end < start) return undefined;
  return { start, end };
}

/**
 * 把选择器折算为读取窗口（行号 1-based，含端点）。tail 的 start 为负数
 * 占位（-count），由本函数按总行数折算。越界返回错误信息（fail-loud，
 * R3 验收 3）。
 */
export function resolveSelectorWindow(
  selector: ReadSelector,
  totalLines: number,
): { startLine: number; endLine: number } | { error: string } {
  if (selector.kind === "tail") {
    const start = Math.max(1, totalLines - selector.count + 1);
    return { startLine: start, endLine: Math.max(start, totalLines) };
  }
  if (selector.kind !== "lines" && !(selector.kind === "raw" && selector.ranges)) {
    return { startLine: 1, endLine: totalLines };
  }
  const ranges = selector.kind === "lines" ? selector.ranges : (selector.ranges ?? []);
  if (ranges.length === 0) return { startLine: 1, endLine: totalLines };
  // 多区间：返回包围盒由调用方切片；负 start = tail 语义折算。
  let start = Number.POSITIVE_INFINITY;
  let end = 0;
  for (const range of ranges) {
    const resolvedStart = range.start < 0 ? Math.max(1, totalLines + range.start + 1) : range.start;
    const resolvedEnd = range.end ?? totalLines;
    if (resolvedStart > totalLines) {
      return {
        error: `line range starts at ${resolvedStart} but the file has ${totalLines} line(s); use :1-${totalLines} or omit the selector`,
      };
    }
    start = Math.min(start, resolvedStart);
    end = Math.max(end, Math.min(resolvedEnd, totalLines));
  }
  return { startLine: start, endLine: Math.max(start, end) };
}

/** 多区间精确切片（raw/lines 多段读取的正文拼装，段间以省略标记分隔）。 */
export function sliceLineRanges(
  lines: readonly string[],
  ranges: readonly LineRange[],
  totalLines: number,
): { text: string; startLine: number } {
  const chunks: string[] = [];
  let firstStart = 1;
  let prevEnd = 0;
  ranges.forEach((range, index) => {
    const start = range.start < 0 ? Math.max(1, totalLines + range.start + 1) : range.start;
    const end = Math.min(range.end ?? totalLines, totalLines);
    if (index === 0) {
      firstStart = start;
    } else if (start > prevEnd + 1) {
      chunks.push(`⋯ [lines ${prevEnd + 1}-${start - 1} omitted]`);
    }
    chunks.push(...lines.slice(start - 1, end));
    prevEnd = end;
  });
  return { text: chunks.join("\n"), startLine: firstStart };
}
