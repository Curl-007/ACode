import { getACodeToolFamilyForName } from "@acode/shared";
import type { ConversationRow } from "@acode/shared/acode-protocol-v4";

import type {
  ConversationExportChunk,
  ConversationExportIrAttachment,
  ConversationExportIrRow,
  ConversationExportSelection,
} from "./conversationExport.js";

/**
 * rows → 导出 IR（纯函数，无 IO、无文案）。
 *
 * 行类型 → 表示形式的权威映射表在 `packages/ui/src/v4/ConversationShareReadonlyTimeline.tsx`
 * 的 `renderReadonlyRow`（:522-591）。本文件按同一 switch 结构实现「语义规则」，
 * 序列化器再把 IR 转成 Markdown/HTML；两侧规则漂移由单测（语义一致性用例）拦住。
 */

/** 单条工具输出的字符数上限；超限截断并回传被截掉的字符数，由序列化器补本地化说明。 */
export const EXPORT_TOOL_OUTPUT_MAX_CHARS = 200_000;

/** 与分享公开投影同一组「工具仍在进行」状态（conversationSharePublicProjection.ts:27）。 */
const ACTIVE_TOOL_STATUSES = new Set(["inputStreaming", "pendingApproval", "running"]);

/**
 * 与公开投影一致的禁止内联 URL：data: / file: 不能出现在可外发的产物里
 * （conversationSharePublicProjection.ts:65-67 的 assertSafeString）。
 *
 * 刻意与分享同样只匹配**值开头**：正文里正常出现的 "data:" 词句不能被误判成 URL，
 * 否则用户会在导出文件里看到莫名其妙的空白。
 */
const FORBIDDEN_URL_PATTERN = /^(?:data|file):/iu;

function containsForbiddenUrl(value: string): boolean {
  return FORBIDDEN_URL_PATTERN.test(value.trim());
}

/**
 * 文本行的 URL 脱敏：命中禁止 scheme 时整段替换为空串，但**保留行本身**。
 *
 * 不整行丢弃：行是轮次结构的一部分（标题、折叠块边界），丢掉会让导出文件看起来缺内容。
 * 换空串是「内容不可安全承载」与「结构必须保留」之间的取舍。
 */
function sanitizeExportText(text: string): string {
  return containsForbiddenUrl(text) ? "" : text;
}

/**
 * 运行中的行判定（沿用 conversationSharePublicProjection.ts:82-105 的规则）。
 * 导出与分享对「会话是否已定稿」的口径必须一致，否则同一会话一边能分享一边不能导出。
 */
export function findRunningRowReason(rows: readonly ConversationRow[]): "running" | null {
  for (const row of rows) {
    if (row.kind === "turnHeader" && row.state === "running") return "running";
    if ((row.kind === "assistantText" || row.kind === "reasoning") && row.state === "streaming") {
      return "running";
    }
    if (row.kind === "toolCall" && ACTIVE_TOOL_STATUSES.has(row.status)) return "running";
    if (row.kind === "subagent" && row.status === "running") return "running";
    if (
      row.kind === "timelineMarker" &&
      ((row.marker.type === "compact" && row.marker.status === "running") ||
        (row.marker.type === "goalVerify" && row.marker.outcome === "running"))
    ) {
      return "running";
    }
  }
  return null;
}

/** 选中范围过滤。partial 只认 productTurnId（无 productTurnId 的旧行在部分导出时被丢弃）。 */
export function filterRowsBySelection(
  rows: readonly ConversationRow[],
  selection: ConversationExportSelection,
): ConversationRow[] {
  if (selection.kind === "all") return [...rows];
  const selected = new Set(selection.productTurnIds);
  if (selected.size === 0) return [];
  return rows.filter((row) => row.productTurnId !== undefined && selected.has(row.productTurnId));
}

function resolveTurnDurationMs(row: Extract<ConversationRow, { kind: "turnHeader" }>) {
  if (row.activeMs !== undefined) return row.activeMs;
  if (row.endedAt === undefined) return undefined;
  const elapsed = row.endedAt - row.startedAt;
  return elapsed > 0 ? elapsed : undefined;
}

function readAttachments(
  row: Extract<ConversationRow, { kind: "userInput" }>,
): ConversationExportIrAttachment[] {
  return (row.attachments ?? []).map((attachment) => ({
    fileName: attachment.fileName,
    sizeBytes: attachment.bytes,
  }));
}

