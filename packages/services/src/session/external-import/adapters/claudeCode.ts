import type { ClaudeNativeImportedSessionSource } from "#src/session/claude-native/claudeNativeImportedSessionTypes.js";
import { claudeNativeSessionImportRepo } from "#src/session/claude-native/claudeNativeSessionImportRepo.js";
import { parseClaudeNativeSessionFile } from "#src/session/claude-native/claudeNativeSessionImportParser.js";
import { IMPORTED_TASK_ID_PREFIXES } from "#src/session/external-import/importTaskFile.js";
import { assertValidImportPathSegment } from "#src/session/external-import/pathSegmentGuard.js";
import type {
  ExternalSessionRecord,
  ExternalSessionSourceAdapter,
} from "#src/session/external-import/types.js";

/**
 * "claude-code" adapter：既有 claude-native 链路的零行为变化包装（spec 红线）。
 *
 * - 发现：透传 claudeNativeSessionImportRepo.scanImportableSessions（workspace 过滤、
 *   worktree 排除、head 扫描语义全部不变）；
 * - 解析：repo.findImportableSession + parseClaudeNativeSessionFile，与
 *   claudeNativeSessionImportService 相同的调用形态；解析产物以 native 字段原样透传，
 *   下游 buildImportedClaudeTaskFile / persistImportedClaudeTask 一行不改。
 */
export const claudeCodeExternalSessionAdapter: ExternalSessionSourceAdapter = {
  source: "claude-code",
  importedTaskIdPrefix: IMPORTED_TASK_ID_PREFIXES["claude-code"],

  async discoverSessions(params) {
    const candidates = await claudeNativeSessionImportRepo.scanImportableSessions({
      workspacePath: params.workspacePath,
      modifiedSince: params.sinceTs,
      limit: params.limit,
    });
    return candidates.map((candidate) => ({
      source: "claude-code" as const,
      sourceSessionId: candidate.sessionId,
      cwd: candidate.workspacePath,
      projectHint: candidate.workspacePath,
      lastActivityTs: candidate.updatedAt,
      // 既有 repo 发现阶段只做 16 行 head 扫描，不产出消息计数；0 表示未估算。
      messageCountEstimate: 0,
      sourcePath: candidate.sourcePath,
      ...(candidate.previewTitle ? { title: candidate.previewTitle } : {}),
    }));
  },

  async parseSession(ref) {
    // 路径穿越防线在 adapter 边界统一生效，claude-code 也不例外（R2）。
    assertValidImportPathSegment(ref.sourceSessionId, "sourceSessionId");

    const candidate = await claudeNativeSessionImportRepo.findImportableSession({
      sessionId: ref.sourceSessionId,
    });
    if (!candidate) {
      if (!ref.sourcePath) {
        throw new Error(`[external-import] claude-code session 未找到: ${ref.sourceSessionId}`);
      }
      // 编排层已携带 sourcePath 的直读路径（如测试桩）：workspace 交由 jsonl 内 cwd 检测，
      // 与既有解析器的 workspacePath 兜底语义一致。
      const native = await parseClaudeNativeSessionFile({
        filePath: ref.sourcePath,
        workspacePath: "",
        sessionId: ref.sourceSessionId,
        sourcePath: ref.sourcePath,
      });
      return buildClaudeCodeRecord(ref.sourceSessionId, ref.sourcePath, native);
    }

    const native = await parseClaudeNativeSessionFile({
      filePath: candidate.sourcePath,
      workspacePath: candidate.workspacePath,
      sessionId: ref.sourceSessionId,
      sourcePath: candidate.sourcePath,
      ...(candidate.createdAt ? { fallbackCreatedAt: candidate.createdAt } : {}),
      ...(candidate.updatedAt ? { fallbackUpdatedAt: candidate.updatedAt } : {}),
    });
    return buildClaudeCodeRecord(ref.sourceSessionId, candidate.sourcePath, native);
  },
};

function buildClaudeCodeRecord(
  sourceSessionId: string,
  sourcePath: string,
  native: ClaudeNativeImportedSessionSource,
): ExternalSessionRecord {
  return {
    source: "claude-code",
    sourceSessionId,
    importedTaskIdPrefix: IMPORTED_TASK_ID_PREFIXES["claude-code"],
    cwd: native.workspacePath,
    startedAtTs: native.createdAt,
    lastActivityTs: native.updatedAt,
    title: native.title,
    ...(native.model ? { model: native.model } : {}),
    messages: native.messages.map((message) => ({
      role: message.role,
      content: message.content,
      ts: message.timestamp,
      ...(message.model ? { model: message.model } : {}),
    })),
    parseStats: {
      skippedLines: 0,
      skippedLinesOverSize: 0,
      skippedLinesMalformed: 0,
      skippedLinesTooDeep: 0,
      skippedLinesNonObject: 0,
      truncatedFields: 0,
      droppedMessagesInvalidRole: 0,
      unknownEventTypeCount: 0,
      knownNonMessageEventCount: 0,
    },
    sourcePath,
    // 关键：原生解析产物原样透传，保证下游 claude 落库链路逐字节兼容。
    native,
  };
}
