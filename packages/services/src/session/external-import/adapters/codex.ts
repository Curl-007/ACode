import { homedir } from "node:os";
import { basename, join } from "node:path";
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

/** 测试桩用根目录覆盖（R1）；缺省 ~/.codex/sessions（年份/月/日子目录按 rollout-*.jsonl 递归发现）。 */
export const CODEX_SESSIONS_DIR_ENV = "ACODE_IMPORT_CODEX_SESSIONS_DIR";

/** 已知但无导入价值的顶层事件（forward-compat 白名单，格式演进时静默跳过）。 */
const KNOWN_CODEX_NON_MESSAGE_TOP_LEVEL_TYPES = new Set([
  "token_count",
  "compacted",
  "context_compacted",
  "world_state",
  "task_complete",
  "task_started",
  "thread_settings_applied",
  "turn_aborted",
  "turn_context",
  "add",
  "update",
]);

/** event_msg 内已知但无导入价值的 payload 类型。 */
const KNOWN_CODEX_NON_MESSAGE_EVENT_TYPES = new Set([
  "task_started",
  "task_complete",
  "token_count",
  "agent_reasoning",
  "turn_aborted",
  "thread_settings_applied",
  "context_compacted",
  "mcp_tool_call_end",
  "patch_apply_end",
]);

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

function readCodexSessionMeta(records: readonly Record<string, unknown>[]): {
  sessionId?: string;
  cwd?: string;
} {
  for (const record of records) {
    if (readTrimmedString(record.type) !== "session_meta") {
      continue;
    }
    const payload = isObjectRecord(record.payload) ? record.payload : undefined;
    return {
      sessionId: readTrimmedString(payload?.session_id) ?? readTrimmedString(payload?.id),
      cwd: readTrimmedString(payload?.cwd),
    };
  }
  return {};
}

function countCodexVisibleMessages(records: readonly Record<string, unknown>[]): number {
  let count = 0;
  for (const record of records) {
    const payload = isObjectRecord(record.payload) ? record.payload : undefined;
    if (readTrimmedString(record.type) !== "event_msg") {
      continue;
    }
    const payloadType = readTrimmedString(payload?.type);
    if (payloadType === "user_message" || payloadType === "agent_message") {
      count += 1;
    }
  }
  return count;
}

function attachPendingTools(
  messages: ExternalMessageRecord[],
  pendingTools: ExternalToolCallSummary[],
): void {
  if (pendingTools.length === 0) {
    return;
  }
  // 工具调用归属展示它的 assistant 消息；事件流里调用先于回复出现，
  // 因此挂到「下一条 assistant 消息」，流结束时挂最后一条 assistant。
  const target = [...messages].reverse().find((message) => message.role === "assistant");
  if (!target) {
    return;
  }
  target.toolCallSummaries = [...(target.toolCallSummaries ?? []), ...pendingTools];
  pendingTools.length = 0;
}

/**
 * OpenAI Codex CLI adapter（~/.codex/sessions/ 的 rollout-*.jsonl 事件流）。
 * 本机真实样本（2026-08，cli 0.147.x）核实的形态：
 * - session_meta（首行）携带 session_id/cwd；
 * - event_msg 的 user_message/agent_message 是用户可见文本的权威来源；
 * - response_item 的 message 与 event_msg 重复同一轮内容（且首条 user 常是注入的
 *   AGENTS.md/环境上下文），因此只从 response_item 提取工具调用名，不取正文，
 *   避免同一轮消息双份落库。
 */
