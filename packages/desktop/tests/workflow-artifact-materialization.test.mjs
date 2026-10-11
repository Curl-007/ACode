import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { transpileModule, ModuleKind } from "typescript";
import { readFile } from "node:fs/promises";

// specs/workflow-artifact-materialization.md 验收 2/3/5：
// 路径段清洗与防穿越、Windows 保留名、>20MiB 拒绝且不写文件、原子写与幂等（mock fs）。
const nodeRequire = createRequire(import.meta.url);
const root = new URL("../", import.meta.url);
const sharedModule = await import("@acode/shared");

async function readSource(relative) {
  return readFile(new URL(relative, root), "utf8");
}

async function loadMain(relative, imports = {}) {
  const source = await readSource(`src/main/${relative}.ts`);
  const output = transpileModule(source, {
    compilerOptions: { module: ModuleKind.CommonJS },
  }).outputText;
  const exports = {};
  new Function("require", "exports", output)((name) => {
    if (name.startsWith("node:")) {
      return nodeRequire(name);
    }
    assert.ok(name in imports, `unexpected runtime import: ${name}`);
    return imports[name];
  }, exports);
  return exports;
}

const artifactModule = await loadMain("desktopWorkflowArtifactIpc", {
  electron: { ipcMain: { handle() {} } },
  "@acode/shared": sharedModule,
  "@acode/services/node": { getACodeDataRootDir: () => "/unused-root" },
});

class MemoryFs {
  constructor() {
    this.files = new Map();
    this.ops = [];
    this.failNextRename = false;
  }
  async mkdir(path) {
    this.ops.push(["mkdir", path]);
  }
  async readFile(path) {
    if (!this.files.has(path)) {
      const error = new Error(`ENOENT: ${path}`);
      error.code = "ENOENT";
      throw error;
    }
    return this.files.get(path);
  }
  async writeFile(path, data, options) {
    if (options?.flag === "wx" && this.files.has(path)) {
      const error = new Error(`EEXIST: ${path}`);
      error.code = "EEXIST";
      throw error;
    }
    this.ops.push(["writeFile", path, options?.flag ?? "w"]);
    this.files.set(path, Buffer.from(data));
  }
  async rename(from, to) {
    if (this.failNextRename) {
      this.failNextRename = false;
      throw new Error("simulated rename crash");
    }
    if (!this.files.has(from)) {
      const error = new Error(`ENOENT: ${from}`);
      error.code = "ENOENT";
      throw error;
    }
    this.files.set(to, this.files.get(from));
    this.files.delete(from);
    this.ops.push(["rename", from, to]);
  }
  async unlink(path) {
    if (this.files.has(path)) {
      this.files.delete(path);
      this.ops.push(["unlink", path]);
    }
  }
  async rm(path) {
    if (this.files.has(path)) {
      this.files.delete(path);
      this.ops.push(["rm", path]);
    }
  }
}

const ROOT = "/data/tmp/workflow-artifacts";

test("路径段清洗：不安全字符替换 + 短哈希防碰撞防穿越", () => {
  const { sanitizeWorkflowArtifactPathSegment } = artifactModule;

  // 安全 id 原样保留。
  assert.equal(sanitizeWorkflowArtifactPathSegment("run-abc_123"), "run-abc_123");

  // 路径穿越与分隔符被替换，且带哈希后缀。
  const traversed = sanitizeWorkflowArtifactPathSegment("../../etc/passwd");
  assert.ok(!traversed.includes("/"), "段内不得残留分隔符");
  assert.ok(!traversed.startsWith(".."), "不得以 .. 开头");
  assert.match(traversed, /-[0-9a-f]{8}$/u, "被清洗的 id 必须追加短哈希");

  // 防碰撞：`a/b` 与 `a-b` 清洗后必须可区分。
  assert.notEqual(
    sanitizeWorkflowArtifactPathSegment("a/b"),
    sanitizeWorkflowArtifactPathSegment("a-b"),
  );

  // 空串回退 artifact stem。
  assert.match(sanitizeWorkflowArtifactPathSegment(""), /^artifact-[0-9a-f]{8}$/u);
});

