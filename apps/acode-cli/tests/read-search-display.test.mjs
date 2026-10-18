// read/search 结构化 display 装配（specs/tool-display-read-search.md）验收测试。
// 覆盖：R1 payload 形态与有界纪律、R2 fail-safe（畸形输出 → undefined）、
// URL 元数据 WeakMap 侧信道端到端、union 接线（contracts 侧校验通过）。
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

const { createReadResultDisplay, createSearchResultDisplay } = await import(
  "../packages/core/src/tool/executor/read-search-result-display.ts"
);
const { buildUrlReadOutput } = await import("../packages/core/src/tool/handlers/read-url.ts");
const { noteWebFetchProvenanceUrls, clearWebFetchProvenanceForTests } = await import(
  "../packages/core/src/tool/handlers/webfetch-provenance.ts"
);
const { putWebFetchCache } = await import("../packages/core/src/tool/handlers/webfetch-cache.ts");
const { clearWebFetchCacheForTests } = await import(
  "../packages/core/src/tool/handlers/webfetch.ts"
);
const { toolResultDisplayPayloadSchema } = await import(
  "../packages/contracts/src/tools/tool-result-metadata.ts"
);

const SESSION_ID = "sess-read-search-display";

function makeContext() {
  return {
    toolCallId: "call-1",
    traceId: "trace-1",
    abortSignal: new AbortController().signal,
    sessionId: SESSION_ID,
    workingDirectory: process.cwd(),
    workspaceRoot: process.cwd(),
  };
}

beforeEach(() => {
  clearWebFetchProvenanceForTests();
  clearWebFetchCacheForTests();
});

test("(R1) Read 文本输出 → kind:read（行窗数字如实），union 校验通过", () => {
  const display = createReadResultDisplay({
    type: "text",
    filePath: "/repo/src/a.ts",
    content: "x",
    numLines: 61,
    startLine: 120,
    totalLines: 3400,
  });
  assert.equal(display?.kind, "read");
  assert.equal(display.filePath, "/repo/src/a.ts");
  assert.equal(display.startLine, 120);
  assert.equal(display.numLines, 61);
  assert.equal(display.totalLines, 3400);
  assert.equal(display.truncated, undefined);
  assert.ok(toolResultDisplayPayloadSchema.safeParse(display).success);
});

test("(R1) 事实标志：conflictFooter→conflicts、preNumbered→summarized、截断双来源→truncated", () => {
  const conflicts = createReadResultDisplay({
    type: "text",
    filePath: "/repo/a.ts",
    content: "x",
    numLines: 1,
    startLine: 1,
    totalLines: 1,
    conflictFooter: "<<<<<<< markers: 2",
  });
  assert.equal(conflicts?.conflicts, true);
  assert.equal(conflicts?.summarized, undefined);

  const summarized = createReadResultDisplay({
    type: "text",
    filePath: "/repo/b.ts",
    content: "x",
    numLines: 1,
    startLine: 1,
    totalLines: 900,
    preNumbered: true,
    summaryFooter: "folded 12 spans",
  });
  assert.equal(summarized?.summarized, true);

  // summaryFooter 单独出现不置 summarized（URL 直读尾注的歧义防御，spec R2 注释）。
  const footerOnly = createReadResultDisplay({
    type: "text",
    filePath: "/repo/c.ts",
    content: "x",
    numLines: 1,
    startLine: 1,
    totalLines: 1,
    summaryFooter: "meta",
  });
  assert.equal(footerOnly?.summarized, undefined);

  const capped = createReadResultDisplay({
    type: "text",
    filePath: "/repo/d.ts",
    content: "x",
    numLines: 1,
    startLine: 1,
    totalLines: 1,
    truncatedByTokenCap: true,
  });
  assert.equal(capped?.truncated, true);
});

test("(R1/R2) 非文本输出与畸形输出 → undefined（fail-safe）", () => {
  assert.equal(
    createReadResultDisplay({ type: "image", base64: "a", mimeType: "image/png" }),
    undefined,
  );
  assert.equal(createReadResultDisplay({ type: "file_unchanged", filePath: "/a" }), undefined);
  assert.equal(createReadResultDisplay({ type: "text", filePath: "" }), undefined);
  assert.equal(createReadResultDisplay(undefined), undefined);
});

