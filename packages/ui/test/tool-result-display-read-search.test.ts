// UI 侧 read/search display 查表解析（apps/acode-cli/specs/tool-display-read-search.md R4）：
// shared strict schema 唯一校验通道；非法形态 → undefined（渲染层走 fallback，不崩溃）。
import assert from "node:assert/strict";
import { test } from "node:test";
import { readToolResultDisplay } from "../src/ToolCallBlocks/toolResultDisplay.js";

const READ_PAYLOAD = {
  kind: "read",
  filePath: "/repo/src/a.ts",
  startLine: 1,
  numLines: 400,
  totalLines: 400,
  summarized: true,
};

const SEARCH_PAYLOAD = {
  kind: "search",
  tool: "grep",
  mode: "files_with_matches",
  numFiles: 12,
  numMatches: 30,
  filenames: ["/repo/a.ts"],
  truncated: true,
};

test("raw.display 命中：read/search 解析保真（schema 推断类型）", () => {
  const read = readToolResultDisplay({ display: READ_PAYLOAD });
  assert.equal(read?.kind, "read");
  if (read?.kind === "read") {
    assert.equal(read.filePath, "/repo/src/a.ts");
    assert.equal(read.summarized, true);
    assert.equal(read.truncated, undefined);
  }
  const search = readToolResultDisplay({ display: SEARCH_PAYLOAD });
  assert.equal(search?.kind, "search");
  if (search?.kind === "search") {
    assert.equal(search.numMatches, 30);
    assert.equal(search.truncated, true);
  }
});

test("raw.output.display 通道同样命中（v4 canonical 位置）", () => {
  const parsed = readToolResultDisplay({ output: { display: READ_PAYLOAD } });
  assert.equal(parsed?.kind, "read");
});

test("非法形态 → undefined（fallback 不崩溃）：缺字段 / 多字段 / 错类型", () => {
  assert.equal(
    readToolResultDisplay({ display: { ...READ_PAYLOAD, filePath: undefined } }),
    undefined,
  );
  assert.equal(readToolResultDisplay({ display: { ...READ_PAYLOAD, extra: "x" } }), undefined);
  assert.equal(
    readToolResultDisplay({ display: { ...SEARCH_PAYLOAD, tool: "ripgrep" } }),
    undefined,
  );
  assert.equal(readToolResultDisplay({ display: { kind: "read" } }), undefined);
  assert.equal(readToolResultDisplay({}), undefined);
  assert.equal(readToolResultDisplay(undefined), undefined);
});

test("URL 直读 display：url 元数据保真", () => {
  const parsed = readToolResultDisplay({
    display: {
      ...READ_PAYLOAD,
      filePath: "https://example.com/doc",
      url: {
        finalUrl: "https://example.com/doc",
        status: 200,
        contentType: "text/markdown",
        cacheHit: true,
      },
    },
  });
  assert.equal(parsed?.kind, "read");
  if (parsed?.kind === "read") {
    assert.equal(parsed.url?.status, 200);
    assert.equal(parsed.url?.cacheHit, true);
  }
});
