// J5-L1 验收：agent bundle staging 的字节码校验（spec: packages/desktop/specs/agent-bytecode-production.md）
// staging 经 meta 驱动 + 安全校验后才携带字节码产物（对抗复核 F1 依赖闭环 / F2 新鲜度+coverage）：
//   - meta.sourceSha256 必须 == 本次 acode.cjs 的 sha256（utf8→Buffer，与编译器同源），否则陈旧字节码跳过；
//   - loader 引用的 .jsc / runtime 必须都在（依赖闭环），否则跳过；
//   - E2E coverage 强制跳过字节码（插桩需 JS 路径）；
//   - 任一不过 → 只 stage acode.cjs（JS only 安全态），保留 rmSync 干净重建语义。
// 用临时 repo 结构，不触真实工作树。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const { stageAgentBundle, resolveAgentBundlePaths } = await import(
  "../scripts/stage-agent-bundle.mjs"
);

const PLATFORM_KEY = "win32-x64";
const BUNDLE_BODY = "// agent bundle body\n";
const JSC_NAME = "acode.bytecode-abc123.jsc";
const RUNTIME_NAME = "acode.bytecode-runtime-def456.cjs";

function sha256Utf8(text) {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

function makeTempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "acode-stage-bytecode-"));
  const distDir = join(repoRoot, "apps/acode-cli/packages/cli/dist");
  mkdirSync(distDir, { recursive: true });
  writeFileSync(join(distDir, "acode.cjs"), BUNDLE_BODY, "utf8");
  return { repoRoot, distDir };
}

// 写一套「新鲜」字节码产物：meta.sourceSha256 与 acode.cjs 一致，.jsc/runtime 齐备。
function writeFreshBytecode(distDir, { sourceSha256 = sha256Utf8(BUNDLE_BODY), withJsc = true } = {}) {
  writeFileSync(join(distDir, "acode.bytecode.cjs"), "#!/usr/bin/env node\n// loader\n", "utf8");
  if (withJsc) writeFileSync(join(distDir, JSC_NAME), "BINARY_JSC", "utf8");
  writeFileSync(join(distDir, RUNTIME_NAME), "// runtime\n", "utf8");
  writeFileSync(
    join(distDir, "acode.bytecode-meta.json"),
    JSON.stringify({
      bytecodeFile: JSC_NAME,
      runtimeFile: RUNTIME_NAME,
      sourceFile: "acode.cjs",
      sourceSha256,
    }),
    "utf8",
  );
}

function readStagedMeta(glmDir) {
  return JSON.parse(readFileSync(join(glmDir, ".node-bundle-meta.json"), "utf8"));
}