test("(R1) URL 直读元数据经 WeakMap 侧信道进 display（不解析 footer 文本）", async () => {
  const url = "https://example.com/display-meta";
  noteWebFetchProvenanceUrls(SESSION_ID, [url]);
  putWebFetchCache(url, {
    bytes: 12,
    content: "# Hello\nworld",
    contentType: "text/markdown",
    finalUrl: url,
    redirects: [],
    sizeBytes: 12,
    status: 200,
    statusText: "OK",
  });
  const output = await buildUrlReadOutput(url, { context: makeContext() });
  const display = createReadResultDisplay(output);
  assert.equal(display?.kind, "read");
  assert.equal(display.filePath, url);
  assert.deepEqual(display.url, {
    finalUrl: url,
    status: 200,
    contentType: "text/markdown",
    cacheHit: true,
  });
  assert.ok(toolResultDisplayPayloadSchema.safeParse(display).success);
  // 侧信道按对象身份命中：普通对象同形不携带 url。
  const copy = { ...output };
  assert.equal(createReadResultDisplay(copy)?.url, undefined);
});

test("(R1) Grep content 输出 → kind:search（mode/numMatches/numLines/filenames）", () => {
  const display = createSearchResultDisplay("Grep", {
    mode: "content",
    durationMs: 12,
    numFiles: 2,
    filenames: ["/repo/a.ts", "/repo/b.ts"],
    content: "a.ts:1:hit",
    numLines: 3,
    numMatches: 5,
    truncated: false,
  });
  assert.equal(display?.kind, "search");
  assert.equal(display.tool, "grep");
  assert.equal(display.mode, "content");
  assert.equal(display.numMatches, 5);
  assert.equal(display.numLines, 3);
  assert.equal(display.numFiles, 2);
  assert.deepEqual(display.filenames, ["/repo/a.ts", "/repo/b.ts"]);
  assert.ok(toolResultDisplayPayloadSchema.safeParse(display).success);
});

test("(R1) Glob 输出 → tool:glob，无 grep 专有字段", () => {
  const display = createSearchResultDisplay("Glob", {
    durationMs: 4,
    numFiles: 1,
    filenames: ["/repo/x.ts"],
    truncated: false,
  });
  assert.equal(display?.tool, "glob");
  assert.equal(display.mode, undefined);
  assert.equal(display.numMatches, undefined);
  assert.ok(toolResultDisplayPayloadSchema.safeParse(display).success);
});

test("(R1) 有界纪律：filenames > 20 条投影前 20 + filenamesTruncated；超长路径截断", () => {
  const many = Array.from({ length: 45 }, (_, i) => `/repo/file-${i}.ts`);
  const display = createSearchResultDisplay("Grep", {
    mode: "files_with_matches",
    durationMs: 30,
    numFiles: 45,
    filenames: many,
    truncated: true,
  });
  assert.equal(display.filenames.length, 20);
  assert.equal(display.filenamesTruncated, true);
  assert.equal(display.truncated, true);
  assert.equal(display.numFiles, 45);

  const longPath = `/repo/${"deep/".repeat(200)}file.ts`;
  const longDisplay = createSearchResultDisplay("Glob", {
    durationMs: 1,
    numFiles: 1,
    filenames: [longPath],
    truncated: false,
  });
  assert.ok(longDisplay.filenames[0].length <= 512);
  assert.ok(toolResultDisplayPayloadSchema.safeParse(longDisplay).success);
});

test("(R2) Grep/Glob 畸形输出 → undefined（schema safeParse fail-safe）", () => {
  assert.equal(createSearchResultDisplay("Grep", { mode: "content" }), undefined);
  assert.equal(createSearchResultDisplay("Glob", null), undefined);
  assert.equal(
    createSearchResultDisplay("Grep", {
      mode: "wat",
      durationMs: 1,
      numFiles: 1,
      filenames: [],
      truncated: false,
    }),
    undefined,
  );
});