test("resolveWorkflowArtifactMaterializationPaths：目录结构 + 穿越清洗不出根", () => {
  const { resolveWorkflowArtifactMaterializationPaths } = artifactModule;
  const clean = resolveWorkflowArtifactMaterializationPaths({
    rootDir: ROOT,
    runId: "run-1",
    artifactId: "art-2",
    version: 3,
    fileName: "report.md",
  });
  const directory = clean.directory.replaceAll("\\", "/");
  assert.ok(directory.startsWith(`${ROOT.replaceAll("\\", "/")}/`), "必须在根目录内");
  assert.ok(directory.endsWith("/run-1/art-2/v3"));

  const evil = resolveWorkflowArtifactMaterializationPaths({
    rootDir: ROOT,
    runId: "../../../windows/system32",
    artifactId: "..",
    version: 1,
    fileName: "x.txt",
  });
  const evilDirectory = evil.directory.replaceAll("\\", "/");
  assert.ok(evilDirectory.startsWith(`${ROOT.replaceAll("\\", "/")}/`), "清洗后的段不得逃出物化根");
  // 段级不可穿越：分隔符已全部替换，任何一段都不得是 "." 或 ".."。
  const pathSegments = evilDirectory.split(/[\\/]/u);
  assert.ok(
    pathSegments.every((part) => part !== "." && part !== ".."),
    `不得存在可穿越的路径段: ${evilDirectory}`,
  );
});

test("文件名清洗：保留名加前缀 _、去分隔符/控制字符/首尾空白点、空结果回退 artifactId.bin", () => {
  const { sanitizeWorkflowArtifactFileName } = artifactModule;

  assert.equal(sanitizeWorkflowArtifactFileName("CON.txt", "art-1"), "_CON.txt");
  assert.equal(sanitizeWorkflowArtifactFileName("com3.tar.gz", "art-1"), "_com3.tar.gz");
  assert.equal(sanitizeWorkflowArtifactFileName("Aux", "art-1"), "_Aux");
  assert.equal(sanitizeWorkflowArtifactFileName("lpt9.json", "art-1"), "_lpt9.json");
  // 非保留名不改写。
  assert.equal(sanitizeWorkflowArtifactFileName("condition.txt", "art-1"), "condition.txt");

  assert.equal(sanitizeWorkflowArtifactFileName("../evil.md", "art-1"), "..-evil.md".slice(2));
  assert.equal(sanitizeWorkflowArtifactFileName("a/b/c.png", "art-1"), "a-b-c.png");
  assert.equal(
    sanitizeWorkflowArtifactFileName("name\twith\x07control", "art-1"),
    "namewithcontrol",
  );
  assert.equal(sanitizeWorkflowArtifactFileName("  spaced.txt  ", "art-1"), "spaced.txt");
  assert.equal(sanitizeWorkflowArtifactFileName("trailing.", "art-1"), "trailing");

  const fallback = sanitizeWorkflowArtifactFileName("   ", "art/to-9");
  assert.ok(fallback.endsWith(".bin"), "空结果必须回退 .bin");
  assert.ok(!fallback.includes("/"), "回退名不得携带分隔符");
});

test("上限拒绝：>20MiB 直接拒绝且不写任何文件", async () => {
  const fs = new MemoryFs();
  const tooLarge = new Uint8Array(artifactModule.WORKFLOW_ARTIFACT_MATERIALIZATION_MAX_BYTES + 1);
  const result = await artifactModule.materializeWorkflowArtifactFile(
    {
      runId: "run-1",
      artifactId: "art-1",
      version: 1,
      fileName: "big.bin",
      data: tooLarge,
    },
    { rootDir: ROOT, fs },
  );
  assert.deepEqual(result, { error: "too_large" });
  assert.equal(fs.files.size, 0, "超限不得写任何文件（含 partial）");

  const exact = new Uint8Array(artifactModule.WORKFLOW_ARTIFACT_MATERIALIZATION_MAX_BYTES);
  const exactResult = await artifactModule.materializeWorkflowArtifactFile(
    {
      runId: "run-1",
      artifactId: "art-1",
      version: 1,
      fileName: "exact.bin",
      data: exact,
    },
    { rootDir: ROOT, fs },
  );
  assert.ok("localPath" in exactResult, "恰好 20MiB 必须放行");
});

