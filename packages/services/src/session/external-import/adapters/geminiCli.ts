import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { isObjectRecord, readTrimmedString } from "#src/session/claude-native/jsonLineRecord.js";
import { collectFilesRecursive, readFileMtimeMs, resolveExternalImportRootDir } from "#src/session/external-import/adapterFs.js";
import { readExternalTimestampMs, readGuardedJsonFile } from "#src/session/external-import/importGuards.js";
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

/** 测试桩用根目录覆盖（R1）；缺省 ~/.gemini/tmp（布局 <hash>/chats/*.json）。 */
export const GEMINI_CLI_TMP_DIR_ENV = "ACODE_IMPORT_GEMINI_DIR";

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

/** Gemini CLI 的 role 形态：字符串 "user"，或对象 { model } / "model" 表示模型侧。 */
function readGeminiMessageRole(roleField: unknown): "user" | "assistant" | undefined {
  if (roleField === "user") {
    return "user";
  }
  if (roleField === "model" || roleField === "assistant") {
    return "assistant";
  }
  if (isObjectRecord(roleField) && readTrimmedString(roleField.model)) {
    return "assistant";
  }
  return undefined;
}

function readGeminiPartsText(parts: unknown): string {
  if (!Array.isArray(parts)) {
    return "";
  }
  return parts
    .flatMap((part) => {
      if (typeof part === "string") {
        return part.trim().length > 0 ? [part] : [];
      }
      if (!isObjectRecord(part)) {
        return [];
      }
      const text = readTrimmedString(part.text);
      return text ? [text] : [];
    })
    .join("\n\n");
}

function readGeminiToolCalls(parts: unknown): ExternalToolCallSummary[] {
  if (!Array.isArray(parts)) {
    return [];
  }
  const tools: ExternalToolCallSummary[] = [];
  for (const part of parts) {
    if (!isObjectRecord(part)) {
      continue;
    }
    const call = isObjectRecord(part.functionCall) ? part.functionCall : part.function_call;
    const name = isObjectRecord(call) ? readTrimmedString(call.name) : undefined;
    if (name) {
      tools.push({ toolName: name });
    }
  }
  return tools;
}

/**
 * Gemini CLI adapter（~/.gemini/tmp/<hash>/chats/*.json）。
 * 本机未安装 Gemini CLI（spec 附录已登记），fixture 按 jcode v0.89.2 时期形态自造：
 * 每文件一个 chat 对象，messages 数组内 role/message.parts 结构。
 */
export const geminiCliExternalSessionAdapter: ExternalSessionSourceAdapter = {
  source: "gemini-cli",
  importedTaskIdPrefix: IMPORTED_TASK_ID_PREFIXES["gemini-cli"],

  async discoverSessions(params) {
    const rootDir = resolveExternalImportRootDir(
      GEMINI_CLI_TMP_DIR_ENV,
      join(homedir(), ".gemini", "tmp"),
    );
    const files = await collectFilesRecursive(rootDir, (name) => name.endsWith(".json"), 4);
    const summaries: ExternalSessionSummary[] = [];
    for (const filePath of files) {
      // 只认 chats/ 子目录下的文件，tmp 下其它缓存目录不碰。
      if (basename(dirname(filePath)) !== "chats") {
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
      summaries.push({
        source: "gemini-cli",
        sourceSessionId: sessionId,
        // Gemini chats 文件不携带 cwd；workspace 匹配交给导入时的 workspacePath 参数。
        lastActivityTs: mtimeMs,
        messageCountEstimate: 0,
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
      throw new Error(`[external-import] gemini-cli session 未找到: ${ref.sourceSessionId}`);
    }

    const parsed = await readGuardedJsonFile(sourcePath);
    if (!parsed.ok) {
      // 损坏 JSON 文件无法部分导入（单对象形态），整会话记 failed，不拖垮其它会话。
      throw new Error(`[external-import] gemini-cli chat 文件不可解析: ${sourcePath} (${parsed.reason})`);
    }
    const parseStats = { ...emptyParseStats(), truncatedFields: parsed.stats.truncatedFields };
    const root = isObjectRecord(parsed.value) ? parsed.value : undefined;
    const rawMessages = Array.isArray(root?.messages) ? root.messages : [];
    const messages: ExternalMessageRecord[] = [];
    let model: string | undefined;

    for (const item of rawMessages) {
      if (!isObjectRecord(item)) {
        parseStats.skippedLinesNonObject += 1;
        continue;
      }
      const role = readGeminiMessageRole(item.role);
      if (!role) {
        // 伪 role / 未来新增角色：白名单外丢弃计数（R2）。
        parseStats.droppedMessagesInvalidRole += 1;
        continue;
      }
      if (isObjectRecord(item.role)) {
        model ??= readTrimmedString(item.role.model);
      }
      const messageBody = isObjectRecord(item.message) ? item.message : item;
      const content =
        readGeminiPartsText(messageBody.parts) ||
        readTrimmedString(messageBody.text) ||
        readTrimmedString(item.content) ||
        "";
      if (!content) {
        parseStats.knownNonMessageEventCount += 1;
        continue;
      }
      const toolCallSummaries = readGeminiToolCalls(messageBody.parts);
      const ts = readExternalTimestampMs(item.timestamp ?? item.time ?? item.createdAt);
      messages.push({
        role,
        content,
        ...(ts ? { ts } : {}),
        ...(role === "assistant" && model ? { model } : {}),
        ...(toolCallSummaries.length > 0 ? { toolCallSummaries } : {}),
      });
    }

    const firstUser = messages.find((message) => message.role === "user");
    return {
      source: "gemini-cli",
      sourceSessionId: ref.sourceSessionId,
      importedTaskIdPrefix: IMPORTED_TASK_ID_PREFIXES["gemini-cli"],
      startedAtTs: messages[0]?.ts,
      lastActivityTs: messages[messages.length - 1]?.ts,
      ...(firstUser ? { title: deriveSessionTitle(firstUser.content, []) } : {}),
      ...(model ? { model } : {}),
      messages,
      parseStats,
      sourcePath,
    } satisfies ExternalSessionRecord;
  },
};
