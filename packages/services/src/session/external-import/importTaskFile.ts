import { createHash } from "node:crypto";
import type { ACodeTaskMeta } from "@acode/shared";
import { generateTraceId } from "@acode/shared";
import { buildImportedClaudeTaskId, buildImportedClaudeTaskFile } from "#src/session/claude-native/buildImportedClaudeTaskFile.js";
import { DEFAULT_IMPORTED_CLAUDE_TASK_FILTER_PATHS, filterImportedClaudeTaskFilePaths } from "#src/session/claude-native/importedClaudeTaskFileFilter.js";
import type { LegacyTaskSessionFile } from "#src/session/legacyTaskSessionFile.js";
import { deriveSessionTitle } from "#src/session/sessionTitle.js";
import type { ExternalSessionRecord } from "#src/session/external-import/types.js";

/** 新来源的任务 id 前缀（R1 示例形态）；claude-code 保持历史值 "claude-import-"。 */
export const IMPORTED_TASK_ID_PREFIXES = {
  "claude-code": "claude-import-",
  "openai-codex": "imported-codex-",
  "gemini-cli": "imported-gemini-",
  opencode: "imported-opencode-",
  cursor: "imported-cursor-",
} as const;

/**
 * 导入任务 id：source + sourceSessionId 的稳定哈希。
 * 幂等去重键（R3 origin = source + sourceSessionId）由它确定性承载——同一外部会话
 * 重复导入得到同一 taskId，任务索引里不会出现双份任务。
 * F5（批次 C 对抗复核）：digest 去掉 cwd——cwd 只进任务元数据（meta.workspacePath），
 * 不进去重键。含 cwd 时 codex 同 session 跨 cwd 的 resume rollout、cursor 同名
 * transcript 出现在两个 project 目录都会给同一逻辑会话生成不同 taskId 而双份导入，
 * 与 spec R3 的 origin 定义偏差。claude-code 分支不受影响（沿用历史 id 公式）。
 */
export function buildImportedExternalTaskId(
  record: Pick<ExternalSessionRecord, "source" | "sourceSessionId" | "native">,
): string {
  if (record.source === "claude-code") {
    // claude-code 必须沿用既有 buildImportedClaudeTaskId，历史导入任务的关联不能断。
    if (!record.native) {
      throw new Error("[external-import] claude-code record 缺少 native 透传数据");
    }
    return buildImportedClaudeTaskId(record.native.workspacePath, record.native.sessionId);
  }
  const digest = createHash("sha256")
    .update(`${record.source}:${record.sourceSessionId}`)
    .digest("hex")
    .slice(0, 24);
  return `${IMPORTED_TASK_ID_PREFIXES[record.source]}${digest}`;
}

function toTaskMessages(
  record: ExternalSessionRecord,
  fallbackTs: number,
): LegacyTaskSessionFile["messages"] {
  const messages: LegacyTaskSessionFile["messages"] = [];
  let turnIndex = -1;
  for (const message of record.messages) {
    if (message.role === "user") {
      turnIndex += 1;
    }
    messages.push({
      role: message.role,
      content: message.content,
      timestamp: message.ts ?? record.startedAtTs ?? record.lastActivityTs ?? fallbackTs,
      ...(message.model ? { model: message.model } : {}),
      ...(turnIndex >= 0 ? { turnIndex } : {}),
    });
  }
  return messages;
}

/**
 * ExternalSessionRecord → 既有 legacy task snapshot（R3：复用既有落库链路）。
 * - claude-code：直接委托 buildImportedClaudeTaskFile，输出与重构前逐字节一致；
 * - 新来源：同构泛化（claude 特有字段可选化），并复用同一份运行态清洗路径，
 *   避免两套过滤规则漂移。
 */
export function buildImportedExternalTaskFile(
  record: ExternalSessionRecord,
  taskIdOverride?: string,
): LegacyTaskSessionFile {
  if (record.source === "claude-code") {
    if (!record.native) {
      throw new Error("[external-import] claude-code record 缺少 native 透传数据");
    }
    return buildImportedClaudeTaskFile(record.native, undefined, taskIdOverride);
  }
  if (record.messages.length === 0) {
    throw new Error(
      `[external-import] external session ${record.sourceSessionId} 没有可导入的可见消息`,
    );
  }
  // 新来源的 snapshot 路径与任务索引都以 workspacePath 定位；缺失时必须显式失败，
  // 让编排层把它记为 skipped（workspace_unknown），而不是落一个空路径任务。
  if (!record.cwd) {
    throw new Error(
      `[external-import] external session ${record.sourceSessionId} 缺少可用的 workspace 路径`,
    );
  }

  const taskId = taskIdOverride ?? buildImportedExternalTaskId(record);
  const traceId = generateTraceId(taskId);
  const startedAt = record.startedAtTs ?? record.messages[0]?.ts;
  const lastActivity = record.lastActivityTs ?? record.messages[record.messages.length - 1]?.ts;
  const createdAt = Number.isFinite(startedAt) ? (startedAt as number) : Date.now();
  const updatedAt = Math.max(createdAt, Number.isFinite(lastActivity) ? (lastActivity as number) : 0);

  const firstUser = record.messages.find(
    (message) => message.role === "user" && message.content.trim().length > 0,
  );
  const meta: ACodeTaskMeta = {
    taskId,
    traceId,
    title: record.title?.trim() || (firstUser ? deriveSessionTitle(firstUser.content, []) : "Imported session"),
    workspacePath: record.cwd,
    createdAt,
    updatedAt,
    mode: "build",
    status: "completed",
    ...(record.model ? { model: record.model } : {}),
  };

  // 与 claude 导入同一份过滤：外部来源消息上的 model 等运行态字段不落 snapshot，
  // 防止迁移历史污染当前 workspace 的运行时选择。
  return filterImportedClaudeTaskFilePaths(
    { meta, messages: toTaskMessages(record, createdAt) },
    DEFAULT_IMPORTED_CLAUDE_TASK_FILTER_PATHS,
  );
}
