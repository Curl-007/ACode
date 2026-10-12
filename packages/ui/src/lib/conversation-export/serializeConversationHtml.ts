import type { IntlInstance } from "@/i18n/IntlProvider.js";
import type { ConversationExportChunk, ConversationExportIrRow } from "@acode/services";
import type { Locale } from "@acode/shared";
import { formatAttachmentSize } from "@/lib/chatAttachmentMetadata.js";
import { normalizeConversationShareMarkdown } from "@/v4/conversationShareMarkdown.js";
import {
  formatExportDuration,
  formatExportTimestamp,
  type ConversationExportLabels,
} from "@/lib/conversation-export/conversationExportLabels.js";
import type { ConversationExportSerializeContext } from "@/lib/conversation-export/serializeConversationMarkdown.js";

/**
 * IR 分片 → 自包含 HTML（纯字符串拼接，无 DOM API）。
 *
 * 安全硬约束（PRD 3.5，最高风险项）：
 * - 不生成 <script>，不生成任何 on* 事件属性；
 * - 不引用外部 CSS/JS/字体/图片（样式全部内联在 <style> 里）；
 * - 正文里的远程图片降级为链接（normalizeConversationShareMarkdown）；
 * - 所有用户/模型产生的文本一律经 escapeHtmlText / escapeHtmlAttribute 转义，
 *   禁止在拼接处手写 replace。
 *
 * 行类型 → 表示形式的权威映射表见 ConversationShareReadonlyTimeline.tsx:522-591。
 */

/** 文本节点转义。代码块与普通正文共用同一函数，避免两条转义路径漂移。 */
export function escapeHtmlText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** 属性值转义。比文本多一层：属性里出现换行会破坏标记结构，统一换成实体。 */
export function escapeHtmlAttribute(value: string): string {
  return escapeHtmlText(value).replaceAll("\n", "&#10;").replaceAll("\r", "&#13;");
}

/**
 * 固定样式表：自带亮/暗两套（跟随系统偏好），与产品主题解耦 ——
 * 用户可能把这份 HTML 发给不用我们产品的人。
 */
const EXPORT_STYLE = `
:root{color-scheme:light dark;--bg:#ffffff;--fg:#1f2328;--muted:#59636e;--border:#d1d9e0;--code-bg:#f6f8fa;--card-bg:#f6f8fa;}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#9198a1;--border:#3d444d;--code-bg:#151b23;--card-bg:#151b23;}}
*{box-sizing:border-box}
body{margin:0;padding:32px 20px 64px;background:var(--bg);color:var(--fg);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;font-size:15px;line-height:1.7;}
main{max-width:820px;margin:0 auto}
h1{font-size:22px;line-height:1.4;margin:0 0 24px;word-break:break-word}
h2{font-size:17px;margin:28px 0 8px}
h3{font-size:15px;margin:0 0 8px;color:var(--muted);font-weight:600}
hr{border:0;border-top:1px solid var(--border);margin:28px 0}
details{border:1px solid var(--border);border-radius:10px;padding:8px 12px;margin:12px 0;background:var(--card-bg)}
details>summary{cursor:pointer;color:var(--muted);font-size:14px;word-break:break-word}
details[open]>summary{margin-bottom:8px}
pre{margin:8px 0 0;padding:12px;overflow:auto;background:var(--code-bg);border:1px solid var(--border);border-radius:8px}
code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;white-space:pre-wrap;word-break:break-word}
p{margin:0 0 12px;white-space:pre-wrap;word-break:break-word}
ul{margin:8px 0;padding-left:22px}
li{word-break:break-word}
.marker{margin:20px 0;color:var(--muted);text-align:center}
.skipped{margin-top:32px;color:var(--muted);font-size:13px}
.attachment{color:var(--muted)}
`.trim();

function renderBody(text: string, artifactNames: ReadonlyMap<string, string>): string {
  // 与 Markdown 侧同一份正文规范化：citation 剥离 + 远程图片降级。
  const normalized = normalizeConversationShareMarkdown(text, artifactNames);
  return `<p>${escapeHtmlText(normalized)}</p>`;
}

