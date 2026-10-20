// ============================================================
// Write Tool — 已存在文件的写前新鲜度守卫
// ============================================================
// 从 write.ts 整体迁出：架构 legacy ratchet 对 write.ts 有 max-file-lines 400 上限，
// partial-view 文案分支（specs/post-compact-read-state.md R3）使其超限。守卫语义
// 逐行未变，仅换文件；write.ts 的其余流程（新建文件、落盘、状态回写）不动。

import { CoreErrorType, createCoreError, type FileSystemReadTextResult } from "@acode/contracts";
import { findLatestReadFileState, normalizeReadFileStateMtimeMs } from "../read-file-state.js";
import type { ReadFileStateEntry, ReadFileStateMap } from "../types.js";

const WRITE_NOT_READ_MESSAGE = "File has not been read yet. Read it first before writing to it.";
// partial view（token 上限截断的 Read）与「从未读过」区分文案（specs/post-compact-read-state.md R3）。
// Write 整文件覆盖，恢复动作是完整重读而非读范围。
const WRITE_PARTIAL_VIEW_MESSAGE =
  "File was read with a truncated view, so its full contents are not in your context. Read the full file before overwriting it.";
const WRITE_STALE_MESSAGE =
  "File has been modified since read, either by the user or by a linter. Read it again before attempting to write to it.";

export function assertWritableExistingFileIsFresh(
  filePath: string,
  currentRead: FileSystemReadTextResult,
  readFileState: ReadFileStateMap | undefined,
): void {
  const lastRead = findLatestReadFileState(readFileState, filePath);
  if (!lastRead) {
    throw createCoreError(CoreErrorType.ToolExecutionFailed, WRITE_NOT_READ_MESSAGE, {
      context: {
        code: "write_file_not_read",
        filePath,
      },
      recoverable: true,
    });
  }
  if (lastRead.isPartialView) {
    throw createCoreError(CoreErrorType.ToolExecutionFailed, WRITE_PARTIAL_VIEW_MESSAGE, {
      context: {
        // 契约预留码（contracts WriteErrorCode.PARTIAL_READ），此前未接线。
        code: "write_partial_read",
        filePath,
      },
      recoverable: true,
    });
  }

  if (!hasReadStateChanged(lastRead, currentRead)) return;
  if (isStrictFullRead(lastRead) && lastRead.content === currentRead.content) return;

  throw createCoreError(CoreErrorType.ToolExecutionFailed, WRITE_STALE_MESSAGE, {
    context: {
      code: "write_file_stale",
      filePath,
    },
    recoverable: true,
  });
}

function hasReadStateChanged(
  lastRead: ReadFileStateEntry,
  currentRead: FileSystemReadTextResult,
): boolean {
  const currentRevisionId = currentRead.revision?.id;
  if (lastRead.revisionId && currentRevisionId && lastRead.revisionId !== currentRevisionId) {
    return true;
  }

  const currentMtimeMs = currentRead.revision?.mtimeMs;
  if (lastRead.mtimeMs !== undefined && currentMtimeMs !== undefined) {
    // 让已确认内容未变的 Write 被误判为 stale。
    const normalizedCurrentMtimeMs = normalizeReadFileStateMtimeMs(currentMtimeMs);
    const normalizedLastReadMtimeMs = normalizeReadFileStateMtimeMs(lastRead.mtimeMs);
    const mtimeAdvanced =
      normalizedCurrentMtimeMs !== undefined &&
      normalizedLastReadMtimeMs !== undefined &&
      normalizedCurrentMtimeMs > normalizedLastReadMtimeMs;
    return mtimeAdvanced || lastRead.sizeBytes !== currentRead.sizeBytes;
  }

  if (lastRead.sizeBytes !== undefined && lastRead.sizeBytes !== currentRead.sizeBytes) {
    return true;
  }

  return isStrictFullRead(lastRead) && lastRead.content !== currentRead.content;
}

function isStrictFullRead(entry: ReadFileStateEntry): boolean {
  if (entry.isPartialView) return false;
  return (entry.offset ?? 1) <= 1 && entry.limit === undefined;
}
