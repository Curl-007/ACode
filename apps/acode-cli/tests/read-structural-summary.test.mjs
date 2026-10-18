// read 结构化摘要与路径选择器（specs/read-structural-summary.md）验收测试。
// 覆盖：R1 资格门零回归、R2 折叠矩阵与行号锚定、R3 选择器解析（Windows 盘符
// 安全）与阶段 1 折算、R4 尾注、R5 缓存、R6 冲突协同、渲染顺序。
import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";

const {
  summarizeWholeFileRead,
  foldSourceStructurally,
  resolveReadSummaryConfig,
  splitPathSelector,
  resolveSelectorWindow,
  sliceLineRanges,
  clearReadSummaryCache,
  readFoldParseCallCount,
  isSummarizableCodePath,
  isProsePath,
} = await import("../packages/core/src/tool/read-summary/index.ts");
const { applyPathSelector } = await import(
  "../packages/core/src/tool/handlers/read-selector-branch.ts"
);
const { formatReadTextOutput } = await import(
  "../packages/core/src/tool/handlers/read-text.ts"
);

beforeEach(() => clearReadSummaryCache());

const CONFIG = resolveReadSummaryConfig({}, { minTotalLines: 20 });

function bigFunction(lines) {
  return `function big() {\n${Array.from({ length: lines }, (_, i) => `  const v${i} = ${i};`).join("\n")}\n}\n`;
}

function makeFile({ functions = 1, bodyLines = 60, filler = 0 } = {}) {
  const parts = ["/** 顶部文档 */", "import { a } from './a';"];
  for (let f = 0; f < functions; f += 1) {
    parts.push(`/** fn${f} 文档 */`);
    parts.push(bigFunction(bodyLines).trimEnd());
  }
  for (let i = 0; i < filler; i += 1) parts.push(`const filler${i} = ${i};`);
  return `${parts.join("\n")}\n`;
}

// ── R2 折叠矩阵 ─────────────────────────────────────────────

test("R2: 长函数体折叠为单行标记，签名与 JSDoc 保留，行号锚定原文", () => {
  const text = makeFile({ functions: 1, bodyLines: 60 });
  const fold = foldSourceStructurally({
    fileName: "/repo/big.ts",
    text,
    displayPath: "big.ts",
    config: CONFIG,
  });
  assert.ok(fold);
  assert.equal(fold.foldedBlocks, 1);
  const marker = fold.segments.find((segment) => segment.kind === "fold");
  assert.ok(marker.marker.includes("body folded"));
  assert.match(marker.marker, /read "big\.ts:(\d+)-(\d+)" to expand/);
  // 展开区间与原文逐字节相等（R2 行号锚定验收）。
  const [, startRaw, endRaw] = /read "big\.ts:(\d+)-(\d+)" to expand/.exec(marker.marker);
  const originalLines = text.split("\n");
  const expanded = originalLines.slice(Number(startRaw) - 1, Number(endRaw));
  // 折叠区间吃「体内部行」：签名行（function big() {）与收尾 } 保留在 keep 段，
  // 展开区间首尾都是体内容行（结构可读性设计，见 fold.ts considerBody 注释）。
  assert.ok(expanded[0].trim().startsWith("const v0"), `首行应是体内容: ${expanded[0]}`);
  assert.equal(expanded[expanded.length - 1].trim(), "const v59 = 59;");
  assert.equal(expanded.length, marker.endLine - marker.startLine + 1);
  // JSDoc 与签名在 keep 段。
  const kept = fold.segments
    .filter((segment) => segment.kind === "keep")
    .flatMap((segment) => originalLines.slice(segment.startLine - 1, segment.endLine));
  assert.ok(kept.includes("/** fn0 文档 */"));
  assert.ok(kept.some((line) => line.startsWith("function big() {")));
  assert.ok(kept.includes("}"), "收尾大括号保留");
});

test("R2: 小函数（≤unfoldLimit）整体保留；全平铺脚本不折叠（null）", () => {
  const small = `function tiny() {\n  return 1;\n}\n${"const x = 1;\n".repeat(30)}`;
  assert.equal(
    foldSourceStructurally({ fileName: "/r/s.ts", text: small, displayPath: "s.ts", config: CONFIG }),
    null,
  );
});

test("R2: 连续 import 超阈值折叠中段；interface 超长折叠成员区", () => {
  const imports = Array.from({ length: 14 }, (_, i) => `import { m${i} } from "./m${i}";`).join("\n");
  const iface = `interface Big {\n${Array.from({ length: 50 }, (_, i) => `  f${i}: number;`).join("\n")}\n}\n`;
  const text = `${imports}\n${iface}${"const pad = 0;\n".repeat(20)}`;
  const fold = foldSourceStructurally({ fileName: "/r/i.ts", text, displayPath: "i.ts", config: CONFIG });
  assert.ok(fold);
  const markers = fold.segments.filter((s) => s.kind === "fold").map((s) => s.marker);
  assert.ok(markers.some((m) => m.includes("imports (")), "import 段应折叠");
  assert.ok(markers.some((m) => m.includes("members folded")), "interface 成员区应折叠");
});

