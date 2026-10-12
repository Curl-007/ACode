import assert from "node:assert/strict";
import test from "node:test";
import type { ConversationExportChunk, ConversationExportIrRow } from "@acode/services";
import { createConversationExportLabels } from "./conversationExportLabels.js";
import {
  escapeHtmlAttribute,
  escapeHtmlText,
  serializeConversationHtmlChunk,
  serializeConversationHtmlHead,
  serializeConversationHtmlTail,
} from "./serializeConversationHtml.js";
import type { ConversationExportSerializeContext } from "./serializeConversationMarkdown.js";

const MESSAGES: Record<string, string> = {
  "conversationExport.markdown.userHeading": "用户",
  "conversationExport.markdown.assistantHeading": "助手",
  "conversationExport.markdown.reasoningSummary": "思考过程（{duration}）",
  "conversationExport.markdown.turnHeading": "第 {index} 轮 · {time} · 耗时 {duration}",
  "conversationExport.markdown.skipped": "已跳过 {count} 项无法导出的内容",
  "conversationExport.markdown.toolOutputTruncated": "…（输出过长，已截断 {count} 字符）",
  "conversationExport.marker.compact": "上下文已压缩",
  "conversationExport.marker.modelChange": "模型已切换",
  "conversationExport.html.documentTitle": "{title} · ACode 会话导出",
  "chat.toolCall.kind.read": "读取",
  "chat.toolCall.status.completed": "已完成",
  "chat.history.duration.second": "秒",
};

const intl = {
  formatMessage: (descriptor: { id: string }, values?: Record<string, string | number>) => {
    const template = MESSAGES[descriptor.id] ?? descriptor.id;
    if (!values) return template;
    return template.replace(/\{(\w+)\}/gu, (_match, key: string) => String(values[key] ?? ""));
  },
};

function context(): ConversationExportSerializeContext {
  return {
    labels: createConversationExportLabels(intl),
    locale: "zh-CN",
    intl,
    artifactNames: new Map(),
    turnCounter: { value: 0 },
  };
}

function chunk(rows: ConversationExportIrRow[], skippedRowCount = 0): ConversationExportChunk {
  return { rows, skippedRowCount };
}

function document_(rows: ConversationExportIrRow[], skippedRowCount = 0): string {
  const ctx = context();
  return (
    serializeConversationHtmlHead({
      title: "会话标题",
      locale: "zh-CN",
      intl,
      generatedAt: "2026-09-26T00:00:00.000Z",
    }) +
    serializeConversationHtmlChunk(chunk(rows, skippedRowCount), ctx) +
    serializeConversationHtmlTail(skippedRowCount, ctx.labels)
  );
}

/** 允许出现的唯一标签集合；任何未列出的标签都视为违规（尤其 script / iframe / link / img）。 */
const ALLOWED_TAGS = new Set([
  "html",
  "head",
  "meta",
  "title",
  "style",
  "body",
  "main",
  "h1",
  "h2",
  "h3",
  "hr",
  "section",
  "details",
  "summary",
  "pre",
  "code",
  "p",
  "ul",
  "li",
  "div",
]);

function collectTags(html: string): string[] {
  return [...html.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9-]*)/gu)].map((match) =>
    match[1]!.toLowerCase(),
  );
}

/**
 * 真正的标签（含属性），不含被转义后以文本形式出现的 `&lt;img ...&gt;`。
 *
 * 安全断言必须只看真实标签：转义后的正文里出现字面量 `onerror=` 是**正确**的
 * （它就是被展示的文本），只有当它落在真实标签的属性位上才是漏洞。
 */
function collectRealTags(html: string): string[] {
  return [...html.matchAll(/<[a-zA-Z][a-zA-Z0-9-]*(?:\s[^>]*)?>/gu)].map((match) => match[0]);
}

/** 真实标签里的事件处理器属性。 */
function findEventHandlerAttributes(html: string): string[] {
  return collectRealTags(html).filter((tag) => /\son[a-z]+\s*=/iu.test(tag));
}

test("输出包含 DOCTYPE 与 lang 属性", () => {
  const html = document_([]);
  assert.match(html, /^<!DOCTYPE html>/u);
  assert.match(html, /<html lang="zh-CN">/u);
  assert.match(html, /<title>会话标题 · ACode 会话导出<\/title>/u);
  assert.ok(html.endsWith("</html>\n"), html.slice(-30));
});

test("输出不含 script 标签与 on* 事件属性", () => {
  const html = document_([
    {
      kind: "assistantText",
      rowId: 1,
      text: '正文 <img src=x onerror=alert(1)> 与 <div onclick="evil()">',
    },
  ]);
  assert.ok(!/<script/iu.test(html), html);
  assert.deepEqual(findEventHandlerAttributes(html), [], html);
  assert.ok(!/javascript:/iu.test(html), html);
  // 注入串只能以转义文本存在，不能成为真实标签。
  assert.ok(!/<img/iu.test(html), html);
  assert.ok(!/<div onclick/iu.test(html), html);
});

