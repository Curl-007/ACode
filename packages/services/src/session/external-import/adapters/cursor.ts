import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { isObjectRecord, readTrimmedString } from "#src/session/claude-native/jsonLineRecord.js";
import { collectFilesRecursive, readFileMtimeMs, resolveExternalImportRootDir } from "#src/session/external-import/adapterFs.js";
import {
  readExternalTimestampMs,
  readGuardedJsonLinesFile,
  readGuardedJsonLinesFileHead,
} from "#src/session/external-import/importGuards.js";
import { IMPORTED_TASK_ID_PREFIXES } from "#src/session/external-import/importTaskFile.js";
import { assertValidImportPathSegment } from "#src/session/external-import/pathSegmentGuard.js";
import { deriveSessionTitle } from "#src/session/sessionTitle.js";
import type {
  ExternalMessageRecord,
  ExternalSessionParseStats,
  ExternalSessionRecord,
  ExternalSessionSourceAdapter,
  ExternalSessionSummary,
  ExternalToolCallSummary,
} from "#src/session/external-import/types.js";

/** 测试桩用根目录覆盖（R1）；缺省 ~/.cursor/projects。 */
export const CURSOR_PROJECTS_DIR_ENV = "ACODE_IMPORT_CURSOR_PROJECTS_DIR";

/** subagent 拍平前缀（R5）。 */
export const CURSOR_SUBAGENT_SEGMENT_LABEL = "[subagent]";

/** 已知但不导入的 transcript 条目类型。 */
const KNOWN_CURSOR_NON_MESSAGE_TYPES = new Set([
  "summary",
  "file",
  "thinking",
  "reasoning",
  "tool",
  "progress",
  "error",
  "usage",
]);

/** 白名单外的伪 role（R2：丢弃并计数）。 */
const CURSOR_PSEUDO_ROLE_TYPES = new Set(["system", "developer", "function"]);

function emptyParseStats(): ExternalSessionParseStats {
  return {
    skippedLines: 0,
    skippedLinesOverSize: 0,
    skippedLinesMalformed: 0,
    skippedLinesTooDeep: 0,
    skippedLinesNonObject: 0,
    truncatedFields: 0,
    droppedMessagesInvalidRole: 0,
    unknownEventTypeCount: 0,
    knownNonMessageEventCount: 0,
  };
}

/** cwd 解码结果的唯一合法形态：可打印的绝对路径（盘符/posix 根/UNC）。 */
function isPlausibleAbsoluteDirPath(value: string): boolean {
  if (value.length === 0 || value.length > 4096) {
    return false;
  }
  if (/\p{Cc}/u.test(value)) {
    return false;
  }
  return /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith("/") || value.startsWith("\\\\");
}

/**
 * Cursor 项目目录名 → cwd 解码（R5）。
 * 新版为 URL 百分号编码（c%3A%5CUsers%5C...），旧版为 base64；
 * 两种都失败时返回 decoded:false，调用方只能把原始目录名当 projectHint（不猜）。
 * 解码结果仅作 workspace 匹配提示，绝不进入任何写路径。
 */
export function decodeCursorProjectDirName(name: string): { cwd?: string; decoded: boolean } {
  if (name.includes("%")) {
    try {
      const decoded = decodeURIComponent(name);
      if (isPlausibleAbsoluteDirPath(decoded)) {
        return { cwd: decoded, decoded: true };
      }
    } catch {
      // 非法 % 序列按解码失败处理，进入 base64 分支。
    }
  }
  if (/^[A-Za-z0-9+/=_-]+$/u.test(name) && name.length >= 8) {
    const normalized = name.replaceAll("-", "+").replaceAll("_", "/");
    const buffer = Buffer.from(normalized, "base64");
    const text = buffer.toString("utf-8");
    // base64 解码几乎不会失败，必须靠结果校验兜底：只接受可打印绝对路径。
    if (isPlausibleAbsoluteDirPath(text)) {
      return { cwd: text, decoded: true };
    }
  }
  return { decoded: false };
}

