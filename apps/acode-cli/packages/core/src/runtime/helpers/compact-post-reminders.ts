import { ESTIMATED_TOKEN_CHAR_DIVISOR } from "@acode/shared";
import { isAbsolute, resolve } from "node:path";
import { normalizeToolPathForComparison } from "../../tool/path-normalization.js";
import type { ReadFileStateEntry, ReadFileStateMap } from "../deps.js";
import {
  systemReminderAttachmentEntry,
  type RuntimeMessageEntry,
} from "../../agent/message-history.js";

// preserved tail 里能在模型上下文中直接看到读取/写入事实的工具（specs/post-compact-read-state.md R1）。
// ApplyPatch 不参与：入参是 patch_text（多文件、无 file_path），解析超出提醒/保留口径，
// 对应条目按摘要侧清除（保守 fail-safe，与 hydrator 的 ApplyPatch 单槽位语义同向）。
const PRESERVED_EDIT_TOOL_NAMES = new Set(["Read", "Write", "Edit"]);

export interface PostCompactReadStateReminderSelection {
  /** 内容被投影回上下文的文件路径（归一化后）；这些文件的已读状态必须保留（R1b）。 */
  contentProjectedPaths: Set<string>;
  entries: RuntimeMessageEntry[];
}

export function selectPostCompactReadStateReminders(input: {
  maxFileApproxTokens?: number;
  maxFiles?: number;
  maxTotalApproxTokens?: number;
  preservedEntries?: readonly RuntimeMessageEntry[];
  readFileState?: ReadFileStateMap;
  workingDirectory?: string;
}): PostCompactReadStateReminderSelection {
  const readFileState = input.readFileState;
  if (!readFileState || readFileState.size === 0) {
    return { contentProjectedPaths: new Set(), entries: [] };
  }

  const maxFiles = input.maxFiles ?? 5;
  const maxFileApproxTokens = input.maxFileApproxTokens ?? 5_000;
  const maxTotalApproxTokens = input.maxTotalApproxTokens ?? 50_000;
  const selected: RuntimeMessageEntry[] = [];
  const contentProjectedPaths = new Set<string>();
  let totalApproxTokens = 0;
  const preservedReadFilePaths = collectPreservedEditToolFilePaths(
    input.preservedEntries ?? [],
    input.workingDirectory,
  );

  const candidates = Array.from(readFileState.values())
    .filter(isPostCompactReadReminderCandidate)
    .filter((entry) => !shouldSkipPostCompactReadStatePath(entry.path))
    .filter(
      (entry) =>
        !preservedReadFilePaths.has(
          normalizePostCompactReadStatePath(entry.path, input.workingDirectory),
        ),
    )
    .sort((left, right) => right.readAt.getTime() - left.readAt.getTime());

  for (const entry of candidates) {
    if (selected.length >= maxFiles) break;

    const approxTokens = Math.ceil(entry.content.length / ESTIMATED_TOKEN_CHAR_DIVISOR);
    if (approxTokens > maxFileApproxTokens) {
      selected.push(buildPostCompactReadStateEntry(formatCompactFileReference(entry)));
      continue;
    }
    if (totalApproxTokens + approxTokens > maxTotalApproxTokens) {
      selected.push(buildPostCompactReadStateEntry(formatCompactFileReference(entry)));
      continue;
    }

    totalApproxTokens += approxTokens;
    selected.push(buildPostCompactReadStateEntry(formatReadStateProjection(entry)));
    contentProjectedPaths.add(
      normalizePostCompactReadStatePath(entry.path, input.workingDirectory),
    );
  }

  return { contentProjectedPaths, entries: selected };
}

export function buildPostCompactReadStateReminderEntries(input: {
  maxFileApproxTokens?: number;
  maxFiles?: number;
  maxTotalApproxTokens?: number;
  preservedEntries?: readonly RuntimeMessageEntry[];
  readFileState?: ReadFileStateMap;
  workingDirectory?: string;
}): RuntimeMessageEntry[] {
  return selectPostCompactReadStateReminders(input).entries;
}

