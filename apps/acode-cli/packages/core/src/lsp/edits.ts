// Ported from oh-my-pi (MIT) — packages/coding-agent/src/lsp/edits.ts, Copyright (c) 2025 Mario Zechner & Stencil Labs
// ============================================================
// WorkspaceEdit / TextEdit 落盘：重叠校验、顺序化、原子重命名回滚
// ============================================================

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
  CreateFile,
  DeleteFile,
  Position,
  Range,
  RenameFile,
  TextDocumentEdit,
  TextEdit,
  WorkspaceEdit,
} from "./types.js";
import { isEnoent, readTextFromDisk, uriToFile } from "./uri.js";
import { formatPathRelativeToCwd } from "./format.js";

// =============================================================================
// 文本编辑应用
// =============================================================================

/**
 * 把文本编辑应用到内存字符串。编辑自底向上应用，保持行/列索引有效。
 * 等价起点按原数组序倒序破平——自底向上应用时同位置插入按声明顺序落地
 * （LSP spec：数组顺序定义结果顺序）。
 */
export function applyTextEditsToString(content: string, edits: TextEdit[]): string {
  const lines = content.split("\n");
  const sortedEdits = sortAndValidateTextEdits(edits);

  for (const edit of sortedEdits) {
    const { start, end } = edit.range;
    if (start.line === end.line) {
      // 单行编辑：同行内子串替换。
      const line = lines[start.line] ?? "";
      lines[start.line] = line.slice(0, start.character) + edit.newText + line.slice(end.character);
    } else {
      // 多行编辑：跨行拼接。
      const startLine = lines[start.line] ?? "";
      const endLine = lines[end.line] ?? "";
      const newContent = startLine.slice(0, start.character) + edit.newText + endLine.slice(end.character);
      lines.splice(start.line, end.line - start.line + 1, ...newContent.split("\n"));
    }
  }

  return lines.join("\n");
}

function comparePosition(a: Position, b: Position): number {
  return a.line === b.line ? a.character - b.character : a.line - b.line;
}

function positionsEqual(a: Position, b: Position): boolean {
  return a.line === b.line && a.character === b.character;
}

function rangesEqual(a: Range, b: Range): boolean {
  return positionsEqual(a.start, b.start) && positionsEqual(a.end, b.end);
}

function isEmptyRange(range: Range): boolean {
  return positionsEqual(range.start, range.end);
}

function formatRange(range: Range): string {
  return `${range.start.line + 1}:${range.start.character + 1}-${range.end.line + 1}:${range.end.character + 1}`;
}

/** 两个区间是否重叠（共享除接触边界外的任意位置）。 */
export function rangesOverlap(a: Range, b: Range): boolean {
  return comparePosition(a.start, b.end) < 0 && comparePosition(b.start, a.end) < 0;
}

export class LspEditError extends Error {}

function rejectSnippetTextEdits(edits: TextEdit[]): void {
  for (const edit of edits) {
    if ("insertTextFormat" in edit && edit.insertTextFormat === 2) {
      throw new LspEditError("snippet-formatted LSP edits are unsupported");
    }
  }
}

/**
 * 自底向上排序并校验编辑。字节相同的重复编辑在重叠校验前折叠（服务器输出
 * 去重）；逆序排列后每个编辑的起点必须 ≥ 前一个编辑的终点，否则应用时会互相
 * 覆盖——LSP 产出了不自洽的编辑集。
 */
export function sortAndValidateTextEdits(edits: TextEdit[]): TextEdit[] {
  rejectSnippetTextEdits(edits);
  const sorted = edits
    .map((edit, index) => ({ edit, index }))
    .sort((a, b) => {
      if (a.edit.range.start.line !== b.edit.range.start.line) {
        return b.edit.range.start.line - a.edit.range.start.line;
      }
      if (a.edit.range.start.character !== b.edit.range.start.character) {
        return b.edit.range.start.character - a.edit.range.start.character;
      }
      return b.index - a.index;
    })
    .map((entry) => entry.edit);
  const unique: TextEdit[] = [];
  for (const edit of sorted) {
    const prev = unique[unique.length - 1];
    if (prev && !isEmptyRange(edit.range) && rangesEqual(prev.range, edit.range) && prev.newText === edit.newText) {
      continue;
    }
    unique.push(edit);
  }

  for (let i = 0; i < unique.length - 1; i += 1) {
    const later = unique[i]!.range;
    const earlier = unique[i + 1]!.range;
    if (comparePosition(earlier.end, later.start) > 0) {
      throw new LspEditError(
        `overlapping LSP edits: ${formatRange(earlier)} conflicts with ${formatRange(later)}; LSP produced inconsistent edits`,
      );
    }
  }

  return unique;
}

