import type { MessageId, MessagePart, MessageWithParts, ToolPart } from "@acode/contracts";
import {
  parseReadFileStateMetadata,
  type PersistedReadFileStateMetadata,
  type PersistedReadFileStateTool,
} from "../tool/read-file-state-metadata.js";
import { createReadFileStateKey, normalizeReadFileStateMtimeMs } from "../tool/read-file-state.js";
import type { ReadFileStateMap } from "../tool/types.js";
import { activeSessionMessages } from "./session-history-hydrator.js";

export interface ReadFileStateHydrationResult {
  restoredCount: number;
  skippedRangeReadCount: number;
  skippedUnreadableEditCount: number;
}

type CompletedToolPart = ToolPart & {
  state: ToolPart["state"] & {
    output: unknown;
    status: "completed";
  };
};

export async function hydrateReadFileStateFromSession(input: {
  branchCutAfterMessageId?: MessageId;
  messages: MessageWithParts[];
  readFileState: ReadFileStateMap;
  rewindCreatedMessageId?: MessageId;
  rewindKeptMessageIds?: readonly MessageId[];
  rewindTargetMessageId?: MessageId;
  workingDirectory: string;
  workspaceRoot: string;
}): Promise<ReadFileStateHydrationResult> {
  input.readFileState.clear();
  const activeMessages = activeSessionMessages(input.messages, {
    branchCutAfterMessageId: input.branchCutAfterMessageId,
    // 镜像 live 压缩的修剪口径（specs/post-compact-read-state.md R5）：preserved tail
    // 里的 Read/Write/Edit 在 resume 后仍对模型可见，状态必须同步恢复；排除它们会让
    // Edit 对上下文里看得见的读取误报 FILE_NOT_READ（与 live 压缩清空同类的判定缺陷）。
    includeCompactPreservedSegment: true,
    rewindCreatedMessageId: input.rewindCreatedMessageId,
    rewindKeptMessageIds: input.rewindKeptMessageIds,
    rewindTargetMessageId: input.rewindTargetMessageId,
  });

  const result: ReadFileStateHydrationResult = {
    restoredCount: 0,
    skippedRangeReadCount: 0,
    skippedUnreadableEditCount: 0,
  };

  for (const message of activeMessages) {
    if (message.info.role !== "assistant") continue;

    for (const part of dedupeParts(message.parts)) {
      if (!isCompletedToolPart(part)) continue;

      if (part.tool === "Read") {
        const restored = restoreReadToolState(input, part, result);
        if (restored) result.restoredCount++;
        continue;
      }

      if (part.tool === "Write") {
        const restored = restoreMetadataToolState(input.readFileState, part, "Write");
        if (restored) result.restoredCount++;
        continue;
      }

      if (part.tool === "Edit") {
        const restored = restoreMetadataToolState(input.readFileState, part, "Edit");
        if (restored) result.restoredCount++;
        continue;
      }

      // ApplyPatch 多文件、metadata 单槽位：只恢复最后写入的文件（其余退回未读态，
      // 保守 fail-safe；见 read-file-state-metadata.ts 的 PersistedReadFileStateTool 注释）。
      if (part.tool === "ApplyPatch") {
        const restored = restoreMetadataToolState(input.readFileState, part, "ApplyPatch");
        if (restored) result.restoredCount++;
        continue;
      }

      // 内联草稿：模型亲手写的字节，与 Write 同一条恢复路径。不带 metadata 的 part（saved 拷贝、
      // `path` 提交、沿用的脚本）在 restoreMetadataToolState 里自然落空。
      if (part.tool === "CreateWorkflow" || part.tool === "AmendWorkflow") {
        const restored = restoreMetadataToolState(input.readFileState, part, part.tool);
        if (restored) result.restoredCount++;
      }
    }
  }

  return result;
}

function restoreReadToolState(
  input: {
    readFileState: ReadFileStateMap;
  },
  part: CompletedToolPart,
  result: ReadFileStateHydrationResult,
): boolean {
  const metadata = parseReadFileStateMetadata(part.state.metadata);
  if (!metadata) {
    // 无结构化 metadata 的历史读取不能恢复（stale 守卫缺 freshness 依据）；
    // range 窗口入参的读取单独计数，保留 resume 日志口径。
    if (isRangeReadToolInput(part.state.input)) result.skippedRangeReadCount++;
    return false;
  }
  if (metadata.tool !== "Read") return false;
  // metadata 自带窗口与 isPartialView（read-file-state-metadata.ts），range/partial
  // 视图原样恢复，与 live 状态表同口径（specs/post-compact-read-state.md R5）。
  setRestoredReadState(input.readFileState, metadata);
  return true;
}

function isRangeReadToolInput(toolInput: unknown): boolean {
  const record = asRecord(toolInput);
  if (!record) return false;
  const offset = typeof record.offset === "number" ? record.offset : 1;
  return offset > 1 || typeof record.limit === "number";
}

function restoreMetadataToolState(
  readFileState: ReadFileStateMap,
  part: CompletedToolPart,
  expectedTool: PersistedReadFileStateTool,
): boolean {
  const metadata = parseReadFileStateMetadata(part.state.metadata);
  if (!metadata || metadata.tool !== expectedTool) return false;

  // Write/Edit 的历史 tool part 不能在 resume 时读取当前磁盘来“补全”状态；
  // 外部手动保存会被误认证为 agent 已读。这里只恢复成功时持久化的完整快照。
  setRestoredReadState(readFileState, metadata);
  return true;
}

function setRestoredReadState(
  readFileState: ReadFileStateMap,
  metadata: PersistedReadFileStateMetadata,
): void {
  readFileState.set(createReadFileStateKey(metadata.path, metadata.offset, metadata.limit), {
    path: metadata.path,
    content: metadata.content,
    offset: metadata.offset,
    limit: metadata.limit,
    isPartialView: metadata.isPartialView,
    readAt: new Date(metadata.readAtMs),
    sourceTool: metadata.tool,
    revisionId: metadata.revisionId,
    mtimeMs: normalizeReadFileStateMtimeMs(metadata.mtimeMs),
    sizeBytes: metadata.sizeBytes,
  });
}

function dedupeParts(parts: MessagePart[]): MessagePart[] {
  const byId = new Map<string, MessagePart>();
  for (const part of parts) {
    byId.set(part.id, part);
  }
  return [...byId.values()];
}

function isCompletedToolPart(part: MessagePart): part is CompletedToolPart {
  return part.type === "tool" && part.state.status === "completed" && "output" in part.state;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}