export const codexExternalSessionAdapter: ExternalSessionSourceAdapter = {
  source: "openai-codex",
  importedTaskIdPrefix: IMPORTED_TASK_ID_PREFIXES["openai-codex"],

  async discoverSessions(params) {
    const rootDir = resolveExternalImportRootDir(
      CODEX_SESSIONS_DIR_ENV,
      join(homedir(), ".codex", "sessions"),
    );
    const files = await collectFilesRecursive(
      rootDir,
      (name) => name.startsWith("rollout-") && name.endsWith(".jsonl"),
    );
    const summaries: ExternalSessionSummary[] = [];
    for (const filePath of files) {
      const mtimeMs = await readFileMtimeMs(filePath);
      if (mtimeMs === null) {
        continue;
      }
      if (params.sinceTs !== undefined && mtimeMs < params.sinceTs) {
        continue;
      }
      const head = await readGuardedJsonLinesFileHead(filePath, 32);
      const meta = readCodexSessionMeta(head.records);
      const sessionId = meta.sessionId ?? basename(filePath, ".jsonl");
      if (!sessionId) {
        continue;
      }
      summaries.push({
        source: "openai-codex",
        sourceSessionId: sessionId,
        cwd: meta.cwd,
        projectHint: meta.cwd,
        lastActivityTs: mtimeMs,
        messageCountEstimate: countCodexVisibleMessages(head.records),
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
      throw new Error(`[external-import] codex session 未找到: ${ref.sourceSessionId}`);
    }

    const { records, stats } = await readGuardedJsonLinesFile(sourcePath);
    const parseStats = { ...emptyParseStats(), ...stats };
    const messages: ExternalMessageRecord[] = [];
    const pendingTools: ExternalToolCallSummary[] = [];
    let cwd: string | undefined;
    let sessionId = ref.sourceSessionId;
    let model: string | undefined;

    for (const record of records) {
      const type = readTrimmedString(record.type);
      const payload = isObjectRecord(record.payload) ? record.payload : undefined;
      const ts = readExternalTimestampMs(record.timestamp);

      if (type === "session_meta") {
        cwd ??= readTrimmedString(payload?.cwd);
        const metaSessionId = readTrimmedString(payload?.session_id);
        if (metaSessionId) {
          sessionId = metaSessionId;
        }
        continue;
      }

      if (type === "event_msg") {
        const payloadType = readTrimmedString(payload?.type);
        if (payloadType === "user_message") {
          const content = readTrimmedString(payload?.message) ?? "";
          if (content) {
            messages.push({ role: "user", content, ...(ts ? { ts } : {}) });
          }
          continue;
        }
        if (payloadType === "agent_message") {
          const content = readTrimmedString(payload?.message) ?? "";
          if (content) {
            const message: ExternalMessageRecord = {
              role: "assistant",
              content,
              ...(ts ? { ts } : {}),
              ...(model ? { model } : {}),
            };
            messages.push(message);
            attachPendingTools(messages, pendingTools);
          }
          continue;
        }
        if (payloadType === "turn_context") {
          // 真实样本核实：turn_context 携带本轮模型与 cwd，可作为缺省补充。
          model ??= readTrimmedString(payload?.model);
          cwd ??= readTrimmedString(payload?.cwd);
          parseStats.knownNonMessageEventCount += 1;
          continue;
        }
        if (payloadType && KNOWN_CODEX_NON_MESSAGE_EVENT_TYPES.has(payloadType)) {
          parseStats.knownNonMessageEventCount += 1;
          continue;
        }
        parseStats.unknownEventTypeCount += 1;
        continue;
      }

      if (type === "response_item") {
        const payloadType = readTrimmedString(payload?.type);
        if (
          payloadType === "function_call" ||
          payloadType === "custom_tool_call" ||
          payloadType === "tool_call"
        ) {
          const toolName = readTrimmedString(payload?.name) ?? readTrimmedString(payload?.tool);
          if (toolName) {
            pendingTools.push({ toolName });
          }
          parseStats.knownNonMessageEventCount += 1;
          continue;
        }
        if (payloadType === "message") {
          const role = readTrimmedString(payload?.role);
          if (role !== "user" && role !== "assistant") {
            // 伪 role（developer/system/tool 等）白名单外，丢弃计数（R2）。
            parseStats.droppedMessagesInvalidRole += 1;
            continue;
          }
          // 正文与 event_msg 流重复，这里不取，避免双份。
          parseStats.knownNonMessageEventCount += 1;
          continue;
        }
        parseStats.knownNonMessageEventCount += 1;
        continue;
      }

      if (type && KNOWN_CODEX_NON_MESSAGE_TOP_LEVEL_TYPES.has(type)) {
        parseStats.knownNonMessageEventCount += 1;
        continue;
      }
      // 未知事件类型静默跳过但计数（forward-compat）。
      parseStats.unknownEventTypeCount += 1;
    }

    attachPendingTools(messages, pendingTools);
    parseStats.skippedLines =
      stats.skippedLinesOverSize +
      stats.skippedLinesMalformed +
      stats.skippedLinesTooDeep +
      stats.skippedLinesNonObject;

    const firstUser = messages.find((message) => message.role === "user");
    return {
      source: "openai-codex",
      sourceSessionId: sessionId,
      importedTaskIdPrefix: IMPORTED_TASK_ID_PREFIXES["openai-codex"],
      cwd,
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