// ── R1 资格门（零回归面） ───────────────────────────────────

test("R1: 资格门——小文件/非代码/prose/开关关闭/冲突文件一律不摘要", () => {
  const big = makeFile({ bodyLines: 60, filler: 40 });
  assert.equal(summarizeWholeFileRead({ absolutePath: "/r/a.ts", displayPath: "a.ts", text: big, config: CONFIG }).summarized, true);
  const cfg = resolveReadSummaryConfig({}, { minTotalLines: 10_000 });
  assert.equal(summarizeWholeFileRead({ absolutePath: "/r/a.ts", displayPath: "a.ts", text: big, config: cfg }).summarized, false);
  assert.equal(summarizeWholeFileRead({ absolutePath: "/r/a.py", displayPath: "a.py", text: big, config: CONFIG }).summarized, false);
  assert.equal(summarizeWholeFileRead({ absolutePath: "/r/a.md", displayPath: "a.md", text: big, config: CONFIG }).summarized, false);
  const off = resolveReadSummaryConfig({ ACODE_READ_SUMMARIZE: "0" }, { minTotalLines: 20 });
  assert.equal(summarizeWholeFileRead({ absolutePath: "/r/a.ts", displayPath: "a.ts", text: big, config: off }).summarized, false);
  assert.equal(summarizeWholeFileRead({ absolutePath: "/r/a.ts", displayPath: "a.ts", text: big, hasConflicts: true, config: CONFIG }).summarized, false);
  assert.equal(isSummarizableCodePath("/x/Y.TSX"), true);
  assert.equal(isProsePath("/x/notes.TXT"), true);
});

// ── R4/R5 摘要输出与缓存 ────────────────────────────────────

test("R4+R5: 摘要输出含原行号与尾注；同内容缓存命中不重复解析", () => {
  const text = makeFile({ bodyLines: 60, filler: 40 });
  const first = summarizeWholeFileRead({ absolutePath: "/r/c.ts", displayPath: "c.ts", text, config: CONFIG });
  assert.ok(first.summarized);
  assert.match(first.numberedText, /^\d+\t/m, "正文行以原行号+制表符开头");
  assert.match(first.footer, /structural summary/);
  assert.match(first.footer, /ACODE_READ_SUMMARIZE=0/);
  assert.ok(first.foldedBlocks >= 1 && first.foldedLines > 40);
  const parsesAfterFirst = readFoldParseCallCount();
  const second = summarizeWholeFileRead({ absolutePath: "/r/c.ts", displayPath: "c.ts", text, config: CONFIG });
  assert.equal(readFoldParseCallCount(), parsesAfterFirst, "同内容二次读必须缓存命中");
  assert.equal(second.numberedText, first.numberedText);
  summarizeWholeFileRead({ absolutePath: "/r/c.ts", displayPath: "c.ts", text: `${text}// changed\n`, config: CONFIG });
  assert.equal(readFoldParseCallCount(), parsesAfterFirst + 1, "内容变化必须重新解析");
});

// ── R3 选择器解析（平台对称矩阵） ───────────────────────────

test("R3: 选择器解析矩阵——区间/单行/开区间/raw/组合/tail/多区间", () => {
  assert.deepEqual(splitPathSelector("src/a.ts:10-20"), { path: "src/a.ts", selector: { kind: "lines", ranges: [{ start: 10, end: 20 }] } });
  assert.deepEqual(splitPathSelector("src/a.ts:10").selector, { kind: "lines", ranges: [{ start: 10, end: 10 }] });
  assert.deepEqual(splitPathSelector("src/a.ts:10-").selector, { kind: "lines", ranges: [{ start: 10 }] });
  assert.deepEqual(splitPathSelector("src/a.ts:raw").selector, { kind: "raw" });
  assert.deepEqual(splitPathSelector("src/a.ts:raw:100-140").selector, { kind: "raw", ranges: [{ start: 100, end: 140 }] });
  assert.deepEqual(splitPathSelector("app.log:-50").selector, { kind: "tail", count: 50 });
  assert.deepEqual(splitPathSelector("src/a.ts:1-2,4-5").selector, { kind: "lines", ranges: [{ start: 1, end: 2 }, { start: 4, end: 5 }] });
  assert.deepEqual(splitPathSelector("src/a.ts:conflicts").selector, { kind: "conflicts" });
});