/** WorkspaceEdit 的文本编辑按 URI 拍平；资源操作由调用方单独处理。 */
export function flattenWorkspaceTextEdits(edit: WorkspaceEdit): Map<string, TextEdit[]> {
  const out = new Map<string, TextEdit[]>();
  const push = (uri: string, edits: TextEdit[]) => {
    if (edits.length === 0) return;
    const prev = out.get(uri);
    if (prev) prev.push(...edits);
    else out.set(uri, [...edits]);
  };
  if (edit.changes) {
    for (const uri in edit.changes) push(uri, edit.changes[uri]!);
  }
  if (edit.documentChanges) {
    for (const change of edit.documentChanges) {
      if ("textDocument" in change && change.textDocument && "edits" in change) {
        const textEdits = (change as TextDocumentEdit).edits.filter(
          (e): e is TextEdit => "range" in e && "newText" in e,
        );
        push(change.textDocument.uri, textEdits);
      }
    }
  }
  return out;
}

/** 把文本编辑落到文件：读盘 → 内存应用 → 写回。 */
export async function applyTextEdits(filePath: string, edits: TextEdit[]): Promise<void> {
  const content = await readTextFromDisk(filePath);
  const result = applyTextEditsToString(content, edits);
  await fs.writeFile(filePath, result, "utf8");
}

// =============================================================================
// WorkspaceEdit 应用
// =============================================================================

type WorkspaceEditOp =
  | { kind: "text"; uri: string; edits: TextEdit[] }
  | { kind: "create"; uri: string; options?: CreateFile["options"] }
  | { kind: "rename"; oldUri: string; newUri: string; options?: RenameFile["options"] }
  | { kind: "delete"; uri: string; options?: DeleteFile["options"] };

/**
 * documentChanges 展开为有序操作列表。文本编辑按 URI 累积，在任何触及同一
 * URI（或其后代——目录级资源操作）的资源操作前 flush，保证 rename/create/delete
 * 看到正确的先前文件状态。
 */
function planDocumentChanges(documentChanges: NonNullable<WorkspaceEdit["documentChanges"]>): WorkspaceEditOp[] {
  const ops: WorkspaceEditOp[] = [];
  const pending = new Map<string, TextEdit[]>();

  const flushUri = (uri: string) => {
    const edits = pending.get(uri);
    if (!edits) return;
    pending.delete(uri);
    ops.push({ kind: "text", uri, edits });
  };

  // flush 精确 URI 及全部待处理后代（目录级资源操作目标下的子文件）。
  const flushSubtree = (uri: string) => {
    const prefix = uri.endsWith("/") ? uri : `${uri}/`;
    const matches: string[] = [];
    for (const candidate of pending.keys()) {
      if (candidate === uri || candidate.startsWith(prefix)) matches.push(candidate);
    }
    for (const target of matches) flushUri(target);
  };

  for (const change of documentChanges) {
    if ("textDocument" in change && change.textDocument && "edits" in change) {
      const uri = change.textDocument.uri;
      const textEdits = change.edits.filter((e): e is TextEdit => "range" in e && "newText" in e);
      if (textEdits.length > 0) {
        const prev = pending.get(uri);
        if (prev) prev.push(...textEdits);
        else pending.set(uri, [...textEdits]);
      }
    } else if ("kind" in change && change.kind === "create") {
      flushUri(change.uri);
      ops.push({ kind: "create", uri: change.uri, options: change.options });
    } else if ("kind" in change && change.kind === "rename") {
      // LSP §3.16.2：documentChanges 按声明顺序应用。flush 源与目标两棵子树
      // （rename 覆盖/替换场景下先前的编辑要先落到 newUri 的现存内容上）。
      flushSubtree(change.oldUri);
      flushSubtree(change.newUri);
      ops.push({ kind: "rename", oldUri: change.oldUri, newUri: change.newUri, options: change.options });
    } else if ("kind" in change && change.kind === "delete") {
      flushSubtree(change.uri);
      ops.push({ kind: "delete", uri: change.uri, options: change.options });
    }
  }

  for (const uri of Array.from(pending.keys())) flushUri(uri);
  return ops;
}

/** {@link applyWorkspaceEdit} 实际执行的文件系统变更。 */
export type ExecutedWorkspaceChange =
  | { kind: "edit"; uri: string }
  | { kind: "create"; uri: string }
  | { kind: "rename"; oldUri: string; newUri: string }
  | { kind: "delete"; uri: string };

/**
 * 应用 workspace edit（文件变更集合）。全部文本编辑批次先校验再写盘，
 * 冲突直接抛出，不会留下半套 workspace。
 */