/**
 * 压缩收尾按「模型可见」口径修剪已读状态（specs/post-compact-read-state.md R1）：
 * preserved tail 的 Read/Write/Edit 目标 ∪ 内容投影文件保留，其余清除。
 * 保留条目不跳过写前 stale 守卫（R2），因此不会放行脏写。
 */
export function pruneReadFileStateAfterCompact(input: {
  contentProjectedPaths?: ReadonlySet<string>;
  preservedEntries?: readonly RuntimeMessageEntry[];
  readFileState: ReadFileStateMap;
  workingDirectory?: string;
}): { removedCount: number; retainedCount: number } {
  const retained = new Set<string>(input.contentProjectedPaths ?? []);
  for (const preservedPath of collectPreservedEditToolFilePaths(
    input.preservedEntries ?? [],
    input.workingDirectory,
  )) {
    retained.add(preservedPath);
  }

  let removedCount = 0;
  let retainedCount = 0;
  for (const [key, entry] of input.readFileState) {
    if (retained.has(normalizePostCompactReadStatePath(entry.path, input.workingDirectory))) {
      retainedCount++;
      continue;
    }
    input.readFileState.delete(key);
    removedCount++;
  }
  return { removedCount, retainedCount };
}

function buildPostCompactReadStateEntry(content: string): RuntimeMessageEntry {
  return systemReminderAttachmentEntry("resume_referenced_session_context", content);
}

function formatCompactFileReference(entry: ReadFileStateEntry): string {
  return `Note: ${entry.path} was read before the last conversation was summarized, but the contents are too large to include. Use Read tool if you need to access it.`;
}

function formatReadStateProjection(entry: ReadFileStateEntry): string {
  const content = addReadLineNumbers(entry.content, readStateStartLine(entry.offset));
  return [
    `Called the Read tool with the following input: ${formatFileStateInput(entry)}`,
    "Result of calling the Read tool:",
    content,
  ].join("\n");
}

function isPostCompactReadReminderCandidate(entry: ReadFileStateEntry): boolean {
  return entry.sourceTool === undefined || entry.sourceTool === "Read";
}

function collectPreservedEditToolFilePaths(
  entries: readonly RuntimeMessageEntry[],
  workingDirectory?: string,
): Set<string> {
  const paths = new Set<string>();
  for (const entry of entries) {
    if (!("message" in entry)) continue;
    if (entry.message.role !== "assistant" || !entry.message.toolCalls) continue;
    for (const toolCall of entry.message.toolCalls) {
      if (!PRESERVED_EDIT_TOOL_NAMES.has(toolCall.name)) continue;
      const filePath = readToolCallFilePath(toolCall.input);
      if (filePath) paths.add(normalizePostCompactReadStatePath(filePath, workingDirectory));
    }
  }
  return paths;
}

function readToolCallFilePath(input: unknown): string | undefined {
  if (input === null || typeof input !== "object") return undefined;
  const filePath = (input as { file_path?: unknown }).file_path;
  return typeof filePath === "string" && filePath.length > 0 ? filePath : undefined;
}

function formatFileStateInput(entry: ReadFileStateEntry): string {
  return JSON.stringify({
    file_path: entry.path,
    ...(entry.offset === undefined ? {} : { offset: entry.offset }),
    ...(entry.limit === undefined ? {} : { limit: entry.limit }),
  });
}

function readStateStartLine(offset: number | undefined): number {
  if (offset === 0) return 0;
  if (offset !== undefined && offset > 1) return Math.trunc(offset);
  return 1;
}

function addReadLineNumbers(content: string, startLine: number): string {
  return content
    .split(/\r?\n/)
    .map((line, index) => `${index + startLine}\t${line}`)
    .join("\n");
}

function shouldSkipPostCompactReadStatePath(filePath: string): boolean {
  return normalizePostCompactReadStatePath(filePath).replace(/\\/g, "/").includes("/.git/");
}

/** 与 readFileState 键同一归一化所有者（tool/path-normalization.ts），相对路径按工作目录解析。 */
function normalizePostCompactReadStatePath(filePath: string, workingDirectory?: string): string {
  const absolute =
    workingDirectory !== undefined && !isAbsolute(filePath)
      ? resolve(workingDirectory, filePath)
      : filePath;
  return normalizeToolPathForComparison(absolute);
}
