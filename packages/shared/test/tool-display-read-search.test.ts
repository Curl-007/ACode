// read/search display 的 v4 wire 镜像（apps/acode-cli/specs/tool-display-read-search.md R3）。
// 回归类：CUA display 曾因 union 缺成员被 zod 整块 strip——本测试钉住新成员在
// toolOutputSchema.display 全链保真，且 call 侧 toolCallDisplaySchema 不接受结果侧 kind。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  readToolResultDisplaySchema,
  searchToolResultDisplaySchema,
  toolCallDisplaySchema,
  toolOutputSchema,
} from "../src/acode-protocol-v4/toolDisplay.js";

const READ_PAYLOAD = {
  kind: "read",
  filePath: "/repo/src/a.ts",
  startLine: 120,
  numLines: 61,
  totalLines: 3400,
  truncated: true,
  conflicts: true,
} as const;

const READ_URL_PAYLOAD = {
  kind: "read",
  filePath: "https://example.com/doc",
  startLine: 1,
  numLines: 10,
  totalLines: 10,
  url: {
    finalUrl: "https://example.com/doc",
    status: 200,
    contentType: "text/markdown",
    cacheHit: true,
  },
} as const;

const SEARCH_PAYLOAD = {
  kind: "search",
  tool: "grep",
  mode: "content",
  numFiles: 2,
  numMatches: 5,
  numLines: 3,
  filenames: ["/repo/a.ts", "/repo/b.ts"],
  filenamesTruncated: true,
} as const;

test("schema 直判：read/search 合法形态通过", () => {
  assert.ok(readToolResultDisplaySchema.safeParse(READ_PAYLOAD).success);
  assert.ok(readToolResultDisplaySchema.safeParse(READ_URL_PAYLOAD).success);
  assert.ok(searchToolResultDisplaySchema.safeParse(SEARCH_PAYLOAD).success);
});

test("toolOutputSchema.display 全链保真（CUA strip 回归类）：parse 后字段完整", () => {
  const parsed = toolOutputSchema.parse({ text: "1\tline", display: READ_PAYLOAD });
  assert.deepEqual(parsed.display, READ_PAYLOAD);
  const parsedSearch = toolOutputSchema.parse({ text: "hits", display: SEARCH_PAYLOAD });
  assert.deepEqual(parsedSearch.display, SEARCH_PAYLOAD);
});

test("strict 纪律：字段表外键 / 非法值被拒（display 被剥为 undefined，不炸整条 row）", () => {
  assert.equal(
    toolOutputSchema.parse({
      text: "x",
      display: { ...READ_PAYLOAD, content: "正文不允许进 display" },
    }).display,
    undefined,
  );
  assert.equal(
    toolOutputSchema.parse({ text: "x", display: { ...SEARCH_PAYLOAD, numFiles: -1 } }).display,
    undefined,
  );
  assert.ok(readToolResultDisplaySchema.safeParse({ ...READ_PAYLOAD, extra: 1 }).success === false);
});

test("R3 边界：结果侧 kind 不进 call 侧 toolCallDisplaySchema", () => {
  assert.equal(toolCallDisplaySchema.safeParse(READ_PAYLOAD).success, false);
  assert.equal(toolCallDisplaySchema.safeParse(SEARCH_PAYLOAD).success, false);
});
