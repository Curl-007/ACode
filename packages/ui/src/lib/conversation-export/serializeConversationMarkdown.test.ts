import assert from "node:assert/strict";
import test from "node:test";
import type { ConversationExportChunk, ConversationExportIrRow } from "@acode/services";
import { createConversationExportLabels } from "./conversationExportLabels.js";
import {
  balanceMarkdownCodeFences,
  serializeConversationMarkdownChunk,
  serializeConversationMarkdownHead,
  serializeConversationMarkdownTail,
  type ConversationExportSerializeContext,
} from "./serializeConversationMarkdown.js";

// 测试用 intl：直接按 id 返回可读文案，避免把 i18n 词表耦合进序列化器单测。
const MESSAGES: Record<string, string> = {
  "conversationExport.markdown.userHeading": "用户",
  "conversationExport.markdown.assistantHeading": "助手",
  "conversationExport.markdown.reasoningSummary": "思考过程（{duration}）",
  "conversationExport.markdown.turnHeading": "第 {index} 轮 · {time} · 耗时 {duration}",
  "conversationExport.markdown.skipped": "已跳过 {count} 项无法导出的内容",
  "conversationExport.markdown.toolOutputTruncated": "…（输出过长，已截断 {count} 字符）",
  "conversationExport.marker.compact": "上下文已压缩",
  "conversationExport.marker.modelChange": "模型已切换",
  "chat.toolCall.kind.read": "读取",
  "chat.toolCall.status.completed": "已完成",
  "chat.history.duration.minute": "分",
  "chat.history.duration.second": "秒",
};

const intl = {
  formatMessage: (descriptor: { id: string }, values?: Record<string, string | number>) => {
    const template = MESSAGES[descriptor.id] ?? descriptor.id;
    if (!values) return template;
    return template.replace(/\{(\w+)\}/gu, (_match, key: string) => String(values[key] ?? ""));
  },
};

function context(
  artifactNames: ReadonlyMap<string, string> = new Map(),
): ConversationExportSerializeContext {
  return {
    labels: createConversationExportLabels(intl),
    locale: "zh-CN",
    intl,
    artifactNames,
    turnCounter: { value: 0 },
  };
}

function chunk(rows: ConversationExportIrRow[], skippedRowCount = 0): ConversationExportChunk {
  return { rows, skippedRowCount };
}

