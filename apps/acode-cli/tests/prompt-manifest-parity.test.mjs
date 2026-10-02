import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * P3 验收测试：提示词版本化清单（prompt-manifest）+ parity 校验。
 *
 * 覆盖 specs/system-prompt-section-registry.md R6 与验收场景 3/8/9
 * （场景 9 的 CI 语义按本 repo 落地形态测：--check 硬校验退出码 1 = 阻断，
 * parity 脚本对差异恒退出码 0 = 仅报告不阻断）：
 * - 场景 3：每个 persistable 段在 manifest 有且仅有一条；persistable: false 一条没有；
 *   共享段只有一条且 owner 指向共享 descriptor 定义文件（registry-shared.ts）；
 * - 场景 8：生成确定性（同一检出重复生成逐字节相同）；改一个段文本 → 差异报告精确
 *   指出该段 hash 变化；基线文件只含 id 与名称字段（键集断言 + 长编码载荷启发式）；
 * - 场景 9：manifest 与代码不一致（漏一段）→ --check 硬校验失败退出码 1；
 *   parity 差异 → 报告输出但退出码 0；
 * - 合规红线：manifest 与 parity 全程本地（文件/stdout/debug 日志），脚本源码无网络引用。
 */

const {
  buildPromptManifest,
  computeManifestSectionsHash,
  computePromptManifestSections,
  verifyPromptManifest,
  PROMPT_MANIFEST_VERSION,
} = await import("../packages/core/src/context/manifest.ts");
const { MAIN_SECTION_REGISTRY } = await import("../packages/core/src/context/registry-main.ts");
const {
  validateBaselineShape,
  buildParityReport,
  renderParityReport,
} = await import("../scripts/prompt-parity-lib.mjs");

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(TESTS_DIR, "..");
const MANIFEST_PATH = join(
  APP_ROOT,
  "packages",
  "core",
  "src",
  "context",
  "generated",
  "prompt-manifest.json",
);
const BASELINE_PATH = join(APP_ROOT, "scripts", "parity-baseline.json");
const GENERATE_SCRIPT = join(APP_ROOT, "scripts", "generate-prompt-manifest.mjs");
const PARITY_SCRIPT = join(APP_ROOT, "scripts", "check-prompt-parity.mjs");

const PINNED_TIMESTAMP = "2026-09-29T00:00:00.000Z";

const PERSISTABLE_IDS = [
  "prefix.cli",
  "identity.default",
  "surface.desktop",
  "behavior.dynamic",
  "context.management",
  "subagent.notes",
];

const NON_PERSISTABLE_IDS = [
  "identity.custom",
  "identity.workflow_actor",
  "guidance.session",
  "guidance.delegating_work",
  "memory.persistent",
  "env.info",
  "style.output",
  "env.git_snapshot",
  "skills.listing",
  "request.user_context",
  "date.current",
  "subagent.agent_prompt",
  "subagent.environment",
];

function runScript(script, args) {
  return new Promise((resolvePromise) => {
    execFile(
      process.execPath,
      ["--import", "tsx", script, ...args],
      { cwd: APP_ROOT, encoding: "utf8", windowsHide: true },
      (error, stdout, stderr) => {
        resolvePromise({
          code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
          stdout: stdout ?? "",
          stderr: stderr ?? "",
        });
      },
    );
  });
}