function readCursorEntryRole(entry: Record<string, unknown>): "user" | "assistant" | undefined {
  // 显式 role 字段优先；type 字段只有在就是 user/assistant 时才当 role 用，
  // 其它类型值（summary/file/system/...）按事件分类处理，不混入伪 role 计数。
  const roleText = readTrimmedString(entry.role)?.toLowerCase();
  if (roleText === "user" || roleText === "assistant") {
    return roleText;
  }
  const typeText = readTrimmedString(entry.type)?.toLowerCase();
  if (typeText === "user" || typeText === "assistant") {
    return typeText;
  }
  return undefined;
}

function readCursorEntryContent(entry: Record<string, unknown>): string {
  const message = isObjectRecord(entry.message) ? entry.message : undefined;
  const candidates = [entry.content, message?.content, entry.text, message?.text];
  for (const candidate of candidates) {
    if (typeof candidate === "string") {
      const normalized = candidate.trim();
      if (normalized) {
        return normalized;
      }
      continue;
    }
    if (Array.isArray(candidate)) {
      const text = candidate
        .flatMap((item) => {
          if (typeof item === "string") {
            return item.trim() ? [item] : [];
          }
          if (!isObjectRecord(item)) {
            return [];
          }
          const partText = readTrimmedString(item.text) ?? readTrimmedString(item.content);
          return partText ? [partText] : [];
        })
        .join("\n\n");
      if (text) {
        return text;
      }
    }
  }
  return "";
}

function readCursorEntryTools(entry: Record<string, unknown>): ExternalToolCallSummary[] {
  const tools: ExternalToolCallSummary[] = [];
  const direct = readTrimmedString(entry.toolName) ?? readTrimmedString(entry.tool);
  if (direct) {
    tools.push({ toolName: direct });
  }
  const content = entry.content;
  if (Array.isArray(content)) {
    for (const item of content) {
      if (!isObjectRecord(item)) {
        continue;
      }
      const itemType = readTrimmedString(item.type)?.toLowerCase();
      if (itemType === "tool_use" || itemType === "tool") {
        const name = readTrimmedString(item.name) ?? readTrimmedString(item.toolName);
        if (name) {
          tools.push({ toolName: name });
        }
      }
    }
  }
  return tools;
}

function isCursorSubagentEntry(entry: Record<string, unknown>): boolean {
  if (entry.isSubagent === true || entry.subagent === true) {
    return true;
  }
  if (typeof entry.agentId === "string" && entry.agentId.trim().length > 0) {
    return true;
  }
  return readTrimmedString(entry.type)?.toLowerCase().includes("subagent") ?? false;
}

/**
 * Cursor adapter（~/.cursor/projects/<proj>/agent-transcripts/*.jsonl）。
 * 本机未安装 Cursor（spec 附录已登记），fixture 按 jcode 时期形态自造。
 */
