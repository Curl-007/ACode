// Ported from oh-my-pi (MIT) — packages/coding-agent/src/lsp/utils.ts（格式化切片）, Copyright (c) 2025 Mario Zechner & Stencil Labs
// ============================================================
// 诊断/位置/符号格式化（模型可见文本的唯一出口）
// ============================================================

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
  CodeAction,
  Command,
  Diagnostic,
  DiagnosticSeverity,
  DocumentSymbol,
  Location,
  SymbolInformation,
  TextEdit,
  WorkspaceEdit,
} from "./types.js";
import { isEnoent, readTextFromDisk, uriToFile } from "./uri.js";

const DIAGNOSTIC_MESSAGE_LIMIT = 50;

const SEVERITY_NAMES: Record<DiagnosticSeverity, string> = {
  1: "error",
  2: "warning",
  3: "info",
  4: "hint",
};

export function severityToString(severity?: DiagnosticSeverity): string {
  return SEVERITY_NAMES[severity ?? 1] ?? "unknown";
}

/** 按严重度、位置与消息排序诊断。 */
export function sortDiagnostics(diagnostics: Diagnostic[]): Diagnostic[] {
  return diagnostics.sort((a, b) => {
    const aSeverity = a.severity ?? 1;
    const bSeverity = b.severity ?? 1;
    if (aSeverity !== bSeverity) return aSeverity - bSeverity;
    if (a.range.start.line !== b.range.start.line) return a.range.start.line - b.range.start.line;
    if (a.range.start.character !== b.range.start.character) {
      return a.range.start.character - b.range.start.character;
    }
    return a.message.localeCompare(b.message);
  });
}

/** 剥诊断噪声（clippy URL 行、裸 URL 行）。 */
function stripDiagnosticNoise(message: string): string {
  return message
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      if (trimmed.startsWith("for further information visit")) return false;
      if (/^https?:\/\//.test(trimmed)) return false;
      return true;
    })
    .join("\n")
    .trim();
}

/** 单条诊断 → `relPath:line:col [severity] message (code)`。 */
export function formatDiagnostic(diagnostic: Diagnostic, filePath: string): string {
  const severity = severityToString(diagnostic.severity);
  const line = diagnostic.range.start.line + 1;
  const col = diagnostic.range.start.character + 1;
  const source = diagnostic.source ? `[${diagnostic.source}] ` : "";
  const code = diagnostic.code !== undefined ? ` (${diagnostic.code})` : "";
  const message = stripDiagnosticNoise(diagnostic.message);
  return `${filePath}:${line}:${col} [${severity}] ${source}${message}${code}`;
}

/** 按严重度分组的计数摘要（如 "2 error(s), 1 warning(s)"）。 */
export function formatDiagnosticsSummary(diagnostics: Diagnostic[]): string {
  return summarizeSeverityCounts(
    diagnostics.map((d) => severityToString(d.severity)),
  );
}

/** 从已格式化消息文本恢复计数摘要（ledger/deferred 通道复用）。 */
export function summarizeDiagnosticMessages(messages: string[]): { summary: string; errored: boolean } {
  const severities: string[] = [];
  for (const message of messages) {
    const match = message.match(/\[(error|warning|info|hint)\]/i);
    if (match) severities.push(match[1]!.toLowerCase());
  }
  const summary = summarizeSeverityCounts(severities);
  return { summary, errored: severities.includes("error") };
}

function summarizeSeverityCounts(severities: readonly string[]): string {
  const counts = { error: 0, warning: 0, info: 0, hint: 0 };
  for (const sev of severities) {
    if (sev === "error") counts.error += 1;
    else if (sev === "warning") counts.warning += 1;
    else if (sev === "info") counts.info += 1;
    else if (sev === "hint") counts.hint += 1;
  }
  const parts: string[] = [];
  if (counts.error > 0) parts.push(`${counts.error} error(s)`);
  if (counts.warning > 0) parts.push(`${counts.warning} warning(s)`);
  if (counts.info > 0) parts.push(`${counts.info} info(s)`);
  if (counts.hint > 0) parts.push(`${counts.hint} hint(s)`);
  return parts.length > 0 ? parts.join(", ") : "no issues";
}