async function withTempDir(run) {
  const dir = await mkdtemp(join(tmpdir(), "acode-p3-test-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ============================================================
// 生成确定性（场景 8 前半）
// ============================================================

test("(确定性) 同一检出重复生成 manifest：钉住时间戳后逐字节相同", () => {
  const a = buildPromptManifest({ generatedAt: PINNED_TIMESTAMP });
  const b = buildPromptManifest({ generatedAt: PINNED_TIMESTAMP });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.equal(a.version, PROMPT_MANIFEST_VERSION);
  assert.match(a.sectionsHash, /^[0-9a-f]{64}$/);
  for (const section of a.sections) {
    assert.match(section.hash, /^[0-9a-f]{64}$/);
  }
});

test("(确定性) 不钉时间戳：sections 与 sectionsHash 不受 generatedAt 影响", () => {
  const a = buildPromptManifest({ generatedAt: "2026-01-01T00:00:00.000Z" });
  const b = buildPromptManifest({ generatedAt: "2027-06-01T12:34:56.789Z" });
  assert.deepEqual(a.sections, b.sections);
  assert.equal(a.sectionsHash, b.sectionsHash);
  assert.equal(a.sectionsHash, computeManifestSectionsHash(a.sections));
});

test("(确定性/e2e) 生成脚本连跑两次输出文件逐字节相同", async () => {
  await withTempDir(async (dir) => {
    const outA = join(dir, "manifest-a.json");
    const outB = join(dir, "manifest-b.json");
    const runA = await runScript(GENERATE_SCRIPT, ["--output", outA, "--generated-at", PINNED_TIMESTAMP]);
    const runB = await runScript(GENERATE_SCRIPT, ["--output", outB, "--generated-at", PINNED_TIMESTAMP]);
    assert.equal(runA.code, 0, runA.stderr);
    assert.equal(runB.code, 0, runB.stderr);
    assert.equal(await readFile(outA, "utf8"), await readFile(outB, "utf8"));
  });
});

// ============================================================
// 场景 3：注册表段 id 全量出现在 manifest
// ============================================================

test("(场景3) persistable 段有且仅有一条；persistable:false 一条也没有；共享段 owner 指向共享定义", () => {
  const sections = computePromptManifestSections();
  assert.deepEqual(
    sections.map((section) => section.id),
    PERSISTABLE_IDS,
    "目录 = MAIN→SUBAGENT 声明序、按 id 去重（共享段只有一条）",
  );
  for (const id of NON_PERSISTABLE_IDS) {
    assert.equal(
      sections.some((section) => section.id === id),
      false,
      `persistable:false 的 ${id} 不得进 manifest`,
    );
  }
  const shared = sections.find((section) => section.id === "prefix.cli");
  assert.equal(
    shared.owner,
    "apps/acode-cli/packages/core/src/context/registry-shared.ts",
    "共享段 owner 指向共享 descriptor 定义文件（R6）",
  );
  // 每条都有 §10.1 的字段：id / group / source / owner / hash。
  for (const section of sections) {
    assert.equal(typeof section.group, "string");
    assert.equal(typeof section.source, "string");
    assert.equal(typeof section.owner, "string");
    assert.match(section.hash, /^[0-9a-f]{64}$/);
  }
});

test("(场景3) repo 内已提交的 manifest 与当前代码一致（硬校验绿）", async () => {
  const raw = await readFile(MANIFEST_PATH, "utf8");
  const manifest = JSON.parse(raw);
  const verification = verifyPromptManifest(manifest);
  assert.deepEqual(verification.problems, []);
  assert.equal(verification.ok, true);
});

// ============================================================
// 场景 8：漂移检测（改一个段 → manifest 出差异）
// ============================================================

function tamper(manifest, mutate) {
  const clone = JSON.parse(JSON.stringify(manifest));
  mutate(clone);
  return clone;
}

test("(场景8) 段文本漂移：注入改文本的注册表 → verify 精确点名该段 hash 变化", () => {
  const target = MAIN_SECTION_REGISTRY.find((descriptor) => descriptor.id === "behavior.dynamic");
  assert.ok(target);
  const patchedRegistry = MAIN_SECTION_REGISTRY.map((descriptor) =>
    descriptor === target
      ? {
          ...descriptor,
          build: (ctx) => {
            const section = descriptor.build(ctx);
            return { ...section, content: `${section.content}\np3-drift-marker` };
          },
        }
      : descriptor,
  );

  const drifted = buildPromptManifest({
    mainRegistry: patchedRegistry,
    generatedAt: PINNED_TIMESTAMP,
  });
  const real = buildPromptManifest({ generatedAt: PINNED_TIMESTAMP });
  const driftedEntry = drifted.sections.find((s) => s.id === "behavior.dynamic");
  const realEntry = real.sections.find((s) => s.id === "behavior.dynamic");
  assert.notEqual(driftedEntry.hash, realEntry.hash, "改一个段文本 → 该段 hash 变化");
  assert.equal(drifted.sectionsHash !== real.sectionsHash, true, "目录摘要随之变化");

  // 漂移后的 manifest 对照当前代码 → 硬校验失败并点名 behavior.dynamic。
  const verification = verifyPromptManifest(drifted);
  assert.equal(verification.ok, false);
  assert.ok(
    verification.problems.some((p) => p.includes("behavior.dynamic") && p.includes("hash drifted")),
    `problems 应点名 hash 漂移段: ${JSON.stringify(verification.problems)}`,
  );
});

test("(场景8/9) verify 硬校验：漏段/多段/owner 漂移/sectionsHash 篡改都判失败", () => {
  const real = buildPromptManifest({ generatedAt: PINNED_TIMESTAMP });

  const dropped = tamper(real, (m) => {
    m.sections = m.sections.filter((s) => s.id !== "prefix.cli");
  });
  let v = verifyPromptManifest(dropped);
  assert.equal(v.ok, false);
  assert.ok(v.problems.some((p) => p.includes('section "prefix.cli" is missing')));

  const extra = tamper(real, (m) => {
    m.sections.push({
      id: "env.info",
      group: "system-dynamic",
      source: "env_info",
      owner: "x",
      hash: "0".repeat(64),
    });
  });
  v = verifyPromptManifest(extra);
  assert.equal(v.ok, false);
  assert.ok(v.problems.some((p) => p.includes("not a persistable registry section")));

  const ownerDrift = tamper(real, (m) => {
    m.sections.find((s) => s.id === "prefix.cli").owner = "somewhere/else.ts";
  });
  v = verifyPromptManifest(ownerDrift);
  assert.equal(v.ok, false);
  assert.ok(v.problems.some((p) => p.includes("owner drifted")));

  const hashDrift = tamper(real, (m) => {
    m.sectionsHash = "f".repeat(64);
  });
  v = verifyPromptManifest(hashDrift);
  assert.equal(v.ok, false);
  assert.ok(v.problems.some((p) => p.includes("sectionsHash drifted")));

  // generatedAt 是构建时间戳，不参与一致性判定。
  const regenerated = tamper(real, (m) => {
    m.generatedAt = "1999-01-01T00:00:00.000Z";
  });
  assert.equal(verifyPromptManifest(regenerated).ok, true);
});

// ============================================================
// 基线纯净性（合规红线）+ parity 报告
// ============================================================

test("(红线) 基线文件只含机制对照项名称与期望段 id，无任何第三方文本/长编码载荷", async () => {
  const baseline = JSON.parse(await readFile(BASELINE_PATH, "utf8"));
  assert.deepEqual(validateBaselineShape(baseline), []);
  assert.deepEqual(Object.keys(baseline).sort(), ["entries", "version"]);
  for (const entry of baseline.entries) {
    assert.deepEqual(Object.keys(entry).sort(), ["id", "mechanism"], "条目只允许 id + mechanism 两个字段");
    assert.match(entry.id, /^[a-z_]+\.[a-z_.]+$/);
    // 启发式：名称字段里不得出现 hash/base64 式长编码载荷或大段粘贴文本。
    assert.equal(/[A-Za-z0-9+/=]{40,}/.test(entry.mechanism), false);
    assert.ok(entry.mechanism.length <= 60, `机制名称应是短描述: ${entry.mechanism}`);
  }
  // 基线期望的每个 id 都真实存在于当前目录（初始基线零缺失）。
  const currentIds = new Set(computePromptManifestSections().map((s) => s.id));
  for (const entry of baseline.entries) {
    assert.equal(currentIds.has(entry.id), true, `基线 id ${entry.id} 应在当前目录`);
  }
});

test("(红线) validateBaselineShape 拒绝多余字段（防止把文本塞进基线）", () => {
  const problems = validateBaselineShape({
    version: 1,
    entries: [{ id: "prefix.cli", mechanism: "产品身份前缀块", upstreamText: "…粘贴的原文…" }],
  });
  assert.ok(problems.some((p) => p.includes("upstreamText")));
  assert.ok(validateBaselineShape({ version: 2, entries: [] }).some((p) => p.includes("version")));
});

test("(场景8) parity 报告：缺失段/新增段/hash 变化段三类差异精确产出", () => {
  const current = computePromptManifestSections();
  const clean = buildParityReport({
    baseline: { version: 1, entries: current.map((s) => ({ id: s.id, mechanism: `机制:${s.id}` })) },
    manifestSections: current,
    currentSections: current,
  });
  assert.deepEqual(clean, { missingSections: [], addedSections: [], hashChangedSections: [] });

  // hash 变化：repo manifest 侧的 behavior.dynamic 与当前代码不一致 → 精确点名。
  const staleManifest = current.map((s) =>
    s.id === "behavior.dynamic" ? { ...s, hash: "a".repeat(64) } : s,
  );
  const drifted = buildParityReport({
    baseline: { version: 1, entries: current.map((s) => ({ id: s.id, mechanism: `机制:${s.id}` })) },
    manifestSections: staleManifest,
    currentSections: current,
  });
  assert.equal(drifted.hashChangedSections.length, 1);
  assert.equal(drifted.hashChangedSections[0].id, "behavior.dynamic");
  assert.equal(drifted.hashChangedSections[0].manifestHash, "a".repeat(64));
  assert.equal(drifted.hashChangedSections[0].currentHash, current.find((s) => s.id === "behavior.dynamic").hash);
  assert.ok(renderParityReport(drifted).includes("behavior.dynamic"));

  // 缺失/新增：基线期望的 id 不在目录 → missing；目录 id 未被基线登记 → added。
  const report = buildParityReport({
    baseline: {
      version: 1,
      entries: [
        { id: "prefix.cli", mechanism: "产品身份前缀块" },
        { id: "guidance.retired", mechanism: "已退役机制对照项" },
      ],
    },
    manifestSections: current,
    currentSections: current,
  });
  assert.deepEqual(report.missingSections, [{ id: "guidance.retired", mechanism: "已退役机制对照项" }]);
  assert.deepEqual(report.addedSections.map((a) => a.id), PERSISTABLE_IDS.filter((id) => id !== "prefix.cli"));
});

// ============================================================
// 场景 9：脚本级 CI 语义（硬校验阻断 / parity 不阻断）
// ============================================================

test("(场景9/e2e) generate --check：repo 清单一致 → 退出码 0", async () => {
  const result = await runScript(GENERATE_SCRIPT, ["--check"]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /prompt-manifest --check: OK/);
});

test("(场景9/e2e) generate --check：清单漏一段 → 硬校验失败退出码 1 并点名", async () => {
  await withTempDir(async (dir) => {
    const out = join(dir, "manifest.json");
    const generated = await runScript(GENERATE_SCRIPT, ["--output", out, "--generated-at", PINNED_TIMESTAMP]);
    assert.equal(generated.code, 0, generated.stderr);
    const manifest = JSON.parse(await readFile(out, "utf8"));
    manifest.sections = manifest.sections.filter((s) => s.id !== "context.management");
    await writeFile(out, JSON.stringify(manifest, null, 2), "utf8");

    const checked = await runScript(GENERATE_SCRIPT, ["--check", "--output", out]);
    assert.equal(checked.code, 1);
    assert.match(checked.stderr, /out of sync with the section registry/);
    assert.match(checked.stderr, /context\.management/);
  });
});

test("(场景8/9/e2e) parity：hash 漂移仅报告不阻断（退出码 0 且点名该段）", async () => {
  await withTempDir(async (dir) => {
    const out = join(dir, "manifest.json");
    const generated = await runScript(GENERATE_SCRIPT, ["--output", out, "--generated-at", PINNED_TIMESTAMP]);
    assert.equal(generated.code, 0, generated.stderr);
    const manifest = JSON.parse(await readFile(out, "utf8"));
    manifest.sections.find((s) => s.id === "identity.default").hash = "b".repeat(64);
    await writeFile(out, JSON.stringify(manifest, null, 2), "utf8");

    const parity = await runScript(PARITY_SCRIPT, ["--manifest", out]);
    assert.equal(parity.code, 0, `parity 差异不得阻断: ${parity.stderr}`);
    assert.match(parity.stdout, /hash 变化段 \(repo manifest vs 当前代码\): 1/);
    assert.match(parity.stdout, /identity\.default/);
    assert.match(parity.stdout, /不阻断/);
  });
});

test("(场景9/e2e) parity：默认路径全绿报告 + 基线形状违规是操作性错误（退出码 1）", async () => {
  const clean = await runScript(PARITY_SCRIPT, []);
  assert.equal(clean.code, 0, clean.stderr);
  assert.match(clean.stdout, /no differences/);

  await withTempDir(async (dir) => {
    const badBaseline = join(dir, "baseline.json");
    await writeFile(
      badBaseline,
      JSON.stringify({ version: 1, entries: [{ id: "prefix.cli", mechanism: "x", note: "多余字段" }] }),
      "utf8",
    );
    const result = await runScript(PARITY_SCRIPT, ["--baseline", badBaseline]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /baseline shape violations/);
  });
});

test("(红线) 脚本与 manifest 模块源码无网络/遥测引用", async () => {
  const files = [
    GENERATE_SCRIPT,
    PARITY_SCRIPT,
    join(APP_ROOT, "scripts", "prompt-parity-lib.mjs"),
    join(APP_ROOT, "packages", "core", "src", "context", "manifest.ts"),
  ];
  // 断言的是代码级网络/遥测引用；注释里引用 spec 名（no-telemetry）不算。
  const forbidden = /fetch\(|XMLHttpRequest|otlp|new\s+\w*Exporter|from\s+["'][^"']*telemetry|https?:\/\//i;
  for (const file of files) {
    const content = await readFile(file, "utf8");
    assert.equal(forbidden.test(content), false, `${file} 不得含网络/遥测引用`);
  }
});
