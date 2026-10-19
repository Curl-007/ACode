import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// specs/fs-hotpath-mechanisms.md R2：gitignore 遍历——规则排除、negation、
// 目录规则剪子树、node_modules 兜底排除、ACODE_FS_NO_IGNORE 逃生口。

const { createNodeFileSystemAdapter } = await import("../packages/adapters/src/fs/index.ts");
const { invalidateFsScanCache } = await import("../packages/adapters/src/fs/scan-cache.ts");
const { GitignoreWalker } = await import("../packages/adapters/src/fs/gitignore-matcher.ts");

async function makeTree(root) {
  await writeFile(join(root, ".gitignore"), "*.log\nbuild/\n!keep.log\n", "utf8");
  await writeFile(join(root, "keep.txt"), "k", "utf8");
  await writeFile(join(root, "noise.log"), "n", "utf8");
  await writeFile(join(root, "keep.log"), "k", "utf8");
  await mkdir(join(root, "build"));
  await writeFile(join(root, "build", "out.js"), "o", "utf8");
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "main.ts"), "m", "utf8");
  await mkdir(join(root, "src", "build"));
  await writeFile(join(root, "src", "build", "mid.ts"), "m", "utf8");
}

async function listFiles(adapter, root, pattern = "**/*") {
  const result = await adapter.searchFiles({ path: root, pattern });
  return result.files.map((file) => file.slice(root.length + 1).replaceAll("\\", "/")).sort();
}

test("gitignore: rules exclude files, negation restores, directory rule prunes subtree", async () => {
  const root = await mkdtemp(join(tmpdir(), "acode-gitignore-"));
  try {
    invalidateFsScanCache();
    await makeTree(root);
    const adapter = createNodeFileSystemAdapter();
    const files = await listFiles(adapter, root);

    assert.ok(files.includes("keep.txt"));
    assert.ok(files.includes("keep.log"), "!keep.log negation 必须恢复");
    assert.ok(files.includes("src/main.ts"));
    assert.ok(!files.some((file) => file.endsWith(".log") && file !== "keep.log"), "*.log 必须排除");
    assert.ok(!files.some((file) => file.startsWith("build/")), "build/ 目录规则必须剪枝");
    assert.ok(!files.includes("src/build/mid.ts"), "build/ 规则必须剪掉任意层级的 build 子树");
  } finally {
    invalidateFsScanCache();
    await rm(root, { recursive: true, force: true });
  }
});

test("gitignore: node_modules is excluded by fallback rule even without .gitignore", async () => {
  const root = await mkdtemp(join(tmpdir(), "acode-nm-fallback-"));
  try {
    invalidateFsScanCache();
    await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(root, "node_modules", "pkg", "index.js"), "nm", "utf8");
    await writeFile(join(root, "real.txt"), "r", "utf8");

    const adapter = createNodeFileSystemAdapter();
    const files = await listFiles(adapter, root);
    assert.ok(files.includes("real.txt"));
    assert.ok(!files.some((file) => file.includes("node_modules")), "无 .gitignore 时 node_modules 由兜底规则排除");
  } finally {
    invalidateFsScanCache();
    await rm(root, { recursive: true, force: true });
  }
});

test("gitignore: ACODE_FS_NO_IGNORE escape hatch restores old inclusive behavior", async () => {
  const root = await mkdtemp(join(tmpdir(), "acode-no-ignore-"));
  const previous = process.env.ACODE_FS_NO_IGNORE;
  try {
    invalidateFsScanCache();
    await writeFile(join(root, ".gitignore"), "vendor/\n", "utf8");
    await mkdir(join(root, "vendor"));
    await writeFile(join(root, "vendor", "lib.js"), "v", "utf8");
    await mkdir(join(root, "node_modules"));
    await writeFile(join(root, "node_modules", "dep.js"), "d", "utf8");
    await writeFile(join(root, "app.js"), "a", "utf8");

    process.env.ACODE_FS_NO_IGNORE = "1";
    const adapter = createNodeFileSystemAdapter();
    const files = await listFiles(adapter, root);
    assert.ok(files.includes("vendor/lib.js"), "逃生口下 gitignore 不再生效");
    assert.ok(files.includes("node_modules/dep.js"), "逃生口下 node_modules 兜底也关闭");
    assert.ok(files.includes("app.js"));
  } finally {
    if (previous === undefined) delete process.env.ACODE_FS_NO_IGNORE;
    else process.env.ACODE_FS_NO_IGNORE = previous;
    invalidateFsScanCache();
    await rm(root, { recursive: true, force: true });
  }
});

test("gitignore walker: deepest matching level decides; only-directory rules need trailing slash", async () => {
  const root = await mkdtemp(join(tmpdir(), "acode-gitignore-unit-"));
  try {
    await writeFile(join(root, ".gitignore"), "*.tmp\n!special.tmp\ndist/\n", "utf8");
    await mkdir(join(root, "sub"));
    await writeFile(join(root, "sub", ".gitignore"), "!special.tmp\nkeep-root-off.tmp\n", "utf8");

    const walker = new GitignoreWalker(root, true);
    // 根层：*.tmp 排除，!special.tmp 恢复。
    assert.equal(await walker.isIgnored("plain.tmp", false), true);
    // 子目录 !special.tmp 是更深层的明确匹配，覆盖根层 *.tmp。
    assert.equal(await walker.isIgnored("sub/special.tmp", false), false);
    // 子目录 keep-root-off.tmp 只在子层排除。
    assert.equal(await walker.isIgnored("sub/keep-root-off.tmp", false), true);
    // dist/ 仅目录规则：目录 test（尾斜杠）命中，文件 test 不命中。
    assert.equal(await walker.isIgnored("dist", true), true);
    assert.equal(await walker.isIgnored("dist", false), false);
    // 目录规则剪枝整棵子树：dist 内文件经 dist/ 目录段即被判忽略。
    assert.equal(await walker.isIgnored("dist/inner.js", false), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("gitignore: JS grep engine respects gitignore alongside glob engine parity", async () => {
  const root = await mkdtemp(join(tmpdir(), "acode-gitignore-grep-"));
  try {
    invalidateFsScanCache();
    await writeFile(join(root, ".gitignore"), "generated/\n", "utf8");
    await mkdir(join(root, "generated"));
    await writeFile(join(root, "generated", "auto.ts"), "const needle = 1;", "utf8");
    await writeFile(join(root, "hand.ts"), "const needle = 2;", "utf8");

    const adapter = createNodeFileSystemAdapter({ textSearchEngine: "javascript" });
    const result = await adapter.searchText({ path: root, pattern: "needle" });
    assert.deepEqual(
      result.files.map((file) => file.slice(root.length + 1).replaceAll("\\", "/")).sort(),
      ["hand.ts"],
      "JS 兜底引擎必须同样尊重 gitignore",
    );
  } finally {
    invalidateFsScanCache();
    await rm(root, { recursive: true, force: true });
  }
});