export const cursorExternalSessionAdapter: ExternalSessionSourceAdapter = {
  source: "cursor",
  importedTaskIdPrefix: IMPORTED_TASK_ID_PREFIXES.cursor,

  async discoverSessions(params) {
    const rootDir = resolveExternalImportRootDir(
      CURSOR_PROJECTS_DIR_ENV,
      join(homedir(), ".cursor", "projects"),
    );
    const files = await collectFilesRecursive(
      rootDir,
      (name) => name.endsWith(".jsonl"),
      4,
    );
    const summaries: ExternalSessionSummary[] = [];
    for (const filePath of files) {
      if (basename(dirname(filePath)) !== "agent-transcripts") {
        continue;
      }
      const mtimeMs = await readFileMtimeMs(filePath);
      if (mtimeMs === null) {
        continue;
      }
      if (params.sinceTs !== undefined && mtimeMs < params.sinceTs) {
        continue;
      }
      const sessionId = basename(filePath, ".jsonl");
      if (!sessionId) {
        continue;
      }
      const projectName = basename(dirname(dirname(filePath)));
      const decoded = decodeCursorProjectDirName(projectName);
      const head = await readGuardedJsonLinesFileHead(filePath, 32);
      summaries.push({
        source: "cursor",
        sourceSessionId: sessionId,
        // 解码失败 → 原始目录名（R5：不猜）；成功 → cwd 仅作 workspace 匹配提示。
        cwd: decoded.cwd,
        projectHint: decoded.cwd ?? projectName,
        lastActivityTs: mtimeMs,
        messageCountEstimate: head.records.filter((record) => readCursorEntryRole(record) !== undefined)
          .length,
        sourcePath: filePath,
      });
    }
    summaries.sort((left, right) => right.lastActivityTs - left.lastActivityTs);
    return typeof params.limit === "number" && params.limit > 0
      ? summaries.slice(0, params.limit)
      : summaries;
  },

  async parseSession(ref) {
    assertValidImportPathSegment(ref.sourceSessionId, "sourceSessionId");
    let sourcePath = ref.sourcePath;
    if (!sourcePath) {
      const summary = (await this.discoverSessions({})).find(
        (item) => item.sourceSessionId === ref.sourceSessionId,
      );
      sourcePath = summary?.sourcePath;
    }
    if (!sourcePath) {
      throw new Error(`[external-import] cursor session 未找到: ${ref.sourceSessionId}`);
    }

    const { records, stats } = await readGuardedJsonLinesFile(sourcePath);
    const parseStats = { ...emptyParseStats(), ...stats };
    const messages: ExternalMessageRecord[] = [];
    const projectName = basename(dirname(dirname(sourcePath)));
    const decoded = decodeCursorProjectDirName(projectName);

    for (const entry of records) {
      const role = readCursorEntryRole(entry);
      if (!role) {
        const roleText = readTrimmedString(entry.role)?.toLowerCase();
        const typeText = readTrimmedString(entry.type)?.toLowerCase();
        if (roleText || (typeText && CURSOR_PSEUDO_ROLE_TYPES.has(typeText))) {
          // 伪 role（system/fake/developer 等）白名单外，丢弃计数（R2）。
          parseStats.droppedMessagesInvalidRole += 1;
        } else if (typeText && KNOWN_CURSOR_NON_MESSAGE_TYPES.has(typeText)) {
          parseStats.knownNonMessageEventCount += 1;
        } else {
          parseStats.unknownEventTypeCount += 1;
        }
        continue;
      }
      const content = readCursorEntryContent(entry);
      const toolCallSummaries = readCursorEntryTools(entry);
      if (!content && toolCallSummaries.length === 0) {
        parseStats.knownNonMessageEventCount += 1;
        continue;
      }
      const subagent = isCursorSubagentEntry(entry);
      const ts = readExternalTimestampMs(
        entry.timestamp ?? entry.createdAt ?? entry.time ?? entry.updatedAt,
      );
      messages.push({
        // subagent 段拍平为带标记的 assistant 消息（R5）：前缀直接进正文，
        // 导入层不还原子会话结构；segmentLabel 保留机器可读标记。
        role: subagent ? "assistant" : role,
        content: subagent ? `${CURSOR_SUBAGENT_SEGMENT_LABEL} ${content}` : content,
        ...(ts ? { ts } : {}),
        ...(subagent ? { segmentLabel: CURSOR_SUBAGENT_SEGMENT_LABEL } : {}),
        ...(toolCallSummaries.length > 0 ? { toolCallSummaries } : {}),
      });
    }

    parseStats.skippedLines =
      stats.skippedLinesOverSize +
      stats.skippedLinesMalformed +
      stats.skippedLinesTooDeep +
      stats.skippedLinesNonObject;

    const firstUser = messages.find((message) => message.role === "user");
    return {
      source: "cursor",
      sourceSessionId: ref.sourceSessionId,
      importedTaskIdPrefix: IMPORTED_TASK_ID_PREFIXES.cursor,
      cwd: decoded.cwd,
      startedAtTs: messages[0]?.ts,
      lastActivityTs: messages[messages.length - 1]?.ts,
      ...(firstUser ? { title: deriveSessionTitle(firstUser.content, []) } : {}),
      messages,
      parseStats,
      sourcePath,
    } satisfies ExternalSessionRecord;
  },
};