export async function applyWorkspaceEdit(
  edit: WorkspaceEdit,
  cwd: string,
  onExecuted?: (change: ExecutedWorkspaceChange) => void,
): Promise<string[]> {
  const applied: string[] = [];
  const record = (change: ExecutedWorkspaceChange) => onExecuted?.(change);

  if (edit.documentChanges) {
    const ops = planDocumentChanges(edit.documentChanges);
    for (const op of ops) {
      if (op.kind === "text") sortAndValidateTextEdits(op.edits);
    }
    for (const op of ops) {
      if (op.kind === "text") {
        const filePath = uriToFile(op.uri);
        await applyTextEdits(filePath, op.edits);
        applied.push(`Applied ${op.edits.length} edit(s) to ${formatPathRelativeToCwd(filePath, cwd)}`);
        record({ kind: "edit", uri: op.uri });
      } else if (op.kind === "create") {
        const filePath = uriToFile(op.uri);
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        try {
          if (op.options?.overwrite) {
            await fs.writeFile(filePath, "", { flag: "w" });
          } else {
            const handle = await fs.open(filePath, "wx");
            await handle.close();
          }
        } catch (error) {
          const code = (error as { code?: unknown }).code;
          if (!(op.options?.ignoreIfExists && !op.options.overwrite && code === "EEXIST")) throw error;
          continue;
        }
        applied.push(`Created ${formatPathRelativeToCwd(filePath, cwd)}`);
        record({ kind: "create", uri: op.uri });
      } else if (op.kind === "rename") {
        const oldPath = uriToFile(op.oldUri);
        const newPath = uriToFile(op.newUri);
        await fs.mkdir(path.dirname(newPath), { recursive: true });
        if (oldPath !== newPath) {
          if (!op.options?.overwrite) {
            let targetExists = false;
            try {
              await fs.lstat(newPath);
              targetExists = true;
            } catch {
              // ENOENT = 目标空闲，正常继续。
            }
            if (targetExists) {
              if (op.options?.ignoreIfExists) continue;
              throw new LspEditError(`rename target already exists: ${formatPathRelativeToCwd(newPath, cwd)}`);
            }
          }
          await fs.rename(oldPath, newPath);
        }
        applied.push(`Renamed ${formatPathRelativeToCwd(oldPath, cwd)} -> ${formatPathRelativeToCwd(newPath, cwd)}`);
        record({ kind: "rename", oldUri: op.oldUri, newUri: op.newUri });
      } else {
        const filePath = uriToFile(op.uri);
        try {
          const stat = await fs.lstat(filePath);
          if (stat.isDirectory() && !stat.isSymbolicLink() && !op.options?.recursive) {
            await fs.rmdir(filePath);
          } else {
            await fs.rm(filePath, { recursive: op.options?.recursive ?? false });
          }
        } catch (error) {
          if (!(op.options?.ignoreIfNotExists && isEnoent(error))) throw error;
          continue;
        }
        applied.push(`Deleted ${formatPathRelativeToCwd(filePath, cwd)}`);
        record({ kind: "delete", uri: op.uri });
      }
    }
  } else if (edit.changes) {
    // 旧式 changes-map 路径：全部文件的编辑先校验后写。
    for (const uri in edit.changes) sortAndValidateTextEdits(edit.changes[uri]!);
    for (const uri in edit.changes) {
      const textEdits = edit.changes[uri]!;
      if (textEdits.length === 0) continue;
      const filePath = uriToFile(uri);
      await applyTextEdits(filePath, textEdits);
      applied.push(`Applied ${textEdits.length} edit(s) to ${formatPathRelativeToCwd(filePath, cwd)}`);
      record({ kind: "edit", uri });
    }
  }

  return applied;
}

// =============================================================================
// 引用编辑 + 移动的一体化（rename_file 基建）
// =============================================================================

/** 一个引用文件与 rename 为它计算的文本编辑。 */
export interface RenameReferenceEdit {
  filePath: string;
  edits: TextEdit[];
}

/**
 * 先应用引用编辑再移动 source→dest，作为一个单元。
 *
 * 引用编辑（其它文件的 import/使用点改写）必须在移动前写入以匹配移动前内容，
 * 但移动失败不得留下半改写的文件：先快照每个被编辑文件，mkdir/rename 抛错时
 * 全部快照回滚再上抛。失败的移动让源、目标与全部引用文件保持原样。
 */
export async function applyEditsThenRename(
  references: RenameReferenceEdit[],
  source: string,
  dest: string,
): Promise<void> {
  const backups: Array<{ filePath: string; original: string }> = [];
  for (const { filePath, edits } of references) {
    backups.push({ filePath, original: await readTextFromDisk(filePath) });
    await applyTextEdits(filePath, edits);
  }
  try {
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.rename(source, dest);
  } catch (err) {
    await Promise.all(backups.map(({ filePath, original }) => fs.writeFile(filePath, original, "utf8")));
    throw err;
  }
}
