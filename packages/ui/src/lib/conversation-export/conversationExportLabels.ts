import { getCompactToolCallStatusMessageId, type Locale } from "@acode/shared";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import { formatConversationWorkDuration } from "@/v4/conversationWorkDuration.js";

/**
 * 导出产物里「框架文案」的本地化标签。
 *
 * 序列化器是纯函数，不认识 intl；由这里把界面语言与 intl 实例解析成一组标签函数，
 * 再交给 Markdown / HTML 两个序列化器。两份产物因此共享同一套文案来源。
 */
export interface ConversationExportLabels {
  userHeading: string;
  assistantHeading: string;
  /** 思考过程的折叠标题，含格式化后的耗时。 */
  reasoningSummary(durationText: string): string;
  /** 轮次标题，含序号、row 自带时间戳与耗时。 */
  turnHeading(index: number, time: string, durationText: string): string;
  /** 文件末尾「已跳过内容」小节。 */
  skipped(count: number): string;
  markerCompact: string;
  markerModelChange: string;
  /** 工具调用的种类文案；识别不了家族时回落到原始工具名。 */
  toolKindLabel(family: string, toolName: string): string;
  toolStatusLabel(status: string): string;
  /** 单条工具输出被截断时的说明。 */
  toolOutputTruncated(truncatedChars: number): string;
  /** 附件行 / artifact 行的元数据串。 */
  attachmentMeta(fileName: string, sizeText: string): string;
  artifactMeta(artifactType: string, sizeText: string): string;
}

/**
 * 工具家族 → 种类文案的 i18n key。
 * 与只读时间线的 presentation 分支同规则（ConversationShareReadonlyTimeline.tsx:360-389）：
 * 只有 search / shell / file-read / file-write 四类走本地化短名，其余用工具名本身。
 */
const TOOL_FAMILY_KIND_MESSAGE_IDS: Readonly<Record<string, string>> = {
  search: "chat.toolCall.kind.search",
  shell: "chat.toolCall.kind.terminal",
  "file-read": "chat.toolCall.kind.read",
  "file-write": "chat.toolCall.kind.edit",
};

/** 工具状态 → 紧凑状态文案，与只读时间线的 resolveToolStatusLabel（:302-320）同一映射。 */
export function resolveExportToolStatusMessageId(status: string): string {
  const compactState =
    status === "inputStreaming" || status === "pendingApproval"
      ? "input-streaming"
      : status === "running"
        ? "input-available"
        : status === "success"
          ? "output-available"
          : "output-error";
  return getCompactToolCallStatusMessageId(
    compactState,
    status === "cancelled" ? "stopped" : undefined,
  );
}

/** row 自带时间戳 → 本地可读时间。不用 Date.now()：同一 row 永远产出同一文案。 */
export function formatExportTimestamp(startedAt: number, locale: Locale): string {
  const date = new Date(startedAt);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

export function createConversationExportLabels(intl: IntlInstance): ConversationExportLabels {
  return {
    userHeading: intl.formatMessage({ id: "conversationExport.markdown.userHeading" }),
    assistantHeading: intl.formatMessage({ id: "conversationExport.markdown.assistantHeading" }),
    reasoningSummary: (durationText) =>
      intl.formatMessage(
        { id: "conversationExport.markdown.reasoningSummary" },
        { duration: durationText },
      ),
    turnHeading: (index, time, durationText) =>
      intl.formatMessage(
        { id: "conversationExport.markdown.turnHeading" },
        { index, time, duration: durationText },
      ),
    skipped: (count) =>
      intl.formatMessage({ id: "conversationExport.markdown.skipped" }, { count }),
    markerCompact: intl.formatMessage({ id: "conversationExport.marker.compact" }),
    markerModelChange: intl.formatMessage({ id: "conversationExport.marker.modelChange" }),
    toolKindLabel: (family, toolName) => {
      const messageId = TOOL_FAMILY_KIND_MESSAGE_IDS[family];
      return messageId ? intl.formatMessage({ id: messageId }) : toolName;
    },
    toolStatusLabel: (status) =>
      intl.formatMessage({ id: resolveExportToolStatusMessageId(status) }),
    toolOutputTruncated: (truncatedChars) =>
      intl.formatMessage(
        { id: "conversationExport.markdown.toolOutputTruncated" },
        { count: truncatedChars },
      ),
    attachmentMeta: (fileName, sizeText) => `${fileName} (${sizeText})`,
    artifactMeta: (artifactType, sizeText) => `${artifactType} · ${sizeText}`,
  };
}

/** 耗时文案；与只读时间线共用同一份单位格式化，避免两处单位不一致。 */
export function formatExportDuration(
  durationMs: number | undefined,
  intl: IntlInstance,
  locale: Locale,
): string {
  return formatConversationWorkDuration(durationMs, intl, locale) ?? "";
}