test("(1) 新鲜字节码（sourceSha256 匹配 + 依赖齐备）→ 全部 stage，meta.bytecodeEntry 记录 loader", () => {
  const { repoRoot, distDir } = makeTempRepo();
  writeFreshBytecode(distDir);
  try {
    const result = stageAgentBundle({ repoRoot, platformKey: PLATFORM_KEY, log: () => {} });
    const { glmDir } = resolveAgentBundlePaths({ repoRoot, platformKey: PLATFORM_KEY });
    assert.ok(existsSync(join(glmDir, "acode.cjs")));
    assert.ok(existsSync(join(glmDir, "acode.bytecode.cjs")), "loader 必须 staged");
    assert.ok(existsSync(join(glmDir, JSC_NAME)), ".jsc 必须 staged");
    assert.ok(existsSync(join(glmDir, RUNTIME_NAME)), "runtime 必须 staged");
    assert.deepEqual(result.bytecodeArtifacts.sort(), [JSC_NAME, RUNTIME_NAME, "acode.bytecode.cjs"].sort());
    assert.equal(readStagedMeta(glmDir).bytecodeEntry, "acode.bytecode.cjs");
    // meta sidecar 是构建期文件，不随包 stage
    assert.ok(!existsSync(join(glmDir, "acode.bytecode-meta.json")), "meta sidecar 不应进包");
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("(2) 无字节码产物（交叉平台/编译失败）→ 只 stage acode.cjs，bytecodeEntry=null，不报错", () => {
  const { repoRoot } = makeTempRepo();
  try {
    const result = stageAgentBundle({ repoRoot, platformKey: PLATFORM_KEY, log: () => {} });
    const { glmDir } = resolveAgentBundlePaths({ repoRoot, platformKey: PLATFORM_KEY });
    assert.ok(existsSync(join(glmDir, "acode.cjs")));
    assert.ok(!existsSync(join(glmDir, "acode.bytecode.cjs")));
    assert.deepEqual(result.bytecodeArtifacts, []);
    assert.equal(readStagedMeta(glmDir).bytecodeEntry, null);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("(3) F2 新鲜度：sourceSha256 失配（陈旧字节码 vs 新 acode.cjs）→ 跳过字节码，JS only", () => {
  const { repoRoot, distDir } = makeTempRepo();
  // meta 记录的是「旧 acode.cjs」的 sha，与当前 BUNDLE_BODY 不符
  writeFreshBytecode(distDir, { sourceSha256: sha256Utf8("// OLD bundle body\n") });
  try {
    const result = stageAgentBundle({ repoRoot, platformKey: PLATFORM_KEY, log: () => {} });
    const { glmDir } = resolveAgentBundlePaths({ repoRoot, platformKey: PLATFORM_KEY });
    assert.deepEqual(result.bytecodeArtifacts, [], "陈旧字节码必须被拒绝");
    assert.ok(!existsSync(join(glmDir, "acode.bytecode.cjs")), "陈旧 loader 不得进包");
    assert.ok(!existsSync(join(glmDir, JSC_NAME)), "陈旧 .jsc 不得进包（避免静默取代新 JS）");
    assert.equal(readStagedMeta(glmDir).bytecodeEntry, null);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("(4) F2 coverage：ACODE_E2E_COVERAGE 下即使字节码新鲜也强制跳过（插桩需 JS）", () => {
  const { repoRoot, distDir } = makeTempRepo();
  writeFreshBytecode(distDir);
  try {
    const result = stageAgentBundle({
      repoRoot,
      platformKey: PLATFORM_KEY,
      coverage: true,
      log: () => {},
    });
    const { glmDir } = resolveAgentBundlePaths({ repoRoot, platformKey: PLATFORM_KEY });
    assert.deepEqual(result.bytecodeArtifacts, [], "coverage 必须走 JS 路径");
    assert.ok(!existsSync(join(glmDir, "acode.bytecode.cjs")));
    assert.equal(readStagedMeta(glmDir).bytecodeEntry, null);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("(5) F1 依赖闭环：meta 引用的 .jsc 缺失 → 跳过字节码（避免生产 loader require 失败）", () => {
  const { repoRoot, distDir } = makeTempRepo();
  writeFreshBytecode(distDir, { withJsc: false }); // meta 指向 abc123.jsc 但文件不存在
  try {
    const result = stageAgentBundle({ repoRoot, platformKey: PLATFORM_KEY, log: () => {} });
    const { glmDir } = resolveAgentBundlePaths({ repoRoot, platformKey: PLATFORM_KEY });
    assert.deepEqual(result.bytecodeArtifacts, [], "依赖不闭环必须放弃字节码");
    assert.ok(!existsSync(join(glmDir, "acode.bytecode.cjs")), "loader 不得在依赖缺失时进包");
    assert.equal(readStagedMeta(glmDir).bytecodeEntry, null);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("(6) rmSync 干净重建：上次残留的陈旧 .jsc / 原生二进制被清掉", () => {
  const { repoRoot, distDir } = makeTempRepo();
  const { glmDir } = resolveAgentBundlePaths({ repoRoot, platformKey: PLATFORM_KEY });
  mkdirSync(glmDir, { recursive: true });
  writeFileSync(join(glmDir, "acode.bytecode-STALE999.jsc"), "STALE", "utf8");
  writeFileSync(join(glmDir, "acode-agent.exe"), "STALE_NATIVE", "utf8");
  writeFreshBytecode(distDir);
  try {
    stageAgentBundle({ repoRoot, platformKey: PLATFORM_KEY, log: () => {} });
    assert.ok(!existsSync(join(glmDir, "acode.bytecode-STALE999.jsc")), "陈旧 .jsc 必须被清掉");
    assert.ok(!existsSync(join(glmDir, "acode-agent.exe")), "残留原生二进制必须被清掉");
    assert.ok(existsSync(join(glmDir, JSC_NAME)), "新 .jsc 必须 staged");
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("(7) 只 stage meta 引用的字节码文件，不误拷 dist 里其它产物（如 .map）", () => {
  const { repoRoot, distDir } = makeTempRepo();
  writeFreshBytecode(distDir);
  writeFileSync(join(distDir, "acode.cjs.map"), "SOURCEMAP", "utf8");
  writeFileSync(join(distDir, "acode.bytecode-ORPHAN.jsc"), "ORPHAN", "utf8"); // 孤儿 .jsc（meta 未引用）
  try {
    stageAgentBundle({ repoRoot, platformKey: PLATFORM_KEY, log: () => {} });
    const { glmDir } = resolveAgentBundlePaths({ repoRoot, platformKey: PLATFORM_KEY });
    assert.ok(!existsSync(join(glmDir, "acode.cjs.map")), ".map 不应被拷入");
    assert.ok(!existsSync(join(glmDir, "acode.bytecode-ORPHAN.jsc")), "meta 未引用的孤儿 .jsc 不应被拷入");
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
