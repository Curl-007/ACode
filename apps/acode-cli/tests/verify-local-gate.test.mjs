// 本地验证门禁（scripts/verify-local.mjs）的 CI 对齐与承重约束验收。
//
// 放在 apps/acode-cli/tests 与 typecheck-gate.test.mjs 同因：根 scripts/ 没有自己的
// 测试入口，仓库级工具测试历来挂在这里，随 `pnpm test` 进 CI。
//
// 覆盖 docs/specs/local-verify-gates.md 的验收 1/2/4/9 与 R1/R2/R4：
// 1. CI 对齐——每道门声明的 ci.run 必须与 ci.yml verify 的 run 逐字一致，且 ci.yml
//    verify 的每一条门禁步骤都被覆盖（防止 CI 加门而本地不知道，正是 G2 的成因）；
// 2. 顺序——秒级门必须排在 typecheck/tests 之前（R2.5 的失败信号前提）；
// 3. 串行承重——workspace-concurrency=1 不得被放宽（「承重事实」小节）；
// 4. 范围回退——根级输入必须强制全量（R4.14）；
// 5. hook 入库且不可被吞掉（R3.10，G1 的直接回归）。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildStages, isRootScopeInput } from "../../../scripts/verify-local.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (...parts) => readFileSync(join(repoRoot, ...parts), "utf8");

// ci.yml 的 verify 步骤全是单行 `run:`（多行 `run: |` 只出现在 warm-cache.yml），
// 故按行解析即可，不引入 YAML 依赖——与 typecheck-gate.test.mjs 的旁路扫描同一手法。
function parseVerifySteps() {
  const lines = read(".github", "workflows", "ci.yml").split("\n");
  const start = lines.findIndex((line) => /^ {2}verify:\s*$/.test(line));
  assert.ok(start >= 0, "ci.yml 必须有 verify job");
  const steps = new Map();
  let pendingName = null;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^ {2}\S/.test(lines[i])) break; // 下一个 job
    const name = lines[i].match(/^\s*- name: (.+?)\s*$/);
    if (name) {
      pendingName = name[1].trim();
      continue;
    }
    const run = lines[i].match(/^\s*run: (.+?)\s*$/);
    if (run && pendingName) {
      steps.set(pendingName, run[1].trim());
      pendingName = null;
    }
  }
  return steps;
}

// 环境准备步骤，不是门禁，本地无对应物。
const NON_GATE_STEPS = new Set(["Install dependencies"]);

test("每道门的 ci.run 与 ci.yml verify 的 run 逐字一致", () => {
  const ciSteps = parseVerifySteps();
  const stages = buildStages({ mode: "full", reason: "test" });
  assert.equal(stages.length, 8, "本地门禁必须是 8 道门");

  for (const stage of stages) {
    assert.ok(stage.ci?.step, `${stage.id} 缺少 ci.step 映射`);
    assert.ok(ciSteps.has(stage.ci.step), `ci.yml verify 没有步骤「${stage.ci.step}」（${stage.id}）`);
    assert.equal(
      stage.ci.run,
      ciSteps.get(stage.ci.step),
      `${stage.id} 的 ci.run 与 ci.yml 不一致——两边有一边改了，本地门禁不再等价`,
    );
  }
});

test("ci.yml verify 的每条门禁步骤都被本地覆盖", () => {
  const ciSteps = parseVerifySteps();
  const covered = new Set(buildStages({ mode: "full", reason: "test" }).map((s) => s.ci.step));
  const uncovered = [...ciSteps.keys()].filter(
    (step) => !covered.has(step) && !NON_GATE_STEPS.has(step),
  );
  assert.deepEqual(
    uncovered,
    [],
    `ci.yml verify 有本地未覆盖的门禁步骤（G2 的成因）：${uncovered.join(", ")}`,
  );
});

test("秒级门排在 typecheck 与 tests 之前", () => {
  const ids = buildStages({ mode: "full", reason: "test" }).map((stage) => stage.id);
  assert.deepEqual(ids, [
    "lint",
    "architecture",
    "knip",
    "ledger",
    "typecheck",
    "build-cli",
    "lint-cli",
    "tests",
  ]);
  // R2.5 的实质：实测前四门合计 <30s，typecheck 4m10s、tests 8m15s。
  for (const cheap of ["lint", "architecture", "knip", "ledger"]) {
    assert.ok(ids.indexOf(cheap) < ids.indexOf("typecheck"), `${cheap} 必须早于 typecheck`);
    assert.ok(ids.indexOf(cheap) < ids.indexOf("tests"), `${cheap} 必须早于 tests`);
  }
});

test("typecheck 门逐字走单一入口，不内联单阶段命令", () => {
  const stage = buildStages({ mode: "full", reason: "test" }).find((s) => s.id === "typecheck");
  assert.equal(stage.ci.run, "pnpm typecheck");
  // cli-validation-gates.md 规则 5：不得出现 renderer / CLI 单入口旁路。
  assert.ok(!stage.args.some((arg) => arg.includes("tsconfig.renderer.json")));
  assert.ok(!stage.args.some((arg) => arg.includes("--only")));
});