/** 工具输出截断。返回截断后的文本与被截掉的字符数（未截断时为 undefined）。 */
function truncateToolOutput(text: string): { text: string; truncatedChars?: number } {
  if (text.length <= EXPORT_TOOL_OUTPUT_MAX_CHARS) return { text };
  return {
    text: text.slice(0, EXPORT_TOOL_OUTPUT_MAX_CHARS),
    truncatedChars: text.length - EXPORT_TOOL_OUTPUT_MAX_CHARS,
  };
}

interface BuildRowOutcome {
  row?: ConversationExportIrRow;
  /** 整行不导出且需要计入「已跳过内容」提示。 */
  skipped?: boolean;
}

function buildExportIrRow(row: ConversationRow): BuildRowOutcome {
  switch (row.kind) {
    case "turnHeader": {
      const durationMs = resolveTurnDurationMs(row);
      return {
        row: {
          kind: "turnHeader",
          rowId: row.rowId,
          // 时间戳取自 row，不得用 Date.now()：重跑导出必须产出逐字节相同的内容。
          startedAt: row.startedAt,
          ...(durationMs === undefined ? {} : { durationMs }),
        },
      };
    }
    case "userInput": {
      return {
        row: {
          kind: "userInput",
          rowId: row.rowId,
          text: sanitizeExportText(row.text),
          attachments: readAttachments(row),
        },
      };
    }
    case "assistantText": {
      return {
        row: { kind: "assistantText", rowId: row.rowId, text: sanitizeExportText(row.text) },
      };
    }
    case "reasoning": {
      return {
        row: {
          kind: "reasoning",
          rowId: row.rowId,
          text: sanitizeExportText(row.text),
          ...(row.durationMs === undefined ? {} : { durationMs: row.durationMs }),
        },
      };
    }
    case "toolCall": {
      // 内联工具图片沿用分享的拒绝规则（conversationSharePublicProjection.ts:113-119）：
      // 图片数据本身无法在单文件里安全承载，整行不导出并计数。
      if (row.display?.kind === "node_repl_images") return { skipped: true };
      const outputText = sanitizeExportText(row.output?.text ?? "");
      const truncated = truncateToolOutput(outputText);
      return {
        row: {
          kind: "toolCall",
          rowId: row.rowId,
          toolCallId: row.toolCallId,
          toolName: row.toolName,
          status: row.status,
          family: getACodeToolFamilyForName(row.toolName) ?? "unknown",
          outputText: truncated.text,
          ...(truncated.truncatedChars === undefined
            ? {}
            : { truncatedChars: truncated.truncatedChars }),
        },
      };
    }
    case "artifact": {
      // artifact.ref 是 Host 内部授权引用，导出产物里不出现 URL（只保留元数据）；
      // 显示名带禁止 scheme 时整行跳过并计数，因为它本身就是不可承载的内容。
      if (containsForbiddenUrl(row.ref) || containsForbiddenUrl(row.displayName)) {
        return { skipped: true };
      }
      return {
        row: {
          kind: "artifact",
          rowId: row.rowId,
          displayName: row.displayName,
          artifactType: row.artifactType,
          sizeBytes: row.sizeBytes,
        },
      };
    }
    case "timelineMarker": {
      // 与只读时间线的 resolveReadonlyMarkerLabel（:137-149）同规则：
      // compact 只在 success 时出文案；识别不了的类型整行不渲染，绝不回退成枚举名。
      if (row.marker.type === "compact") {
        if (row.marker.status !== "success") return {};
        return { row: { kind: "timelineMarker", rowId: row.rowId, markerType: "compact" } };
      }
      if (row.marker.type === "modelChange") {
        return { row: { kind: "timelineMarker", rowId: row.rowId, markerType: "modelChange" } };
      }
      return {};
    }
    case "subagent":
    case "hookInvocation":
      // 与只读时间线一致：这两类不进入只读呈现。
      return {};
  }
}

export function buildExportChunk(
  rows: readonly ConversationRow[],
  selection: ConversationExportSelection,
): ConversationExportChunk {
  const selected = filterRowsBySelection(rows, selection);
  const irRows: ConversationExportIrRow[] = [];
  let skippedRowCount = 0;
  for (const row of selected) {
    const outcome = buildExportIrRow(row);
    if (outcome.row) {
      irRows.push(outcome.row);
    } else if (outcome.skipped) {
      skippedRowCount += 1;
    }
  }
  return { rows: irRows, skippedRowCount };
}