test("输出不含外链 link/script/img/@import", () => {
  const html = document_([
    { kind: "assistantText", rowId: 1, text: "正文" },
    { kind: "artifact", rowId: 2, displayName: "a.pdf", artifactType: "pdf", sizeBytes: 10 },
  ]);
  assert.ok(!/<link/iu.test(html), html);
  assert.ok(!/<img/iu.test(html), html);
  assert.ok(!/@import/iu.test(html), html);
  assert.ok(!/<iframe/iu.test(html), html);
  // 除 DOCTYPE 注释里的说明外，不得引用任何 http(s) 资源。
  assert.ok(!/(?:src|href)\s*=\s*["']?https?:/iu.test(html), html);
  const tags = collectTags(html);
  for (const tag of tags) {
    assert.ok(ALLOWED_TAGS.has(tag), `未预期的标签: ${tag}`);
  }
});

test("远程图片语法降级为链接", () => {
  const html = document_([
    {
      kind: "assistantText",
      rowId: 1,
      text: "看图 ![截图](https://example.com/a.png) 结束",
    },
  ]);
  // 降级后是普通文本（本序列化器不做 Markdown 渲染），关键是不能再出现图片语法/自动加载。
  assert.ok(!html.includes("![截图]"), html);
  assert.ok(!/<img/iu.test(html), html);
  assert.match(html, /\[截图\]\(https:\/\/example\.com\/a\.png\)/u);
});

test("文本中的尖括号与引号被转义", () => {
  const html = document_([{ kind: "assistantText", rowId: 1, text: "<b>\"加粗\"</b> & '单引号'" }]);
  assert.match(html, /&lt;b&gt;/u);
  assert.match(html, /&lt;\/b&gt;/u);
  assert.match(html, /&quot;加粗&quot;/u);
  assert.match(html, /&amp;/u);
  assert.ok(!html.includes("<b>"), html);
  assert.equal(escapeHtmlText("<>&\"'"), "&lt;&gt;&amp;&quot;&#39;");
  assert.equal(escapeHtmlAttribute('a"b\nc'), "a&quot;b&#10;c");
});

test("工具输出中的 </pre> 被转义", () => {
  const html = document_([
    {
      kind: "toolCall",
      rowId: 1,
      toolCallId: "tool-1",
      toolName: "Bash",
      status: "success",
      family: "shell",
      outputText: "before</pre><script>alert(1)</script>after",
    },
  ]);
  assert.ok(!html.includes("</pre><script>"), html);
  assert.match(html, /&lt;\/pre&gt;/u);
  // <pre> 结构必须仍然闭合。
  const preOpens = (html.match(/<pre>/gu) ?? []).length;
  const preCloses = (html.match(/<\/pre>/gu) ?? []).length;
  assert.equal(preOpens, preCloses);
  assert.equal(preOpens, 1);
});

test("注入串 img onerror 不产生可执行内容", () => {
  const payloads = [
    '"><script>alert(1)</script>',
    "<img src=x onerror=alert(1)>",
    "</script><script>alert(2)</script>",
    "javascript:alert(3)",
  ];
  for (const payload of payloads) {
    const html = document_([{ kind: "userInput", rowId: 1, text: payload, attachments: [] }]);
    assert.ok(!/<script/iu.test(html), payload);
    assert.deepEqual(findEventHandlerAttributes(html), [], payload);
    assert.ok(!/<img/iu.test(html), payload);
    assert.ok(!/<iframe/iu.test(html), payload);
  }
});

test("head 与 tail 可拼接，拼出的文档结构完整", () => {
  const html = document_([{ kind: "assistantText", rowId: 1, text: "内容" }]);
  assert.match(html, /<\/head>/u);
  assert.match(html, /<body>/u);
  assert.match(html, /<\/main>/u);
  assert.match(html, /<\/body>/u);
  assert.match(html, /<\/html>/u);
  // 自包含安全提示必须存在。
  assert.match(html, /Generated by ACode\. Self-contained, no scripts, no network requests\./u);
});

test("与 Markdown 序列化器对同一 IR 的语义一致（同一组标题/折叠项数量）", () => {
  const rows: ConversationExportIrRow[] = [
    { kind: "turnHeader", rowId: 1, startedAt: 1_700_000_000_000, durationMs: 5_000 },
    { kind: "userInput", rowId: 2, text: "问题", attachments: [] },
    { kind: "assistantText", rowId: 3, text: "回答" },
    { kind: "reasoning", rowId: 4, text: "思考" },
    {
      kind: "toolCall",
      rowId: 5,
      toolCallId: "tool-1",
      toolName: "Read",
      status: "success",
      family: "file-read",
      outputText: "content",
    },
  ];
  const html = document_(rows);
  assert.equal((html.match(/<h2>/gu) ?? []).length, 2, "用户 + 助手两个 h2");
  assert.equal((html.match(/<h3>/gu) ?? []).length, 1, "一个轮次标题");
  assert.equal((html.match(/<details>/gu) ?? []).length, 2, "思考 + 工具两个折叠项");
  assert.equal((html.match(/<hr>/gu) ?? []).length, 1, "轮次分隔");
});

test("tail 在 skippedRowCount 大于 0 时输出跳过计数", () => {
  const html = document_([{ kind: "assistantText", rowId: 1, text: "内容" }], 2);
  assert.match(html, /已跳过 2 项无法导出的内容/u);
  assert.match(html, /class="skipped"/u);
});