export function limitDiagnosticMessages(messages: string[]): string[] {
  if (messages.length <= DIAGNOSTIC_MESSAGE_LIMIT) return messages;
  return messages.slice(0, DIAGNOSTIC_MESSAGE_LIMIT);
}

/** 位置 → 相对 cwd 的 `file:line:col`。 */
export function formatLocation(location: Location, cwd: string): string {
  const file = formatPathRelativeToCwd(uriToFile(location.uri), cwd);
  return `${file}:${location.range.start.line + 1}:${location.range.start.character + 1}`;
}

/** 相对 cwd 展示路径（不越出 cwd 就相对化并统一分隔符）。 */
export function formatPathRelativeToCwd(filePath: string, cwd: string): string {
  const resolved = path.resolve(filePath);
  const relative = path.relative(cwd, resolved);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return resolved;
  return relative.split(path.sep).join("/");
}

// -----------------------------------------------------------------------------
// Hover / Symbols
// -----------------------------------------------------------------------------

/** 从 hover contents 抽纯文本。 */
export function extractHoverText(
  contents: string | { kind: string; value: string } | { language: string; value: string } | unknown[],
): string {
  if (typeof contents === "string") return contents;
  if (Array.isArray(contents)) {
    return contents.map((c) => extractHoverText(c as string | { kind: string; value: string })).join("\n\n");
  }
  if (typeof contents === "object" && contents !== null && "value" in contents) {
    const value = (contents as { value: unknown }).value;
    if (typeof value === "string") return value;
  }
  return String(contents);
}

const SYMBOL_KIND_NAMES: Record<number, string> = {
  1: "File",
  2: "Module",
  3: "Namespace",
  4: "Package",
  5: "Class",
  6: "Method",
  7: "Property",
  8: "Field",
  9: "Constructor",
  10: "Enum",
  11: "Interface",
  12: "Function",
  13: "Variable",
  14: "Constant",
  15: "String",
  16: "Number",
  17: "Boolean",
  18: "Array",
  19: "Object",
  20: "Key",
  21: "Null",
  22: "EnumMember",
  23: "Struct",
  24: "Event",
  25: "Operator",
  26: "TypeParameter",
};

export function symbolKindToName(kind: number): string {
  return SYMBOL_KIND_NAMES[kind] ?? "Unknown";
}

/** 层级 document symbol → 缩进行列表。 */
export function formatDocumentSymbol(symbol: DocumentSymbol, indent = 0): string[] {
  const prefix = "  ".repeat(indent);
  const line = symbol.range.start.line + 1;
  const detail = symbol.detail ? ` ${symbol.detail}` : "";
  const kind = symbolKindToName(symbol.kind);
  const results = [`${prefix}${kind} ${symbol.name}${detail} @ line ${line}`];
  if (symbol.children) {
    for (const child of symbol.children) results.push(...formatDocumentSymbol(child, indent + 1));
  }
  return results;
}

export function formatSymbolInformation(symbol: SymbolInformation, cwd: string): string {
  const kind = symbolKindToName(symbol.kind);
  const location = formatLocation(symbol.location, cwd);
  const container = symbol.containerName ? ` (${symbol.containerName})` : "";
  return `${kind} ${symbol.name}${container} @ ${location}`;
}

export function filterWorkspaceSymbols(symbols: SymbolInformation[], query: string): SymbolInformation[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return symbols;
  return symbols.filter((symbol) => {
    const fields = [symbol.name, symbol.containerName ?? "", uriToFile(symbol.location.uri)];
    return fields.some((field) => field.toLowerCase().includes(needle));
  });
}