test("userInput 渲染为用户小节并保留正文", () => {
  const output = serializeConversationMarkdownChunk(
    chunk([
      {
        kind: "userInput",
        rowId: 1,
        text: "请帮我重构这段代码",
        attachments: [{ fileName: "log.txt", sizeBytes: 2048 }],
      },
    ]),
    context(),
  );
  assert.match(output, /## 👤 用户/u);
  assert.match(output, /请帮我重构这段代码/u);
  assert.match(output, /- 📎 log\.txt \(2 KB\)/u);
});

test("assistantText 经过 citation 剥离后输出", () => {
  // acode-file-citation directive 必须被剥离，绝不能出现在导出文件里（防路径泄漏）。
  const directive = ':acode-file-citation{path="/workspace/secret/config.ts"}';
  const output = serializeConversationMarkdownChunk(
    chunk([{ kind: "assistantText", rowId: 1, text: `看这个文件${directive}` }]),
    context(),
  );
  assert.ok(!output.includes("acode-file-citation"), output);
  assert.ok(!output.includes("/workspace/secret"), output);
  assert.match(output, /看这个文件/u);
});

test("reasoning 渲染为 details 且含耗时", () => {
  const output = serializeConversationMarkdownChunk(
    chunk([{ kind: "reasoning", rowId: 1, text: "先分析再动手", durationMs: 3_000 }]),
    context(),
  );
  assert.match(output, /<details>/u);
  assert.match(output, /<summary>思考过程（3 秒）<\/summary>/u);
  assert.match(output, /先分析再动手/u);
  assert.match(output, /<\/details>/u);
});

test("toolCall 渲染为 details 且含状态文案", () => {
  const output = serializeConversationMarkdownChunk(
    chunk([
      {
        kind: "toolCall",
        rowId: 1,
        toolCallId: "tool-1",
        toolName: "Read",
        status: "success",
        family: "file-read",
        outputText: "file content",
      },
    ]),
    context(),
  );
  assert.match(output, /<summary>读取 · 已完成 · Read<\/summary>/u);
  assert.match(output, /file content/u);
});

test("artifact 只输出元数据不含链接", () => {
  const output = serializeConversationMarkdownChunk(
    chunk([
      {
        kind: "artifact",
        rowId: 1,
        displayName: "report.pdf",
        artifactType: "pdf",
        sizeBytes: 1_048_576,
      },
    ]),
    context(),
  );
  assert.match(output, /- 📄 pdf · 1\.0 MB/u);
  assert.ok(!output.includes("http"), output);
  assert.ok(!output.includes("]("), output);
});

test("timelineMarker 按类型输出本地化文案，未知类型不输出", () => {
  const output = serializeConversationMarkdownChunk(
    chunk([
      { kind: "timelineMarker", rowId: 1, markerType: "compact" },
      { kind: "timelineMarker", rowId: 2, markerType: "modelChange" },
    ]),
    context(),
  );
  assert.match(output, /上下文已压缩/u);
  assert.match(output, /模型已切换/u);
  // 不得泄漏枚举名。
  assert.ok(!output.includes("goalVerify"), output);
});

test("turnHeader 输出轮次分隔与 row 自带时间戳（不使用当前时间）", () => {
  const output = serializeConversationMarkdownChunk(
    chunk([{ kind: "turnHeader", rowId: 1, startedAt: 1_700_000_000_000, durationMs: 65_000 }]),
    context(),
  );
  assert.match(output, /\n---\n/u);
  assert.match(output, /第 1 轮/u);
  assert.match(output, /耗时 1 分 5 秒/u);
  // 时间来自 row.startedAt（2023-11-14 UTC 前后），不是测试运行时刻。
  assert.ok(!output.includes(String(new Date().getFullYear())), output);
});

test("工具输出超 200000 字符时截断并追加截断说明", () => {
  const output = serializeConversationMarkdownChunk(
    chunk([
      {
        kind: "toolCall",
        rowId: 1,
        toolCallId: "tool-1",
        toolName: "Bash",
        status: "success",
        family: "shell",
        outputText: "a",
        truncatedChars: 1234,
      },
    ]),
    context(),
  );
  assert.match(output, /…（输出过长，已截断 1234 字符）/u);
});

test("未闭合的代码围栏不破坏输出结构", () => {
  const output = serializeConversationMarkdownChunk(
    chunk([{ kind: "assistantText", rowId: 1, text: "```ts\nconst a = 1;\n" }]),
    context(),
  );
  const fences = output.split("\n").filter((line) => /^\s*```/u.test(line));
  assert.equal(fences.length % 2, 0, output);
  assert.equal(balanceMarkdownCodeFences("```ts\ncode"), "```ts\ncode\n```");
  assert.equal(balanceMarkdownCodeFences("```\na\n```"), "```\na\n```");
});

test("空 rows 输出只有 head 与 tail", () => {
  const ctx = context();
  const head = serializeConversationMarkdownHead({ title: "标题", labels: ctx.labels });
  const body = serializeConversationMarkdownChunk(chunk([]), ctx);
  const tail = serializeConversationMarkdownTail(0, ctx.labels);
  assert.equal(body, "");
  assert.equal(tail, "");
  assert.match(head, /^# 标题\n/u);
});

test("tail 在 skippedRowCount 大于 0 时输出跳过计数", () => {
  const ctx = context();
  const tail = serializeConversationMarkdownTail(3, ctx.labels);
  assert.match(tail, /已跳过 3 项无法导出的内容/u);
});
