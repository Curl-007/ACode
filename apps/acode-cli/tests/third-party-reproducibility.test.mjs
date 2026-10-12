// U13：发布台账门禁的可复现性单一入口与 paths 覆盖率验收。
//
// 放在 apps/acode-cli/tests 与 typecheck-gate.test.mjs、architecture-*.test.mjs 同因：
// 根 scripts/ 没有自己的 test glob（根 package.json 的 test 是 pnpm -r 逐包执行），
// 而 CLI 全套是唯一覆盖仓库根脚本的入口。
//
// 对应 docs/upgrades/quality-and-release-2026-10.md 的 U13 验收场景：
//   L01 干净树 inputs-only 退出 0、零 mismatch、秒级；
//   L02 改动一个当前 workflow paths 未覆盖的被追踪源文件 → 必须被检出并指名；
//   L04 paths-filter 对台账 inputs 覆盖率必须 100%（手写清单当前实测 15.9%，即缺口二）；
//   L06 依赖树漂移时 inputs-only 必须仍为绿——如实证明本地探测覆盖不到依赖树，
//       不得被当成可替代 CI 全量重生成。
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import {
  INPUTS_ONLY_ELAPSED_BUDGET_MS,
  LEDGER_FILES,
  derivePathsFilter,
  measurePathsFilterCoverage,
  verifyInputsFreshness,
} from "../../../scripts/third-party-reproducibility.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const execFileAsync = promisify(execFile);

/** 参数数组形式起 git（跨平台纪律，不用 shell 字符串拼接）。 */
async function runGit(args) {
  return execFileAsync("git", args, { cwd: repoRoot });
}

/**
 * licenses-notices.yml 第 29-44 行手写的 pull_request.paths 清单（立项时逐行抄录）。
 * 这份清单与台账 inputs 是两条必须一致、却各自手工维护的事实——缺口二即两者漂移。
 */
const HANDWRITTEN_PATHS = [
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "**/package.json",
  "patches/**",
  "THIRD-PARTY-NOTICES.md",
  "third-party/**",
  ".agents/skills/**",
  "scripts/**",
  ".github/workflows/licenses-notices.yml",
];

function matchesAny(rel, patterns) {
  return patterns.some((pattern) => {
    if (pattern === rel) return true;
    if (pattern.endsWith("/**")) {
      const dir = pattern.slice(0, -3);
      return rel.startsWith(`${dir}/`);
    }
    if (pattern.startsWith("**/")) {
      const suffix = pattern.slice(3);
      return rel === suffix || rel.endsWith(`/${suffix}`);
    }
    return false;
  });
}

async function fixtureRoot() {
  const root = await mkdtemp(join(tmpdir(), "acode-u13-repro-"));
  await mkdir(join(root, "packages", "ui", "src", "components", "ai-elements"), {
    recursive: true,
  });
  await mkdir(join(root, "third-party"), { recursive: true });
  await writeFile(join(root, "package.json"), '{\n  "version": "0.0.0"\n}\n', "utf8");
  await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
  await writeFile(
    join(root, "packages", "ui", "src", "components", "ai-elements", "message.tsx"),
    "export const Message = () => null;\n",
    "utf8",
  );
  return root;
}

test("L01: 真实仓库干净树上 inputs-only 全绿、零 mismatch/missing 且在预算内", async () => {
  const result = await verifyInputsFreshness(repoRoot, { inputsOnly: true });
  assert.equal(result.ok, true, `inputs-only 在干净树上必须全绿，实测：${JSON.stringify(result.drift.slice(0, 5))}`);
  assert.equal(result.drift.length, 0);
  assert.ok(
    result.checked > 2000,
    `必须逐项覆盖台账 inputs（实测 ${result.checked} 项，台账规模应为数千级；数字过小说明检查被跳过）`,
  );
  assert.ok(
    result.elapsedMs < INPUTS_ONLY_ELAPSED_BUDGET_MS,
    `inputs-only 是零 install 的纯哈希比对，必须在 ${INPUTS_ONLY_ELAPSED_BUDGET_MS}ms 预算内（实测 ${result.elapsedMs}ms），否则不能挂进开发期反馈`,
  );
  assert.equal(
    result.mode,
    "inputs-only",
    "结果必须自报模式，避免把 inputs-only 的绿当成全量复现性的绿（L06 的边界）",
  );
});