test("非法载荷拒绝：version、id、data 类型守卫", async () => {
  const fs = new MemoryFs();
  const cases = [
    { runId: "", artifactId: "a", version: 1, fileName: "x", data: new Uint8Array(1) },
    { runId: "r", artifactId: " ", version: 1, fileName: "x", data: new Uint8Array(1) },
    { runId: "r", artifactId: "a", version: 0, fileName: "x", data: new Uint8Array(1) },
    { runId: "r", artifactId: "a", version: -1, fileName: "x", data: new Uint8Array(1) },
    { runId: "r", artifactId: "a", version: 1.5, fileName: "x", data: new Uint8Array(1) },
    { runId: "r", artifactId: "a", version: 1, fileName: "x", data: "not-bytes" },
    { runId: "r", artifactId: "a", version: 1, fileName: "x" },
  ];
  for (const payload of cases) {
    const result = await artifactModule.materializeWorkflowArtifactFile(payload, {
      rootDir: ROOT,
      fs,
    });
    assert.deepEqual(result, { error: "invalid_payload" }, JSON.stringify(payload));
  }
  assert.equal(fs.files.size, 0);
});

test("原子写与幂等：同内容直接返回；不同内容先删再写；partial 以 wx 落盘后 rename", async () => {
  const fs = new MemoryFs();
  const payload = {
    runId: "run-1",
    artifactId: "art-1",
    version: 2,
    fileName: "report.md",
    data: new Uint8Array([1, 2, 3, 4]),
  };
  const first = await artifactModule.materializeWorkflowArtifactFile(payload, {
    rootDir: ROOT,
    fs,
  });
  assert.ok("localPath" in first);
  const filePath = first.localPath;
  assert.deepEqual([...fs.files.get(filePath)], [1, 2, 3, 4]);
  // partial 以 wx 占位写入，最终已 rename 消失。
  assert.equal(fs.ops.filter(([op, , flag]) => op === "writeFile" && flag === "wx").length, 1);

  // 幂等：同字节重复物化返回同一路径且不再写盘。
  const second = await artifactModule.materializeWorkflowArtifactFile(payload, {
    rootDir: ROOT,
    fs,
  });
  assert.deepEqual(second, { localPath: filePath });
  assert.equal(fs.ops.filter(([op]) => op === "writeFile").length, 1, "幂等路径不得再次写文件");

  // 不同字节：先删旧目标再写新内容（同版本覆盖语义）。
  const changed = await artifactModule.materializeWorkflowArtifactFile(
    { ...payload, data: new Uint8Array([9, 9]) },
    { rootDir: ROOT, fs },
  );
  assert.deepEqual(changed, { localPath: filePath });
  assert.deepEqual([...fs.files.get(filePath)], [9, 9]);
  assert.ok(fs.ops.some(([op, path]) => op === "rm" && path === filePath));
});

test("rename 崩溃：返回 write_failed，目标不残留，partial 清理", async () => {
  const fs = new MemoryFs();
  fs.failNextRename = true;
  const result = await artifactModule.materializeWorkflowArtifactFile(
    {
      runId: "run-1",
      artifactId: "art-1",
      version: 1,
      fileName: "report.md",
      data: new Uint8Array([1]),
    },
    { rootDir: ROOT, fs },
  );
  assert.deepEqual(result, { error: "write_failed" });
  const partialFiles = [...fs.files.keys()].filter((path) => path.includes(".partial"));
  assert.equal(partialFiles.length, 0, "崩溃后 partial 必须清理");
  const targetFiles = [...fs.files.keys()].filter((path) => path.endsWith("report.md"));
  assert.equal(targetFiles.length, 0, "崩溃后不得出现半成品目标文件");
});

test("markdown 产物逐字节等于输入字节（spec 验收 1 的 mock fs 形态）", async () => {
  const fs = new MemoryFs();
  const markdown = Buffer.from("# 标题\n\n正文 …", "utf8");
  const result = await artifactModule.materializeWorkflowArtifactFile(
    {
      runId: "run-9",
      artifactId: "art-9",
      version: 1,
      fileName: "notes.md",
      data: new Uint8Array(markdown),
    },
    { rootDir: ROOT, fs },
  );
  assert.ok("localPath" in result);
  assert.ok(fs.files.get(result.localPath).equals(markdown));
});
