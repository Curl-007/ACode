import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCsvTableText,
  buildMarkdownTableText,
  readRowsFromTable,
} from "../src/markdown-table/markdownTableTextModel.js";

/**
 * markdown-table 批次 6 外迁（markdownTableTextModel.ts）的决策表单测。
 * 覆盖：Markdown 复制文本的转义与列对齐 × CSV 公式注入防护 / 引号转义 / BOM
 * × 表格 DOM 读取的空白归一与畸形行过滤。
 */

test("buildMarkdownTableText：空行数组返回空串", () => {
  assert.equal(buildMarkdownTableText([]), "");
});

test("buildMarkdownTableText：首行作表头 + 分隔行 + 正文", () => {
  assert.equal(
    buildMarkdownTableText([
      ["a", "b"],
      ["1", "2"],
    ]),
    "| a | b |\n| --- | --- |\n| 1 | 2 |",
  );
});

test("buildMarkdownTableText：短行按最大列数补空单元格", () => {
  assert.equal(
    buildMarkdownTableText([["a", "b", "c"], ["1"]]),
    "| a | b | c |\n| --- | --- | --- |\n| 1 |  |  |",
  );
});

test("buildMarkdownTableText：竖线与反斜杠转义、换行变 <br>", () => {
  assert.equal(
    buildMarkdownTableText([["a|b", "c\\d"], ["x\ny", "z"]]),
    "| a\\|b | c\\\\d |\n| --- | --- |\n| x<br>y | z |",
  );
});

test("buildMarkdownTableText：只有表头一行时也输出分隔行", () => {
  assert.equal(buildMarkdownTableText([["only"]]), "| only |\n| --- |");
});

test("buildCsvTableText：前置 UTF-8 BOM（Excel 编码识别）", () => {
  const csv = buildCsvTableText([["中文", "b"]]);
  assert.ok(csv.startsWith("\uFEFF"), "缺少 BOM 会让 Excel 按本地代码页解析中文");
  assert.equal(csv, "\uFEFF中文,b");
});

test("buildCsvTableText：行间用 CRLF 分隔", () => {
  assert.equal(buildCsvTableText([["a"], ["b"], ["c"]]), "\uFEFFa\r\nb\r\nc");
});

test("buildCsvTableText：含逗号/引号/换行的单元格加引号并双写引号", () => {
  assert.equal(
    buildCsvTableText([['a,b', 'c"d', "e\nf"]]),
    '\uFEFF"a,b","c""d","e\nf"',
  );
});

test("buildCsvTableText：公式前缀降级为纯文本（CSV 注入防护）", () => {
  for (const dangerous of ["=SUM(A1)", "+1+1", "-1+1", "@cmd", "\tlead", "\nlead"]) {
    const csv = buildCsvTableText([[dangerous]]);
    assert.ok(
      csv.includes(`'`),
      `公式型单元格 ${JSON.stringify(dangerous)} 必须以单引号前缀降级`,
    );
  }
});

test("buildCsvTableText：普通文本不加引号也不加前缀", () => {
  assert.equal(buildCsvTableText([["plain text"]]), "\uFEFFplain text");
});

test("buildCsvTableText：内含空格但非公式的文本保持原样", () => {
  assert.equal(buildCsvTableText([["  spaced  "]]), "\uFEFF  spaced  ");
});

test("readRowsFromTable：null 表格返回空数组", () => {
  assert.deepEqual(readRowsFromTable(null), []);
});

test("readRowsFromTable：单元格空白归一 + 空行过滤", () => {
  const makeCell = (text: string) => ({ textContent: text });
  const table = {
    querySelectorAll: () => [
      { querySelectorAll: () => [makeCell("  a \n b "), makeCell("c")] },
      { querySelectorAll: () => [] },
      { querySelectorAll: () => [makeCell("d")] },
    ],
  } as unknown as HTMLTableElement;

  assert.deepEqual(readRowsFromTable(table), [
    ["a b", "c"],
    ["d"],
  ]);
});

test("readRowsFromTable：textContent 为 null 时按空串归一", () => {
  const table = {
    querySelectorAll: () => [
      { querySelectorAll: () => [{ textContent: null }, { textContent: "x" }] },
    ],
  } as unknown as HTMLTableElement;

  assert.deepEqual(readRowsFromTable(table), [["", "x"]]);
});