test("R3: Windows 盘符与 scheme 零误拆；非文法尾段按路径处理", () => {
  // 盘符冒号后是路径体，不匹配文法 → 整串是路径。
  assert.deepEqual(splitPathSelector("C:\\work\\a.ts"), { path: "C:\\work\\a.ts", selector: { kind: "none" } });
  // 盘符路径 + 合法选择器 → 正确拆分。
  assert.deepEqual(splitPathSelector("C:/work/a.ts:3-4"), { path: "C:/work/a.ts", selector: { kind: "lines", ranges: [{ start: 3, end: 4 }] } });
  // scheme URI 不被拆（skill:// 尾段是路径体；conflict://1 尾段 "//1" 不匹配）。
  assert.equal(splitPathSelector("skill://demo/references/guide.md").selector.kind, "none");
  assert.equal(splitPathSelector("conflict://1").selector.kind, "none");
  // 非文法尾段（真实文件名含冒号的形态）整串按路径。
  assert.deepEqual(splitPathSelector("notes:raw-ish"), { path: "notes:raw-ish", selector: { kind: "none" } });
  assert.deepEqual(splitPathSelector(":raw"), { path: ":raw", selector: { kind: "none" } });
});

test("R3: applyPathSelector 阶段 1 折算——单区间→offset/limit，raw→suppressSummary，阶段 2 形态 fail-loud", () => {
  const context = { toolCallId: "t1", toolName: "Read" };
  assert.deepEqual(applyPathSelector("a.ts:10-20", context), { path: "a.ts", offset: 10, limit: 11 });
  assert.deepEqual(applyPathSelector("a.ts:10-", context), { path: "a.ts", offset: 10 });
  assert.deepEqual(applyPathSelector("a.ts:raw", context), { path: "a.ts", suppressSummary: true });
  assert.deepEqual(applyPathSelector("a.ts:raw:5-8", context), { path: "a.ts", offset: 5, limit: 4, suppressSummary: true });
  assert.deepEqual(applyPathSelector("a.ts", context), { path: "a.ts" });
  for (const form of ["a.ts:-20", "a.ts:1-2,4-5", "a.ts:conflicts"]) {
    assert.throws(() => applyPathSelector(form, context), (error) => {
      assert.match(error.message, /not supported yet/);
      assert.equal(error.context?.recoverable ?? true, true);
      return true;
    }, `${form} 必须 fail-loud`);
  }
});

test("R3: 窗口折算与多区间切片纯函数（阶段 2 预置面）", () => {
  assert.deepEqual(resolveSelectorWindow({ kind: "tail", count: 20 }, 100), { startLine: 81, endLine: 100 });
  assert.deepEqual(resolveSelectorWindow({ kind: "lines", ranges: [{ start: 200, end: 210 }] }, 100).error !== undefined, true);
  const lines = ["l1", "l2", "l3", "l4", "l5"];
  const sliced = sliceLineRanges(lines, [{ start: 1, end: 2 }, { start: 4, end: 5 }], 5);
  assert.equal(sliced.text, "l1\nl2\n⋯ [lines 3-3 omitted]\nl4\nl5");
  assert.equal(sliced.startLine, 1);
});

// ── 渲染顺序（R4/R6）与零回归 ───────────────────────────────

test("渲染: preNumbered 跳过二次编号；尾注顺序=摘要在前冲突在后；普通输出零变化", () => {
  const numbered = "10\tconst a = 1;\n11\t// … body folded";
  const summaryOut = formatReadTextOutput({
    type: "text",
    filePath: "/r/a.ts",
    content: numbered,
    numLines: 2,
    startLine: 10,
    totalLines: 100,
    preNumbered: true,
    summaryFooter: "SUMMARY-FOOTER",
  });
  assert.ok(summaryOut.startsWith("10\tconst a = 1;"), "preNumbered 正文不得二次编号");
  assert.match(summaryOut, /SUMMARY-FOOTER$/);

  const bothOut = formatReadTextOutput({
    type: "text",
    filePath: "/r/a.ts",
    content: "x",
    numLines: 1,
    startLine: 1,
    totalLines: 1,
    summaryFooter: "S",
    conflictFooter: "C",
  });
  assert.ok(bothOut.indexOf("S") < bothOut.indexOf("C"), "摘要尾注在冲突尾注前");

  const plain = formatReadTextOutput({
    type: "text",
    filePath: "/r/a.ts",
    content: "hello\nworld",
    numLines: 2,
    startLine: 1,
    totalLines: 2,
  });
  assert.equal(plain, "1\thello\n2\tworld", "无摘要/冲突字段时输出与既有逐字节一致");
});
