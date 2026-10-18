import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// specs/fs-hotpath-mechanisms.md R5：grep 预算三项——maxCountPerFile 封顶、
// 坏 brace pattern 容错（glob 与正则两个面）、超 4MiB 文件 JS 引擎只读前缀。

const { createNodeFileSystemAdapter } = await import("../packages/adapters/src/fs/index.ts");
const { invalidateFsScanCache } = await import("../packages/adapters/src/fs/scan-cache.ts");
const { sanitizeRipgrepGlobPattern, escapeRegexBraces, hasUnbalancedBraces } = await import(
  "../packages/adapters/src/fs/index.ts"
);

async function makeHotDir(root) {
  const lines = [];
  for (let index = 0; index < 300; index += 1) {
    lines.push(`needle line ${index}`);
  }
  await writeFile(join(root, "hot.txt"), `${lines.join("\n")}\n`, "utf8");
  await writeFile(join(root, "cold.txt"), "needle once\n", "utf8");
}

test("grep budget: JS engine caps per-file match count at the internal budget", async () => {
  const root = await mkdtemp(join(tmpdir(), "acode-grep-cap-"));
  try {
    invalidateFsScanCache();
    await makeHotDir(root);
    const adapter = createNodeFileSystemAdapter({ textSearchEngine: "javascript" });

    const counted = await adapter.searchText({ path: root, pattern: "needle", outputMode: "count" });
    const hot = counted.entries.find((entry) => entry.path.endsWith("hot.txt"));
    assert.ok(hot, "热文件必须出现在计数结果");
    assert.equal(hot.count, 250, "单文件命中必须封顶在内部预算");
    assert.ok(counted.numMatches >= 251, "多文件总命中不受单文件上限压制");

    const content = await adapter.searchText({
      path: join(root, "hot.txt"),
      pattern: "needle",
      outputMode: "content",
    });
    const hotContentLines = content.entries.filter((entry) => entry.matched);
    assert.equal(hotContentLines.length, 250, "content 模式同样封顶（单文件目标不受 headLimit 切片干扰）");
  } finally {
    invalidateFsScanCache();
    await rm(root, { recursive: true, force: true });
  }
});

test("grep budget: ripgrep engine caps per-file match count via --max-count", async () => {
  const root = await mkdtemp(join(tmpdir(), "acode-grep-rg-cap-"));
  try {
    invalidateFsScanCache();
    await makeHotDir(root);
    // 默认引擎（bundled ripgrep）。
    const adapter = createNodeFileSystemAdapter();
    const counted = await adapter.searchText({ path: root, pattern: "needle", outputMode: "count" });
    const hot = counted.entries.find((entry) => entry.path.endsWith("hot.txt"));
    assert.ok(hot, "ripgrep 计数结果必须包含热文件");
    assert.equal(hot.count, 250, "--max-count 必须把热文件计数封顶在预算");
  } finally {
    invalidateFsScanCache();
    await rm(root, { recursive: true, force: true });
  }
});

test("grep budget: unbalanced-brace glob degrades to literal instead of failing the search", async () => {
  const root = await mkdtemp(join(tmpdir(), "acode-grep-brace-"));
  try {
    invalidateFsScanCache();
    await writeFile(join(root, "app.ts"), "const needle = 1;", "utf8");
    const adapter = createNodeFileSystemAdapter();

    // glob 层容错：`*.{ts,js` 未配对 → 不抛 invalid_pattern，降级为字面匹配（0 命中）。
    const result = await adapter.searchText({
      path: root,
      pattern: "needle",
      glob: "*.{ts,js",
    });
    assert.equal(result.numMatches >= 0, true);
    // JS 兜底引擎同样不得失败。
    const jsAdapter = createNodeFileSystemAdapter({ textSearchEngine: "javascript" });
    const jsResult = await jsAdapter.searchText({ path: root, pattern: "needle", glob: "*.{ts,js" });
    assert.equal(jsResult.numMatches >= 0, true);
  } finally {
    invalidateFsScanCache();
    await rm(root, { recursive: true, force: true });
  }
});

test("grep budget: unbalanced-brace regex falls back to literal via one retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "acode-grep-brace-regex-"));
  try {
    invalidateFsScanCache();
    // `a{2` 作为正则是未闭合区间；作为字面量可命中文件内容 "xa{2y"。
    await writeFile(join(root, "lit.txt"), "xa{2y", "utf8");
    const jsAdapter = createNodeFileSystemAdapter({ textSearchEngine: "javascript" });
    const jsResult = await jsAdapter.searchText({ path: root, pattern: "a{2" });
    assert.equal(jsResult.numMatches, 1, "JS 引擎 brace 转义重试必须救回字面 pattern");

    const rgAdapter = createNodeFileSystemAdapter();
    const rgResult = await rgAdapter.searchText({ path: root, pattern: "a{2" });
    assert.equal(rgResult.numMatches, 1, "ripgrep 引擎 brace 转义重试必须救回字面 pattern");
  } finally {
    invalidateFsScanCache();
    await rm(root, { recursive: true, force: true });
  }
});

test("grep budget: files over 4MiB are searched prefix-only in the JS engine", async () => {
  const root = await mkdtemp(join(tmpdir(), "acode-grep-prefix-"));
  try {
    invalidateFsScanCache();
    const chunk = "x".repeat(1024);
    const head = [`early-needle`, ...Array.from({ length: 1024 }, () => chunk)].join("\n");
    const content = `${head}\n`;
    // 前缀外再垫 >4MiB 的体量，把 late-needle 推到 4MiB 之后。
    const filler = `${Array.from({ length: 5 * 1024 }, () => chunk).join("\n")}\n`;
    await writeFile(join(root, "big.txt"), `${content}${filler}late-needle\n`, "utf8");

    const jsAdapter = createNodeFileSystemAdapter({ textSearchEngine: "javascript" });
    const result = await jsAdapter.searchText({ path: root, pattern: "needle", outputMode: "content" });
    const texts = result.entries.map((entry) => entry.text);
    assert.ok(texts.some((text) => text.includes("early-needle")), "前缀内命中必须报告");
    assert.ok(!texts.some((text) => text.includes("late-needle")), "4MiB 之后的命中必须被前缀预算截断");
  } finally {
    invalidateFsScanCache();
    await rm(root, { recursive: true, force: true });
  }
});

test("grep budget: brace helpers escape unbalanced patterns only", () => {
  assert.equal(hasUnbalancedBraces("*.{ts,js}"), false);
  assert.equal(hasUnbalancedBraces("*.{ts,js"), true);
  assert.equal(hasUnbalancedBraces("a}b"), true);
  assert.equal(hasUnbalancedBraces("plain"), false);
  assert.equal(sanitizeRipgrepGlobPattern("*.{ts,js"), "*.\\{ts,js");
  assert.equal(sanitizeRipgrepGlobPattern("*.{ts,js}"), "*.{ts,js}");
  assert.equal(escapeRegexBraces("a{2"), "a\\{2");
  assert.equal(escapeRegexBraces("a\\{b"), "a\\{b");
});