function renderRow(
  row: ConversationExportIrRow,
  context: ConversationExportSerializeContext,
): string {
  const { labels, locale, intl, artifactNames } = context;
  switch (row.kind) {
    case "turnHeader": {
      context.turnCounter.value += 1;
      const duration = formatExportDuration(row.durationMs, intl, locale);
      const time = formatExportTimestamp(row.startedAt, locale);
      return `<hr><h3>${escapeHtmlText(
        labels.turnHeading(context.turnCounter.value, time, duration),
      )}</h3>`;
    }
    case "userInput": {
      const parts = [`<section><h2>👤 ${escapeHtmlText(labels.userHeading)}</h2>`];
      if (row.text.trim()) parts.push(renderBody(row.text, artifactNames));
      if (row.attachments.length > 0) {
        parts.push('<ul class="attachment">');
        for (const attachment of row.attachments) {
          parts.push(
            `<li>📎 ${escapeHtmlText(
              labels.attachmentMeta(
                attachment.fileName,
                formatAttachmentSize(attachment.sizeBytes),
              ),
            )}</li>`,
          );
        }
        parts.push("</ul>");
      }
      parts.push("</section>");
      return parts.join("");
    }
    case "assistantText": {
      return `<section><h2>🤖 ${escapeHtmlText(labels.assistantHeading)}</h2>${renderBody(
        row.text,
        artifactNames,
      )}</section>`;
    }
    case "reasoning": {
      const duration = formatExportDuration(row.durationMs, intl, locale);
      return `<details><summary>${escapeHtmlText(
        labels.reasoningSummary(duration),
      )}</summary>${renderBody(row.text, artifactNames)}</details>`;
    }
    case "toolCall": {
      const kindLabel = labels.toolKindLabel(row.family, row.toolName);
      const statusLabel = labels.toolStatusLabel(row.status);
      const summary = `${kindLabel} · ${statusLabel} · ${row.toolName}`;
      const body = row.outputText.trim()
        ? `<pre><code>${escapeHtmlText(
            normalizeConversationShareMarkdown(row.outputText, artifactNames),
          )}</code></pre>`
        : "";
      const truncatedNote =
        row.truncatedChars === undefined
          ? ""
          : `<p>${escapeHtmlText(labels.toolOutputTruncated(row.truncatedChars))}</p>`;
      return `<details><summary>${escapeHtmlText(summary)}</summary>${body}${truncatedNote}</details>`;
    }
    case "artifact": {
      return `<ul class="attachment"><li>📄 ${escapeHtmlText(
        labels.artifactMeta(row.artifactType, formatAttachmentSize(row.sizeBytes)),
      )}</li></ul>`;
    }
    case "timelineMarker": {
      const label = row.markerType === "compact" ? labels.markerCompact : labels.markerModelChange;
      return `<div class="marker">${escapeHtmlText(label)}</div>`;
    }
  }
}

export function serializeConversationHtmlHead(options: {
  title: string;
  locale: Locale;
  intl: IntlInstance;
  /** 生成时刻，仅用于 meta 标签；不参与内容比对（可复现性豁免项）。 */
  generatedAt: string;
}): string {
  const documentTitle = options.intl.formatMessage(
    { id: "conversationExport.html.documentTitle" },
    { title: options.title.trim() || "ACode" },
  );
  return [
    "<!DOCTYPE html>",
    `<html lang="${escapeHtmlAttribute(options.locale)}">`,
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<meta name="generated-at" content="${escapeHtmlAttribute(options.generatedAt)}">`,
    `<title>${escapeHtmlText(documentTitle)}</title>`,
    "<style>",
    EXPORT_STYLE,
    "</style>",
    "</head>",
    "<body>",
    "<!-- Generated by ACode. Self-contained, no scripts, no network requests. -->",
    "<main>",
    `<h1>${escapeHtmlText(options.title.trim() || "ACode")}</h1>`,
  ].join("\n");
}

export function serializeConversationHtmlChunk(
  chunk: ConversationExportChunk,
  context: ConversationExportSerializeContext,
): string {
  let output = "";
  for (const row of chunk.rows) {
    output += renderRow(row, context);
  }
  return output;
}

export function serializeConversationHtmlTail(
  skippedRowCount: number,
  labels: ConversationExportLabels,
): string {
  const skipped =
    skippedRowCount > 0
      ? `<p class="skipped">${escapeHtmlText(labels.skipped(skippedRowCount))}</p>`
      : "";
  return `${skipped}</main>\n</body>\n</html>\n`;
}