test("L02: 改动一个手写 paths 未覆盖的被追踪文件仍被检出并指名", async () => {
  const root = await fixtureRoot();
  try {
    // 台账 inputs 记录的是「重生成时」的哈希：先按当前内容生成一份基线台账。
    const baseline = await deriveFixtureLedger(root);
    await writeFile(join(root, "third-party", "inventory.json"), baseline, "utf8");

    const before = await verifyInputsFreshness(root, { inputsOnly: true });
    assert.equal(before.ok, true, "基线台账与工作树一致时必须全绿");

    // 改一个手写 paths 清单**覆盖不到**的文件：ai-elements 下的 tsx 既不在
    // .agents/skills/** 也不匹配 **/package.json，正是 0.0.8 漂移的两个文件所在目录。
    const rel = "packages/ui/src/components/ai-elements/message.tsx";
    assert.equal(
      matchesAny(rel, HANDWRITTEN_PATHS),
      false,
      "前提不成立：该文件本应落在手写 paths 的覆盖之外，否则本场景没有证明力",
    );
    await writeFile(join(root, rel), "export const Message = () => 'changed';\n", "utf8");

    const after = await verifyInputsFreshness(root, { inputsOnly: true });
    assert.equal(after.ok, false, "被追踪文件改动后 inputs-only 必须失败");
    assert.deepEqual(
      after.drift.map((d) => d.file),
      [rel],
      "失败必须指名漂移文件，否则无法定位（缺口二正是靠这份指名才可见）",
    );
    assert.equal(after.drift[0].kind, "mismatch");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("L02b: 删除被追踪文件按 missing 报出，不与 mismatch 混为一谈", async () => {
  const root = await fixtureRoot();
  try {
    await writeFile(
      join(root, "third-party", "inventory.json"),
      await deriveFixtureLedger(root),
      "utf8",
    );
    const rel = "pnpm-lock.yaml";
    await rm(join(root, rel));
    const result = await verifyInputsFreshness(root, { inputsOnly: true });
    assert.equal(result.ok, false);
    assert.equal(result.drift.length, 1);
    assert.equal(result.drift[0].file, rel);
    assert.equal(result.drift[0].kind, "missing", "文件消失是 missing，不是哈希不符");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("L04: 生成的 paths-filter 覆盖台账 inputs 达 100%，且手写清单不足（缺口二）", async () => {
  const generated = await measurePathsFilterCoverage(repoRoot, { patterns: await derivePathsFilter(repoRoot) });
  assert.equal(
    generated.coverageRatio,
    1,
    `paths-filter 生成清单必须覆盖台账全部 inputs，实测 ${(generated.coverageRatio * 100).toFixed(1)}%；未覆盖项：${generated.uncovered.slice(0, 5).join(", ")}`,
  );
  assert.equal(generated.uncovered.length, 0);
  assert.ok(generated.total > 2000, "台账规模前提：inputs 应为数千项");

  // 同一份台账用手写清单比对：必须显著低于 100%。这条断言把缺口二钉成红灯事实，
  // 若将来有人把生成清单退回手写，覆盖率会掉下来而此处直接红。
  const handwritten = await measurePathsFilterCoverage(repoRoot, {
    patterns: HANDWRITTEN_PATHS,
  });
  assert.ok(
    handwritten.coverageRatio < 1,
    `手写 paths 清单若已能覆盖全部 inputs（实测 ${(handwritten.coverageRatio * 100).toFixed(1)}%），说明台账追踪面已收窄，本断言与 U13 立项证据需同步更新`,
  );
  assert.ok(
    handwritten.coverageRatio < generated.coverageRatio,
    "生成清单必须严格优于手写清单，否则本项没有净收益",
  );
});

test("L04b: 生成清单不得出现被祖先模式包含的冗余条目", async () => {
  const patterns = await derivePathsFilter(repoRoot);
  const dirs = patterns.filter((p) => p.endsWith("/**")).map((p) => p.slice(0, -3));
  const redundant = dirs.filter((d) => dirs.some((o) => o !== d && d.startsWith(`${o}/`)));
  assert.deepEqual(
    redundant,
    [],
    `嵌套目录应由祖先模式覆盖，冗余条目会让清单失去可审阅性：${redundant.join(", ")}`,
  );
  // 规模上界：目录数 + 根文件数应远小于逐文件列举（台账 inputs 数千项）。
  assert.ok(
    patterns.length < 200,
    `paths 清单应保持可审阅规模，实测 ${patterns.length} 条`,
  );
});

test("L06: 依赖树漂移时 inputs-only 仍为绿——本地探测不能替代 CI 全量重生成", async () => {
  const root = await fixtureRoot();
  try {
    const ledger = JSON.parse(await deriveFixtureLedger(root));
    // 制造只有全量模式能看见的漂移：packages/noticesSha256 派生自已安装依赖树，
    // 本地 inputs-only 无从校验，故此处故意写一个与现实不符的值。
    ledger.noticesSha256 = "0".repeat(64);
    ledger.packages = [{ name: "ghost-dep", version: "9.9.9", license: "MIT" }];
    await writeFile(
      join(root, "third-party", "inventory.json"),
      `${JSON.stringify(ledger, null, 2)}\n`,
      "utf8",
    );

    const inputsOnly = await verifyInputsFreshness(root, { inputsOnly: true });
    assert.equal(
      inputsOnly.ok,
      true,
      "inputs-only 按设计看不见依赖树派生字段：此处必须仍为绿。若它变红，说明实现越界去猜依赖树，反而会在无 install 的环境产生假失败",
    );
    assert.equal(inputsOnly.mode, "inputs-only");
    // 边界必须显式声明在结果里，供调用方（ci.yml / release.yml）与人类读者区分。
    assert.equal(
      inputsOnly.coversDependencyTree,
      false,
      "结果必须自报 coversDependencyTree=false，否则 inputs-only 的绿会被误读为发布权威结论",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("L03: --diff-only 在工作树台账被改动后失败并指名文件（workflow 复用的漂移判定）", async () => {
  // licenses-notices.yml 用 --diff-only 复用同一份漂移判定（它自己已带 musl 补丁重生成，
  // 重复全量生成会翻倍 CI 成本）。这里验判定本身：台账文件相对 HEAD 有 diff 即红且指名。
  const { stdout } = await runGit(["--no-pager", "diff", "--numstat", "--", ...LEDGER_FILES]);
  if (stdout.trim() !== "") {
    // 工作树本就有台账改动（例如开发者正在修台账）：diff-only 必须报红，正好是本场景断言。
    const result = await verifyInputsFreshness(repoRoot, { diffOnly: true });
    assert.equal(result.mode, "full-diff-only");
    assert.equal(result.ok, false, "台账有未提交改动时 diff-only 必须失败");
    assert.ok(result.changedFiles.length > 0, "失败必须指名漂移文件");
    return;
  }
  const result = await verifyInputsFreshness(repoRoot, { diffOnly: true });
  assert.equal(result.mode, "full-diff-only", "模式必须自报，供调用方区分 inputs-only 与全量");
  assert.equal(result.ok, true, "干净树上 diff-only 必须全绿");
  assert.deepEqual(result.changedFiles, []);
  assert.equal(
    result.coversDependencyTree,
    true,
    "diff-only 仍是全量口径（能看到依赖树派生字段），不得自报为 inputs-only",
  );
});

test("台账编码口径：CRLF 与 LF 视为同一内容，不因行尾差异误报漂移", async () => {
  const root = await fixtureRoot();
  try {
    await writeFile(
      join(root, "third-party", "inventory.json"),
      await deriveFixtureLedger(root),
      "utf8",
    );
    // 把工作树文件换成 CRLF：台账声明口径是「UTF-8 with CRLF normalized to LF」，
    // Windows 检出（core.autocrlf=true）必然出现这种形态，误报会让门禁在 Windows 上不可用。
    const rel = "packages/ui/src/components/ai-elements/message.tsx";
    const lf = await readFile(join(root, rel), "utf8");
    await writeFile(join(root, rel), lf.replaceAll("\n", "\r\n"), "utf8");

    const result = await verifyInputsFreshness(root, { inputsOnly: true });
    assert.equal(
      result.ok,
      true,
      "行尾差异必须被归一化吸收，否则 Windows 工作树上 inputs-only 恒红、门禁失去可用性",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * 为 fixture 生成一份最小台账：inputs 按被测实现同一口径重算，使「基线一致」成立。
 * 不复用真实生成器（那需要已安装依赖树与 Linux 口径），因为本文件验的是复现性校验
 * 自身的判定逻辑，不是生成器。
 */
async function deriveFixtureLedger(root) {
  const { createHash } = await import("node:crypto");
  const files = [
    "package.json",
    "pnpm-lock.yaml",
    "packages/ui/src/components/ai-elements/message.tsx",
  ];
  const inputs = {};
  for (const file of files) {
    const text = await readFile(join(root, file), "utf8");
    inputs[file] = createHash("sha256")
      .update(Buffer.from(text.replaceAll("\r\n", "\n"), "utf8"))
      .digest("hex");
  }
  return `${JSON.stringify({ schemaVersion: 1, inputs }, null, 2)}\n`;
}
