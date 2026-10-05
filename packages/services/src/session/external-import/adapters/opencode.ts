import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { readdir } from "node:fs/promises";
import { isObjectRecord, readTrimmedString } from "#src/session/claude-native/jsonLineRecord.js";
import { collectFilesRecursive, readFileMtimeMs, resolveExternalImportRootDir } from "#src/session/external-import/adapterFs.js";
import { readExternalTimestampMs, readGuardedJsonFile } from "#src/session/external-import/importGuards.js";
import { IMPORTED_TASK_ID_PREFIXES } from "#src/session/external-import/importTaskFile.js";
import { assertValidImportPathSegment, isValidImportPathSegment } from "#src/session/external-import/pathSegmentGuard.js";
import { deriveSessionTitle } from "#src/session/sessionTitle.js";
import type {
  ExternalMessageRecord,
  ExternalSessionParseStats,
  ExternalSessionRecord,
  ExternalSessionSourceAdapter,
  ExternalSessionSummary,
  ExternalToolCallSummary,
} from "#src/session/external-import/types.js";

/** 测试桩用根目录覆盖（R1）；缺省 ~/.local/share/opencode/storage。 */
export const OPENCODE_STORAGE_DIR_ENV = "ACODE_IMPORT_OPENCODE_STORAGE_DIR";

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

interface OpenCodeParsedPart {
  text?: string;
  tools: ExternalToolCallSummary[];
}

function readOpenCodePartObject(part: unknown, parseStats: ExternalSessionParseStats): OpenCodeParsedPart {
  if (!isObjectRecord(part)) {
    return { tools: [] };
  }
  const type = readTrimmedString(part.type);
  if (type === "text") {
    return { text: readTrimmedString(part.text) ?? "", tools: [] };
  }
  if (type === "tool" || type === "tool_call" || type === "step-start") {
    const toolName = readTrimmedString(part.tool) ?? readTrimmedString(part.name) ?? "tool";
    return { tools: [{ toolName }] };
  }
  // reasoning/file/image 等已知但不导入的 part 类型。
  if (type) {
    parseStats.knownNonMessageEventCount += 1;
    return { tools: [] };
  }
  parseStats.unknownEventTypeCount += 1;
  return { tools: [] };
}

async function readOpenCodeMessageParts(
  ownerDir: string,
  messageId: string,
  partsField: unknown,
  parseStats: ExternalSessionParseStats,
): Promise<OpenCodeParsedPart> {
  if (!Array.isArray(partsField)) {
    return { tools: [] };
  }
  // F1（批次 C 对抗复核）：messageId 来自外部 value.id 且参与拼路径，拼路径前必须
  // 过路径段守卫；恶意 "../" 形态按会话级解析失败拒绝（importService 逐会话隔离，
  // 不拖垮整轮导入）。
  assertValidImportPathSegment(messageId, "opencode messageId");
  const texts: string[] = [];
  const tools: ExternalToolCallSummary[] = [];
  for (const entry of partsField) {
    if (typeof entry === "string") {
      // 旧版布局：parts 存 partId 列表，内容在 part/<messageId>/<partId>.json。
      // F1：entry 是外部 parts 数组里的任意字符串，"../"、绝对路径、"..\\" 形态
      // 一律按 entry 级丢弃计数，不读 ownerDir 之外的任何文件，也不让单条
      // 恶意 part 拖垮整个会话导入。
      if (!isValidImportPathSegment(entry)) {
        parseStats.skippedLinesMalformed += 1;
        continue;
      }
      const partPath = join(ownerDir, "part", messageId, `${entry}.json`);
      // F1 双层防御：即使通过了段守卫，也断言解析后的绝对路径仍落在 ownerDir 之内
      // （relative 结果不以 ".." 开头且非绝对），任何越界形态同样按 entry 级丢弃。
      const partRelative = relative(ownerDir, resolve(partPath));
      if (partRelative.startsWith("..") || isAbsolute(partRelative)) {
        parseStats.skippedLinesMalformed += 1;
        continue;
      }
      const parsed = await readGuardedJsonFile(partPath);
      if (!parsed.ok) {
        parseStats.skippedLinesMalformed += 1;
        continue;
      }
      const projected = readOpenCodePartObject(parsed.value, parseStats);
      if (projected.text) {
        texts.push(projected.text);
      }
      tools.push(...projected.tools);
      continue;
    }
    // 新版布局：parts 内联对象。
    const projected = readOpenCodePartObject(entry, parseStats);
    if (projected.text) {
      texts.push(projected.text);
    }
    tools.push(...projected.tools);
  }
  return { text: texts.join("\n\n"), tools };
}

/**
 * opencode adapter（~/.local/share/opencode/storage/）。
 * 布局：<owner>/session/<id>.json + <owner>/message/<sessionId>/<messageId>.json
 * +（可选）<owner>/part/<messageId>/<partId>.json。本机 storage 仅 tui-state，
 * 无 session/message 真实样本（spec 附录已登记），fixture 按 jcode 时期形态自造。
 */
