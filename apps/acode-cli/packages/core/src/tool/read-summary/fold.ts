// 结构化折叠引擎（specs/read-structural-summary.md R2）。
// 机制参照 oh-my-pi (MIT) read-summary.ts + pi-natives summarizeCode 的
// 「签名+注释保留、长体折叠」语义, Copyright (c) 2025 Mario Zechner &
// Stencil Labs；解析器换 typescript 编译器 API（core 既有依赖，单文件
// createSourceFile 轻量解析，无 Program/类型检查开销），语言面收窄 JS/TS 族。
//
// 输出是**分段表**而非直接文本：keep 段携带原文件行号区间，fold 段携带
// 原行号区间与展开标记——渲染层据此输出「原行号锚定」的摘要正文（R2）。

import ts from "typescript";
import type { ReadSummaryConfig } from "./config.js";

export interface FoldSegment {
  kind: "keep" | "fold";
  /** 1-based，含端点。 */
  startLine: number;
  endLine: number;
  /** fold 段的展开标记行文本。 */
  marker?: string;
}

export interface FoldResult {
  segments: FoldSegment[];
  foldedBlocks: number;
  foldedLines: number;
  totalLines: number;
}

export interface FoldInput {
  fileName: string;
  text: string;
  /** 尾注/标记里展示的路径形态（与 read 输出同口径）。 */
  displayPath: string;
  config: ReadSummaryConfig;
}

interface RawFold {
  startLine: number;
  endLine: number;
  label: string;
}

/**
 * 对源码做结构化折叠。返回 null = 不该摘要（解析不出语句/无可折叠声明/
 * 全平铺脚本）——调用方退化为现行为（R1「解析出至少一个可折叠声明」）。
 */
export function foldSourceStructurally(input: FoldInput): FoldResult | null {
  const { fileName, text, displayPath, config } = input;
  const lines = text.split("\n");
  const totalLines = lines.length;
  let sourceFile: ts.SourceFile;
  try {
    sourceFile = ts.createSourceFile(
      fileName,
      text,
      ts.ScriptTarget.Latest,
      /*setParentNodes*/ false,
      scriptKindOf(fileName),
    );
  } catch {
    return null;
  }
  if (sourceFile.statements.length === 0) return null;

  const lineOf = (position: number): number =>
    sourceFile.getLineAndCharacterOfPosition(position).line + 1;

  const folds: RawFold[] = [];

  const considerBody = (
    owner: ts.Node,
    body: ts.Node | undefined,
    label: string,
  ): void => {
    if (!body) return;
    const bodyStart = body.getStart(sourceFile);
    const fullStartLine = lineOf(bodyStart);
    const fullEndLine = lineOf(Math.max(bodyStart, body.getEnd() - 1));
    const bodyLines = fullEndLine - fullStartLine + 1;
    if (bodyLines < config.minBodyLines || bodyLines <= config.unfoldLimitLines) return;
    // 体与声明共享首行（`function f() {`）→ 保留首行（签名可读性）；体收尾
    // 行（`}`）同样保留——折叠区间只吃中间行，展开标记的行号即真实可展开区间。
    let startLine = fullStartLine;
    let endLine = fullEndLine;
    if (startLine === lineOf(owner.getStart(sourceFile))) startLine += 1;
    if (endLine > fullStartLine) endLine -= 1;
    if (endLine < startLine) return;
    folds.push({ startLine, endLine, label });
  };

  const visit = (node: ts.Node): void => {
    // 函数族：折叠体（签名与前置 JSDoc 天然保留——它们在体区间之外）。
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isConstructorDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node)
    ) {
      const before = folds.length;
      considerBody(node, node.body, "body");
      if (folds.length > before) return; // 体已折叠，内部无需再.visit（嵌套被外层覆盖）
    }
    // interface/type/enum：超长时折叠成员区（保留头行与收尾括号行）。
    if (
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isEnumDeclaration(node)
    ) {
      const startLine = lineOf(node.getStart(sourceFile));
      const endLine = lineOf(Math.max(node.getStart(sourceFile), node.getEnd() - 1));
      const span = endLine - startLine + 1;
      if (span > config.unfoldLimitLines) {
        // 折叠 [头行+1, 尾行-1]（保留声明头与最后的 "}"/";"）。
        if (endLine - startLine >= 2) {
          folds.push({
            startLine: startLine + 1,
            endLine: endLine - 1,
            label: "members",
          });
          return;
        }
      }
    }
    // 顶层/成员长字面量（对象/数组）折叠。
    if (ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node)) {
      considerBody(node, node, "literal");
    }
    ts.forEachChild(node, visit);
  };

  for (const statement of sourceFile.statements) {
    visit(statement);
  }

  // 连续 import 折叠（R2）：超长 import 段折叠中段，保留首条与计数标记。
  collectImportRuns(sourceFile, lineOf, config.maxConsecutiveImports, folds);

  if (folds.length === 0) return null;

  const segments = buildSegments(folds, totalLines, lines, displayPath);
  const foldedBlocks = segments.filter((segment) => segment.kind === "fold").length;
  const foldedLines = segments
    .filter((segment) => segment.kind === "fold")
    .reduce((sum, segment) => sum + (segment.endLine - segment.startLine + 1), 0);
  return { segments, foldedBlocks, foldedLines, totalLines };
}