test("串行承重：全量与受影响两种模式都保持 workspace-concurrency=1", () => {
  const root = JSON.parse(read("package.json"));
  assert.match(
    root.scripts.test,
    /--workspace-concurrency=1/,
    "根 test 脚本的串行编排是承重墙：跨包并发会让 concurrency-diagnostics / acp-host-adapter / cua-failclosed-gating 假红",
  );

  const affected = buildStages({
    mode: "affected",
    reason: "test",
    packages: ["@acode/shared", "@acode/rpc"],
  }).find((stage) => stage.id === "tests");
  assert.ok(
    affected.args.includes("--workspace-concurrency=1"),
    "受影响模式同样不得放宽串行",
  );
  assert.deepEqual(
    affected.args.filter((arg) => arg.startsWith("--filter=")),
    ["--filter=@acode/shared", "--filter=@acode/rpc"],
  );
});

test("tests 门依赖 build-cli，避免干净树上 ERR_MODULE_NOT_FOUND", () => {
  for (const mode of ["full", "affected"]) {
    const stage = buildStages({ mode, reason: "test", packages: ["@acode/shared"] }).find(
      (s) => s.id === "tests",
    );
    assert.deepEqual(stage.dependsOn, ["build-cli"], `${mode} 模式的 tests 必须前置 build-cli`);
  }
  // none 模式不跑任何测试，不应触发无谓构建。
  const none = buildStages({ mode: "none", reason: "无受影响包" }).find((s) => s.id === "tests");
  assert.deepEqual(none.dependsOn, []);
});

test("根级输入强制全量，包内文件不强制", () => {
  for (const hit of [
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    ".oxlintrc.json",
    "knip.jsonc",
    "architecture-policy.yaml",
    ".architecture-baseline.json",
    "mise.toml",
    "tsconfig.json",
    "tsconfig.base.json",
    "scripts/verify-local.mjs",
    ".github/workflows/ci.yml",
  ]) {
    assert.equal(isRootScopeInput(hit), true, `${hit} 应强制全量（--filter 看不见根级输入）`);
  }
  for (const miss of [
    "README.md",
    "docs/specs/local-verify-gates.md",
    "packages/ui/src/store/theme.ts",
    // 包内 package.json / tsconfig 属包变更，--filter 的图推导能看见。
    "packages/ui/package.json",
    "packages/desktop/tsconfig.renderer.json",
  ]) {
    assert.equal(isRootScopeInput(miss), false, `${miss} 不应强制全量`);
  }
});

test("package.json 的两档入口都只调用单一脚本，不内联门禁串接", () => {
  const scripts = JSON.parse(read("package.json")).scripts;
  assert.equal(scripts["verify:pre-push"], "node scripts/verify-local.mjs");
  assert.equal(scripts["verify:ci"], "node scripts/verify-local.mjs --full");
  // R1.1：内联 && 串接会催生绕过其中某一门的旁路。
  for (const key of ["verify:pre-push", "verify:ci"]) {
    assert.ok(!scripts[key].includes("&&"), `${key} 不得内联串接门禁命令`);
  }
});

test(".husky/pre-push 存在、未被忽略、阻断失败且不吞退出码", () => {
  const hookPath = join(repoRoot, ".husky", "pre-push");
  assert.ok(existsSync(hookPath), "G1 的直接回归：.husky/pre-push 必须存在");

  const content = readFileSync(hookPath, "utf8");
  assert.match(content, /pnpm verify:pre-push/, "hook 必须调用统一入口");

  // 只校验可执行部分：hook 的注释里正当引用了 `|| true` 与 `--no-verify`
  // 来说明「为什么不允许」，按全文匹配会把说明本身判成违规。
  const executable = content
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#") && line.trim().length > 0)
    .join("\n");
  assert.ok(!executable.includes("|| true"), "hook 不得吞掉失败");
  assert.ok(!executable.includes("--no-verify"), "hook 不得自我绕过");
  assert.ok(!executable.includes("exit 0"), "hook 不得强制成功退出");
  assert.equal(executable.trim(), "pnpm verify:pre-push", "hook 的可执行部分应只有统一入口一条");

  // G1 的根因是 hook 从未入库（core.hooksPath 指向 .husky/_，shim 找不到文件即静默放行）。
  // 未被 git 忽略 = 可以被提交；提交后由 git ls-files 兜底。
  let ignored = true;
  try {
    execFileSync("git", ["check-ignore", "--quiet", ".husky/pre-push"], { cwd: repoRoot });
  } catch {
    ignored = false; // 退出码 1 = 未被忽略
  }
  assert.equal(ignored, false, ".husky/pre-push 被 gitignore 挡住，等于没有 hook");

  // hook 无扩展名，.gitattributes 的 *.mjs / *.sh 规则覆盖不到它。husky 的 _/h 以
  // `sh -e "$s"` 调用，CRLF 会把 \r 带进命令名，于是 core.autocrlf=true 的检出上
  // hook 静默失效——它要拦的门禁全部不跑，且没有任何报错。
  const attrs = execFileSync("git", ["check-attr", "eol", "--", ".husky/pre-push"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.match(attrs, /eol:\s*lf/, `.husky/pre-push 必须强制 LF，否则 Windows 检出后 hook 失效：${attrs}`);
});

test("治理脚本自身守 400 行上限", () => {
  // reporting.mjs:4-5 记载的既有约束：治理工具必须先守规则。
  for (const file of [
    "scripts/verify-local.mjs",
    "scripts/gate-runner.mjs",
    "scripts/typecheck-gate.mjs",
    "scripts/architecture/policy.mjs",
    "scripts/architecture/git-ignored.mjs",
  ]) {
    const lines = read(file).split("\n").length;
    assert.ok(lines < 400, `${file} 有 ${lines} 行，超过架构 ratchet 的 400 行上限`);
  }
});