export function dedupeWorkspaceSymbols(symbols: SymbolInformation[]): SymbolInformation[] {
  const seen = new Set<string>();
  const unique: SymbolInformation[] = [];
  for (const symbol of symbols) {
    const key = [
      symbol.name,
      symbol.containerName ?? "",
      symbol.kind,
      symbol.location.uri,
      symbol.location.range.start.line,
      symbol.location.range.start.character,
    ].join(":");
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(symbol);
  }
  return unique;
}

// -----------------------------------------------------------------------------
// WorkspaceEdit / CodeAction
// -----------------------------------------------------------------------------

/** WorkspaceEdit → 逐文件变更摘要行。 */
export function formatWorkspaceEdit(edit: WorkspaceEdit, cwd: string): string[] {
  const results: string[] = [];
  if (edit.changes) {
    for (const [uri, textEdits] of Object.entries(edit.changes)) {
      const file = formatPathRelativeToCwd(uriToFile(uri), cwd);
      results.push(`${file}: ${textEdits.length} edit${textEdits.length > 1 ? "s" : ""}`);
    }
  }
  if (edit.documentChanges) {
    for (const change of edit.documentChanges) {
      if ("textDocument" in change && change.textDocument && "edits" in change) {
        const file = formatPathRelativeToCwd(uriToFile(change.textDocument.uri), cwd);
        const count = change.edits.length;
        results.push(`${file}: ${count} edit${count > 1 ? "s" : ""}`);
      } else if ("kind" in change && change.kind === "rename") {
        results.push(
          `RENAME: ${formatPathRelativeToCwd(uriToFile(change.oldUri), cwd)} -> ${formatPathRelativeToCwd(uriToFile(change.newUri), cwd)}`,
        );
      } else if ("kind" in change && change.kind === "create") {
        results.push(`CREATE: ${formatPathRelativeToCwd(uriToFile(change.uri), cwd)}`);
      } else if ("kind" in change && change.kind === "delete") {
        results.push(`DELETE: ${formatPathRelativeToCwd(uriToFile(change.uri), cwd)}`);
      }
    }
  }
  return results;
}

export function formatTextEditPreview(edit: TextEdit, maxLength = 50): string {
  const range = `${edit.range.start.line + 1}:${edit.range.start.character + 1}`;
  const preview =
    edit.newText.length > maxLength
      ? `${edit.newText.slice(0, maxLength).replace(/\n/g, "\\n")}…`
      : edit.newText.replace(/\n/g, "\\n");
  return `line ${range} "${preview}"`;
}

export function formatCodeAction(action: CodeAction | Command, index: number): string {
  const kind = "kind" in action && action.kind ? action.kind : "action";
  const preferred = "isPreferred" in action && action.isPreferred ? " (preferred)" : "";
  const disabled = "disabled" in action && action.disabled ? ` (disabled: ${action.disabled.reason})` : "";
  return `${index}: [${kind}] ${action.title}${preferred}${disabled}`;
}

// -----------------------------------------------------------------------------
// 位置上下文 / 符号定位
// -----------------------------------------------------------------------------

const LOCATION_CONTEXT_LINES = 1;

/** 位置行 ±1 行源码上下文（装饰性，读失败回退空）。 */
export async function readLocationContext(filePath: string, line: number, contextLines = LOCATION_CONTEXT_LINES): Promise<string[]> {
  const targetLine = Math.max(1, line);
  const surrounding = Math.max(0, contextLines);
  try {
    const fileText = await fs.readFile(filePath, "utf8");
    const lines = fileText.split("\n");
    if (lines.length === 0) return [];
    const startLine = Math.max(1, targetLine - surrounding);
    const endLine = Math.min(lines.length, targetLine + surrounding);
    const context: string[] = [];
    for (let currentLine = startLine; currentLine <= endLine; currentLine += 1) {
      context.push(`${currentLine}: ${lines[currentLine - 1] ?? ""}`);
    }
    return context;
  } catch (error) {
    if (isEnoent(error)) return [];
    throw error;
  }
}

