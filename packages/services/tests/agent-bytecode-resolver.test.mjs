// J5-L1 验收：字节码 loader 的优雅回退（spec: packages/desktop/specs/agent-bytecode-production.md）
//
// 核心安全属性（权威校验在 agent 进程内的 loader 做，host 不预测）：
//   - 生产（ACODE_BYTECODE_FALLBACK=1）：loadBytecode「加载失败」（指纹失配/摘要不符/V8 拒绝/runtime
//     文件缺失）→ require 同目录 acode.cjs 回退，agent 照常启动（最坏 = 现状 JS）。
//   - bundle 已开始执行（error.__acodeBytecodeExecuted）→ 不回退（避免二次执行顶层副作用），硬失败。
//   - dev 显式试验（无该 env）：加载失败 → 硬失败 exitCode=1，暴露问题不静默回退。
//   - 回退时写一行 stderr（[acode-bytecode] fallback），补「字节码静默失效」可观测性（对抗复核 F4b）。
//
// 用真实 loader 模板（renderBytecodeLoader）+ fake runtime + fake acode.cjs（打标记），plain node 跑——
// 不依赖 Electron、不依赖 15MB 真实 bundle、不触真实 dist。覆盖对抗复核 F1/F4a/F4b。
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

const execFileAsync = promisify(execFile);
const { renderBytecodeLoader } = await import("../../../scripts/build-desktop-agent-bytecode.mjs");

const RUNTIME_FILE = "acode.bytecode-runtime-test.cjs";
const SOURCE_FILE = "acode.cjs";
const MARKER = "FALLBACK_MARKER_OK";

// runtime 行为：load-fail（普通错误，可回退）/ executed（带 __acodeBytecodeExecuted，不可回退）/ missing（不写 runtime 文件）
function makeFixture({ runtimeMode = "load-fail", withSource = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "acode-bytecode-loader-"));
  if (runtimeMode === "load-fail") {
    writeFileSync(
      join(dir, RUNTIME_FILE),
      `module.exports = { loadBytecode: async () => { throw new Error("SIMULATED_BYTECODE_FAILURE"); } };\n`,
      "utf8",
    );
  } else if (runtimeMode === "executed") {
    writeFileSync(
      join(dir, RUNTIME_FILE),
      `module.exports = { loadBytecode: async () => { const e = new Error("BUNDLE_EXEC_FAILED"); e.__acodeBytecodeExecuted = true; throw e; } };\n`,
      "utf8",
    );
  }
  // runtimeMode === "missing": 不写 runtime 文件 → loader 同步 require 失败（F1）
  if (withSource) {
    writeFileSync(join(dir, SOURCE_FILE), `process.stdout.write("${MARKER}\\n");\n`, "utf8");
  }
  const loader = renderBytecodeLoader({ sourceFile: SOURCE_FILE }, RUNTIME_FILE);
  const loaderPath = join(dir, "acode.bytecode.cjs");
  writeFileSync(loaderPath, loader, { mode: 0o755 });
  return { dir, loaderPath };
}

async function runLoader(loaderPath, { fallback }) {
  const env = { ...process.env };
  if (fallback) env.ACODE_BYTECODE_FALLBACK = "1";
  else delete env.ACODE_BYTECODE_FALLBACK;
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [loaderPath], { env });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