export const opencodeExternalSessionAdapter: ExternalSessionSourceAdapter = {
  source: "opencode",
  importedTaskIdPrefix: IMPORTED_TASK_ID_PREFIXES.opencode,

  async discoverSessions(params) {
    const rootDir = resolveExternalImportRootDir(
      OPENCODE_STORAGE_DIR_ENV,
      join(homedir(), ".local", "share", "opencode", "storage"),
    );
    const files = await collectFilesRecursive(rootDir, (name) => name.endsWith(".json"), 3);
    const summaries: ExternalSessionSummary[] = [];
    for (const filePath of files) {
      if (basename(dirname(filePath)) !== "session") {
        continue;
      }
      const mtimeMs = await readFileMtimeMs(filePath);
      if (mtimeMs === null) {
        continue;
      }
      if (params.sinceTs !== undefined && mtimeMs < params.sinceTs) {
        continue;
      }
      const sessionId = basename(filePath, ".json");
      if (!sessionId) {
        continue;
      }
      const parsed = await readGuardedJsonFile(filePath);
      const sessionValue = parsed.ok && isObjectRecord(parsed.value) ? parsed.value : undefined;
      const time = isObjectRecord(sessionValue?.time) ? sessionValue.time : undefined;
      const cwd = readTrimmedString(sessionValue?.cwd) ?? readTrimmedString(sessionValue?.directory);
      summaries.push({
        source: "opencode",
        sourceSessionId: sessionId,
        cwd,
        projectHint: cwd,
        lastActivityTs:
          readExternalTimestampMs(time?.end) ??
          readExternalTimestampMs(time?.updated) ??
          mtimeMs,
        messageCountEstimate: 0,
        sourcePath: filePath,
        ...(readTrimmedString(sessionValue?.title) ? { title: readTrimmedString(sessionValue?.title) } : {}),
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
      throw new Error(`[external-import] opencode session 未找到: ${ref.sourceSessionId}`);
    }

    const sessionParsed = await readGuardedJsonFile(sourcePath);
    if (!sessionParsed.ok) {
      throw new Error(`[external-import] opencode session 文件不可解析: ${sourcePath} (${sessionParsed.reason})`);
    }
    const sessionValue = isObjectRecord(sessionParsed.value) ? sessionParsed.value : undefined;
    const parseStats = { ...emptyParseStats(), truncatedFields: sessionParsed.stats.truncatedFields };
    const time = isObjectRecord(sessionValue?.time) ? sessionValue.time : undefined;
    const cwd = readTrimmedString(sessionValue?.cwd) ?? readTrimmedString(sessionValue?.directory);
    // <owner>/session/<id>.json → <owner>/message/<id>/
    const ownerDir = dirname(dirname(sourcePath));
    const messageDir = join(ownerDir, "message", ref.sourceSessionId);

    let messageFiles: string[] = [];
    try {
      messageFiles = (await readdir(messageDir)).filter((name) => name.endsWith(".json"));
    } catch {
      messageFiles = [];
    }
    messageFiles.sort();

    const messages: ExternalMessageRecord[] = [];
    let model: string | undefined;
    for (const messageFile of messageFiles) {
      const parsed = await readGuardedJsonFile(join(messageDir, messageFile));
      if (!parsed.ok) {
        // 单条消息损坏只跳过该条，不放弃整个 session（R6 解析失败范围最小化）。
        parseStats.skippedLinesMalformed += 1;
        continue;
      }
      const value = isObjectRecord(parsed.value) ? parsed.value : undefined;
      if (!value) {
        parseStats.skippedLinesNonObject += 1;
        continue;
      }
      const role = readTrimmedString(value.role);
      if (role !== "user" && role !== "assistant") {
        parseStats.droppedMessagesInvalidRole += 1;
        continue;
      }
      model ??= readTrimmedString(value.model);
      const messageId = readTrimmedString(value.id) ?? basename(messageFile, ".json");
      const projected = await readOpenCodeMessageParts(ownerDir, messageId, value.parts, parseStats);
      if (!projected.text && projected.tools.length === 0) {
        parseStats.knownNonMessageEventCount += 1;
        continue;
      }
      const messageTime = isObjectRecord(value.time) ? value.time : undefined;
      const ts = readExternalTimestampMs(
        messageTime?.start ?? messageTime?.created ?? messageTime?.end,
      );
      messages.push({
        role,
        content: projected.text || `[tool] ${projected.tools.map((tool) => tool.toolName).join(", ")}`,
        ...(ts ? { ts } : {}),
        ...(role === "assistant" && model ? { model } : {}),
        ...(projected.tools.length > 0 ? { toolCallSummaries: projected.tools } : {}),
      });
    }

    messages.sort((left, right) => (left.ts ?? 0) - (right.ts ?? 0));
    const firstUser = messages.find((message) => message.role === "user");
    return {
      source: "opencode",
      sourceSessionId: ref.sourceSessionId,
      importedTaskIdPrefix: IMPORTED_TASK_ID_PREFIXES.opencode,
      cwd,
      startedAtTs:
        readExternalTimestampMs(time?.start) ??
        readExternalTimestampMs(time?.created) ??
        messages[0]?.ts,
      lastActivityTs:
        readExternalTimestampMs(time?.end) ??
        readExternalTimestampMs(time?.updated) ??
        messages[messages.length - 1]?.ts,
      ...(readTrimmedString(sessionValue?.title)
        ? { title: readTrimmedString(sessionValue?.title) }
        : firstUser
          ? { title: deriveSessionTitle(firstUser.content, []) }
          : {}),
      ...(model ? { model } : {}),
      messages,
      parseStats,
      sourcePath,
    } satisfies ExternalSessionRecord;
  },
};