export async function formatLocationWithContext(location: Location, cwd: string): Promise<string> {
  const header = `  ${formatLocation(location, cwd)}`;
  const context = await readLocationContext(uriToFile(location.uri), location.range.start.line + 1);
  if (context.length === 0) return header;
  return `${header}\n${context.map((lineText) => `    ${lineText}`).join("\n")}`;
}

function firstNonWhitespaceColumn(lineText: string): number {
  const match = lineText.match(/\S/);
  return match ? (match.index ?? 0) : 0;
}

const BARE_IDENTIFIER_RE = /^[$A-Za-z_][\w$]*$/;
const IDENTIFIER_CHAR_RE = /[A-Za-z0-9_$]/;

function findSymbolMatchIndexes(lineText: string, symbol: string, caseInsensitive = false): number[] {
  if (symbol.length === 0) return [];
  const haystack = caseInsensitive ? lineText.toLowerCase() : lineText;
  const needle = caseInsensitive ? symbol.toLowerCase() : symbol;
  const requireWordBoundary = BARE_IDENTIFIER_RE.test(symbol);
  const indexes: number[] = [];
  let fromIndex = 0;
  while (fromIndex <= haystack.length - needle.length) {
    const matchIndex = haystack.indexOf(needle, fromIndex);
    if (matchIndex === -1) break;
    if (requireWordBoundary) {
      const before = matchIndex > 0 ? haystack[matchIndex - 1] : "";
      const afterIdx = matchIndex + needle.length;
      const after = afterIdx < haystack.length ? haystack[afterIdx] : "";
      if (IDENTIFIER_CHAR_RE.test(before) || IDENTIFIER_CHAR_RE.test(after)) {
        fromIndex = matchIndex + 1;
        continue;
      }
    }
    indexes.push(matchIndex);
    fromIndex = matchIndex + needle.length;
  }
  return indexes;
}

/** 解析 `name` 或 `name#N`（行内第 N 次出现，1 起）——贪 `.+`，`#name#2` 解析为符号 `#name`。 */
function parseSymbolSpec(spec: string): { symbol: string; occurrence: number } {
  const match = spec.match(/^(.+)#(\d+)$/);
  if (!match) return { symbol: spec, occurrence: 1 };
  return { symbol: match[1]!, occurrence: Math.max(1, Number.parseInt(match[2]!, 10)) };
}

/** 行号 + 可选符号 spec → 列号。无 symbol 回退行首非空白列。 */
export async function resolveSymbolColumn(filePath: string, line: number, symbolSpec?: string): Promise<number> {
  const lineNumber = Math.max(1, line);
  let fileText: string;
  try {
    fileText = await readTextFromDisk(filePath);
  } catch (error) {
    if (isEnoent(error)) throw new Error(`File not found: ${filePath}`);
    throw error;
  }
  const lines = fileText.split("\n");
  const targetLine = lines[lineNumber - 1] ?? "";
  if (!symbolSpec) return firstNonWhitespaceColumn(targetLine);

  const { symbol, occurrence } = parseSymbolSpec(symbolSpec);
  const exactIndexes = findSymbolMatchIndexes(targetLine, symbol);
  const fallbackIndexes = exactIndexes.length > 0 ? exactIndexes : findSymbolMatchIndexes(targetLine, symbol, true);
  if (fallbackIndexes.length === 0) {
    throw new Error(`Symbol "${symbol}" not found on line ${lineNumber}`);
  }
  if (occurrence > fallbackIndexes.length) {
    throw new Error(
      `Symbol "${symbol}" occurrence ${occurrence} is out of bounds on line ${lineNumber} (found ${fallbackIndexes.length})`,
    );
  }
  return fallbackIndexes[occurrence - 1]!;
}