test("(1) 生产 fallback=1：加载失败 → 优雅回退 acode.cjs（标记输出 + exit 0 + stderr 诊断）", async () => {
  const { dir, loaderPath } = makeFixture({ runtimeMode: "load-fail" });
  try {
    const result = await runLoader(loaderPath, { fallback: true });
    assert.equal(result.code, 0, `应回退成功 exit 0，实际 ${result.code}；stderr=${result.stderr}`);
    assert.ok(result.stdout.includes(MARKER), `回退必须执行 acode.cjs，stdout=${result.stdout}`);
    // F4b：回退可观测性
    assert.ok(
      result.stderr.includes("[acode-bytecode] fallback"),
      `回退须写 stderr 诊断，实际 stderr=${result.stderr}`,
    );
    assert.ok(
      result.stderr.includes("SIMULATED_BYTECODE_FAILURE"),
      `stderr 须含原始失败原因，实际=${result.stderr}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(2) dev 无 fallback env：加载失败 → 硬失败 exitCode=1 + 暴露错误（不静默回退）", async () => {
  const { dir, loaderPath } = makeFixture({ runtimeMode: "load-fail" });
  try {
    const result = await runLoader(loaderPath, { fallback: false });
    assert.equal(result.code, 1, `dev 应硬失败 exit 1，实际 ${result.code}`);
    assert.ok(
      result.stderr.includes("SIMULATED_BYTECODE_FAILURE"),
      `硬失败须暴露原始错误，stderr=${result.stderr}`,
    );
    assert.ok(!result.stdout.includes(MARKER), "dev 硬失败不得静默回退执行 acode.cjs");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(3) F1 P0：runtime 文件缺失（同步 require 失败）+ fallback=1 → 仍优雅回退 acode.cjs", async () => {
  const { dir, loaderPath } = makeFixture({ runtimeMode: "missing" });
  try {
    const result = await runLoader(loaderPath, { fallback: true });
    assert.equal(
      result.code,
      0,
      `runtime 缺失也必须回退成功 exit 0（F1：同步 require 纳入回退保护），实际 ${result.code}；stderr=${result.stderr}`,
    );
    assert.ok(result.stdout.includes(MARKER), `回退必须执行 acode.cjs，stdout=${result.stdout}`);
    assert.ok(
      result.stderr.includes("[acode-bytecode] fallback"),
      `回退须写 stderr 诊断，stderr=${result.stderr}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(3b) F1：runtime 缺失 + dev 无 env → 硬失败 exit 1（不静默）", async () => {
  const { dir, loaderPath } = makeFixture({ runtimeMode: "missing" });
  try {
    const result = await runLoader(loaderPath, { fallback: false });
    assert.equal(result.code, 1);
    assert.ok(!result.stdout.includes(MARKER));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(4) F4a：bundle 已开始执行（__acodeBytecodeExecuted）+ fallback=1 → 不回退（防二次执行），硬失败", async () => {
  const { dir, loaderPath } = makeFixture({ runtimeMode: "executed" });
  try {
    const result = await runLoader(loaderPath, { fallback: true });
    assert.equal(
      result.code,
      1,
      `已执行标记必须阻止回退（避免二次执行副作用）→ 硬失败 exit 1，实际 ${result.code}`,
    );
    assert.ok(
      !result.stdout.includes(MARKER),
      "F4a：bundle 已执行时不得回退 require(acode.cjs)（二次执行）",
    );
    assert.ok(
      result.stderr.includes("BUNDLE_EXEC_FAILED"),
      `硬失败须暴露执行错误，stderr=${result.stderr}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(5) 生产回退但 acode.cjs 也缺失 → 二次失败 exitCode=1（不卡死、不静默成功）", async () => {
  const { dir, loaderPath } = makeFixture({ runtimeMode: "load-fail", withSource: false });
  try {
    const result = await runLoader(loaderPath, { fallback: true });
    assert.equal(result.code, 1, `回退目标缺失应 exit 1，实际 ${result.code}`);
    assert.ok(result.stderr.length > 0, "二次失败须写出错误");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(6) loader 模板结构钉住（防回归删掉回退/同步 require 保护/执行标记检查/env 卫生）", () => {
  const loader = renderBytecodeLoader({ sourceFile: SOURCE_FILE }, RUNTIME_FILE);
  assert.ok(
    loader.includes('const fallbackEnabled = process.env.ACODE_BYTECODE_FALLBACK === "1"'),
    "必须捕获 env 门控到局部",
  );
  assert.ok(
    loader.includes("delete process.env.ACODE_BYTECODE_FALLBACK"),
    "N7：必须删除 env 防下渗子进程",
  );
  assert.ok(loader.includes("if (!fallbackEnabled"), "回退必须由 fallbackEnabled 门控");
  assert.ok(loader.includes("__acodeBytecodeExecuted"), "必须检查执行标记（F4a 防二次执行）");
  assert.ok(loader.includes("metadata.sourceFile"), "回退必须 require sourceFile（acode.cjs）");
  assert.ok(loader.includes("[acode-bytecode] fallback"), "回退必须写 stderr 诊断（F4b）");
  assert.ok(loader.includes("process.exitCode = 1"), "硬失败路径必须置 exitCode=1");
  // F1：同步 require 必须在 try 内、catch 调用 tryFallback
  assert.ok(
    /try \{\s*runtime = require\(/.test(loader) && /catch \(error\) \{\s*tryFallback\(error\)/.test(loader),
    "F1：同步 require(runtime) 必须纳入 tryFallback 保护",
  );
});