function collectImportRuns(
  sourceFile: ts.SourceFile,
  lineOf: (position: number) => number,
  maxConsecutive: number,
  folds: RawFold[],
): void {
  let runStart = -1;
  let runEndLine = -1;
  let runCount = 0;
  const flush = (): void => {
    if (runCount > maxConsecutive && runStart >= 0) {
      // 保留 run 的第一条 import，折叠其余（[第一条结束行+1, run 尾行]）。
      const firstImportEnd = lineOf(
        Math.max(
          sourceFile.statements[runStart]!.getStart(sourceFile),
          sourceFile.statements[runStart]!.getEnd() - 1,
        ),
      );
      const lastLine = runEndLine;
      if (lastLine > firstImportEnd) {
        folds.push({
          startLine: firstImportEnd + 1,
          endLine: lastLine,
          label: `imports (${runCount - 1} more)`,
        });
      }
    }
    runStart = -1;
    runCount = 0;
    runEndLine = -1;
  };
  sourceFile.statements.forEach((statement, index) => {
    const isImport =
      ts.isImportDeclaration(statement) || ts.isImportEqualsDeclaration(statement);
    if (isImport) {
      if (runStart < 0) runStart = index;
      runCount += 1;
      runEndLine = lineOf(Math.max(statement.getStart(sourceFile), statement.getEnd() - 1));
    } else {
      flush();
    }
  });
  flush();
}

/** 折叠区间去重叠（外层优先：按起点排序，被包含的丢弃）并铺成段表。 */
function buildSegments(
  folds: RawFold[],
  totalLines: number,
  lines: readonly string[],
  displayPath: string,
): FoldSegment[] {
  const sorted = [...folds].sort(
    (left, right) => left.startLine - right.startLine || right.endLine - left.endLine,
  );
  const accepted: RawFold[] = [];
  let coveredUntil = 0;
  for (const fold of sorted) {
    if (fold.startLine <= coveredUntil) continue; // 嵌套/重叠：外层已覆盖
    accepted.push(fold);
    coveredUntil = fold.endLine;
  }
  const segments: FoldSegment[] = [];
  let cursor = 1;
  for (const fold of accepted) {
    if (fold.startLine > cursor) {
      segments.push({ kind: "keep", startLine: cursor, endLine: fold.startLine - 1 });
    }
    const count = fold.endLine - fold.startLine + 1;
    segments.push({
      kind: "fold",
      startLine: fold.startLine,
      endLine: fold.endLine,
      marker: `${indentOf(lines[fold.startLine - 1] ?? "")}// … ${fold.label} folded: ${count} lines (L${fold.startLine}-L${fold.endLine}) — read "${displayPath}:${fold.startLine}-${fold.endLine}" to expand`,
    });
    cursor = fold.endLine + 1;
  }
  if (cursor <= totalLines) {
    segments.push({ kind: "keep", startLine: cursor, endLine: totalLines });
  }
  return segments;
}

function indentOf(line: string): string {
  const match = /^[ \t]*/.exec(line);
  return match ? match[0] : "";
}

function scriptKindOf(fileName: string): ts.ScriptKind {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (lower.endsWith(".ts")) return ts.ScriptKind.TS;
  if (lower.endsWith(".jsx")) return ts.ScriptKind.JSX;
  return ts.ScriptKind.JS;
}
