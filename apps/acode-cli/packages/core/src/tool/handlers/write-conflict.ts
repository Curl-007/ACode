// conflict:// 解决分支的 handler 粘合层（specs/conflict-uri-resolution.md R5/R6）。
// 门面纯逻辑在 ../conflict/index.ts；本文件只做 handler 契约适配：错误映射为
// ToolExecutionFailed(recoverable)、写后状态回写（readFileState 同 write.ts 口径）、
// 输出信封组装（真实路径 structuredPatch——UI 直接渲染冲突解决的 diff）。
import {
  CoreErrorType,
  createCoreError,
  type FileSystemPort,
  type FileSystemReadTextResult,
  type TraceContext,
} from "@acode/contracts";
import { createStructuredPatch } from "../diff.js";
import {
  ConflictUriError,
  listSessionConflicts,
  resolveConflictWrite,
} from "../conflict/index.js";
import type { ToolExecutionContext } from "../types.js";

export { isConflictUri } from "../conflict/index.js";

export interface ConflictWriteToolCallInput {
  rawUri: string;
  content: string;
  context: ToolExecutionContext;
  fileSystemPort: FileSystemPort;
  createTrace: () => TraceContext;
  afterWrite: (
    filePath: string,
    contentLf: string,
    revision: FileSystemReadTextResult["revision"],
  ) => void;
}

export async function resolveConflictWriteToolCall(input: ConflictWriteToolCallInput) {
  let outcome;
  try {
    outcome = await resolveConflictWrite({
      sessionId: input.context.sessionId,
      rawUri: input.rawUri,
      content: input.content,
      fileSystemPort: input.fileSystemPort,
      abortSignal: input.context.abortSignal,
      createTrace: input.createTrace,
      afterWrite: (filePath, contentLf, revision) => {
        input.afterWrite(
          filePath,
          contentLf,
          revision as FileSystemReadTextResult["revision"],
        );
      },
    });
  } catch (error) {
    if (error instanceof ConflictUriError) {
      // 业务性拒绝（未注册 id/stale/批量形态歧义等）→ 模型可自纠。
      throw createCoreError(CoreErrorType.ToolExecutionFailed, error.message, {
        context: { toolCallId: input.context.toolCallId, toolName: "Write" },
        recoverable: true,
      });
    }
    throw error;
  }

  const primary = outcome.files[0]!;
  const sessionRemaining = input.context.sessionId
    ? listSessionConflicts(input.context.sessionId).length
    : 0;
  return {
    type: "update" as const,
    // 信封 filePath 用真实路径（UI diff 渲染与审批可见面都拿真实文件）。
    filePath: primary.path,
    content: primary.newContent,
    structuredPatch: createStructuredPatch({
      filePath: primary.path,
      oldContent: primary.oldContent,
      newContent: primary.newContent,
    }),
    originalFile: primary.oldContent,
    userModified: false,
    conflictResolution: {
      resolvedIds: outcome.files.flatMap((file) => file.splicedIds),
      extraFiles: outcome.files.slice(1).map((file) => file.path),
      sessionRemaining,
    },
  };
}
