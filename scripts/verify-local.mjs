// 本地验证门禁：与 .github/workflows/ci.yml 的 verify job 对齐的 8 道门，按单次成本升序执行。
//
// 原因（docs/specs/local-verify-gates.md G1/G2）：仓库此前没有任何入库 hook，文档指定的
// 推送前门禁 `pnpm verify:pre-push` 只覆盖 CI 8 道门中的 1.5 道（lint + architecture --changed），
// typecheck / knip / ledger / CLI workspace lint / 测试全部只能在 runner 上首次暴露，
// 单轮反馈 17 分钟（verify 13m45s → remote-ssh 3m15s）。本脚本把同一组门禁搬到本地，
// 并按实测成本排序——前四门合计 <30s，机械失败在 30s 内暴露，而不是等最慢的 typecheck
// 跑完 4 分钟才知道 lint 早就红了。
//
// 与 CI 的顺序差异是有意的：CI 保持既有顺序（Typecheck 的 cli 阶段产出 dist 供后续步骤复用），
// 本地按成本升序取更快的失败信号。每道门的 `ci` 字段记录它对应 ci.yml 的哪条 `run`，
// 由 apps/acode-cli/tests/verify-local-gate.test.mjs 逐字校验，防止两边漂移。
import { execFile, spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GateUsageError, runStagedGate } from "./gate-runner.mjs";
import { withPinnedNodePath } from "./mise-toolchain-env.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Windows 上 pnpm 是 .cmd shim，无 shell 不能被 Node spawn（与 scripts/mise-run.mjs 同因）。
const isWin = process.platform === "win32";
const PNPM = isWin ? "pnpm.cmd" : "pnpm";
// 用 node 直跑 JS 入口而非 npx/pnpm exec：少一层进程解析，且与 typecheck-gate.mjs 同一约定。
const TURBO_ENTRY = "node_modules/turbo/bin/turbo";

export class VerifyUsageError extends GateUsageError {}

// 根级输入：pnpm --filter 的图推导只看包目录，看不见这些文件，命中即强制全量（spec R4.14）。
const ROOT_SCOPE_FILES = new Set([
  "pnpm-lock.yaml",
  "package.json",
  "pnpm-workspace.yaml",
  ".oxlintrc.json",
  "knip.jsonc",
  "architecture-policy.yaml",
  ".architecture-baseline.json",
  "mise.toml",
]);
const ROOT_SCOPE_PREFIXES = ["scripts/", ".github/workflows/"];

export function isRootScopeInput(rawPath) {
  const path = rawPath.replaceAll("\\", "/");
  if (ROOT_SCOPE_FILES.has(path)) return true;
  // 只认根级 tsconfig*.json；包内 tsconfig 属包变更，--filter 能看见。
  if (/^tsconfig[^/]*\.json$/.test(path)) return true;
  return ROOT_SCOPE_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function git(args) {
  return new Promise((resolvePromise) => {
    execFile(
      "git",
      args,
      { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      (error, stdout) => resolvePromise({ ok: !error, out: (stdout ?? "").trim() }),
    );
  });
}

function pnpmCapture(args) {
  return new Promise((resolvePromise) => {
    const child = spawn(isWin ? [PNPM, ...args].join(" ") : PNPM, isWin ? [] : args, {
      cwd: repoRoot,
      shell: isWin,
      env: withPinnedNodePath(process.env, process.execPath),
      windowsHide: true,
    });
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk.toString("utf8");
    });
    child.stderr.on("data", () => {});
    child.on("error", () => resolvePromise({ ok: false, out: "" }));
    child.on("close", (code) => resolvePromise({ ok: code === 0, out }));
  });
}

// 基线优先级：upstream（pre-push 场景即「本次待推送的提交」）→ origin/dev → origin/main。
// 依据 docs/git-collaboration.md 的分支模型：dev 是集成主干，功能分支 PR 到 dev。
async function resolveBaseRef() {
  for (const ref of ["@{upstream}", "origin/dev", "origin/main"]) {
    const { ok, out } = await git(["rev-parse", "--verify", "--quiet", ref]);
    if (ok && out) return ref;
  }
  return null;
}

async function listAffectedPackages(baseRef) {
  const { ok, out } = await pnpmCapture([
    "list",
    "-r",
    "--depth",
    "-1",
    "--json",
    `--filter=...[${baseRef}]`,
  ]);
  if (!ok) return null;
  let parsed;
  try {
    parsed = JSON.parse(out);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  return (
    parsed
      // 排除根包：根 package.json 的 test 脚本本身就是 `pnpm -r run test`，
      // 选中它会让「按变更范围」静默退化成全量递归。
      .filter((entry) => entry?.path && resolve(entry.path) !== repoRoot)
      .map((entry) => entry.name)
      .filter((name) => typeof name === "string" && name.length > 0)
  );
}

/**
 * 决定 tests 门的范围。原则（spec R4.12）：任何不确定都退回全量，并打印原因——
 * 宁可多跑，不可静默缩小范围后把「没跑」当成「通过」。
 */
export async function resolveTestScope({ full }) {
  if (full) return { mode: "full", reason: "--full：与 ci.yml verify 对齐，跑全量测试" };

  const baseRef = await resolveBaseRef();
  if (!baseRef) {
    return {
      mode: "full",
      reason: "无法解析基线 ref（无 upstream，origin/dev 与 origin/main 均不可用）→ 跑全量",
    };
  }

  const untracked = await git(["ls-files", "--others", "--exclude-standard"]);
  if (untracked.ok && untracked.out) {
    const preview = untracked.out.split("\n").slice(0, 5).join("、");
    return {
      mode: "full",
      reason: `存在未纳入 git 的新文件（--filter 的图推导看不见）→ 跑全量：${preview}`,
    };
  }

  const diff = await git(["diff", "--name-only", baseRef]);
  const changed = diff.ok ? diff.out.split("\n").filter(Boolean) : [];
  const rootHits = changed.filter(isRootScopeInput);
  if (rootHits.length > 0) {
    return { mode: "full", reason: `根级输入变更（${rootHits.join("、")}）→ 跑全量` };
  }

  const packages = await listAffectedPackages(baseRef);
  if (packages === null) {
    return { mode: "full", reason: `受影响包解析失败（基线 ${baseRef}）→ 跑全量` };
  }
  if (packages.length === 0) {
    return {
      mode: "none",
      reason: `相对 ${baseRef} 无受影响的包，不执行任何测试（这不等于「测试通过」）`,
    };
  }
  return {
    mode: "affected",
    packages,
    reason: `相对 ${baseRef} 受影响的包（含依赖方）：${packages.join("、")}`,
  };
}

// 每道门自带 ci.run：与 ci.yml verify 的 run 逐字一致，由测试校验（spec 验收 1）。
export function buildStages(scope) {
  const pnpmStage = { command: PNPM, fromPath: true, shell: isWin };
  const tests =
    scope.mode === "affected"
      ? {
          id: "tests",
          label: `受影响包测试（串行，${scope.packages.length} 个包）`,
          ...pnpmStage,
          // --workspace-concurrency=1 是承重墙：跨包并发会让 concurrency-diagnostics /
          // acp-host-adapter / cua-failclosed-gating 三个负载敏感测试假红（spec「承重事实」）。
          args: [
            "-r",
            "--workspace-concurrency=1",
            ...scope.packages.flatMap((name) => [`--filter=${name}`]),
            "run",
            "test",
          ],
          dependsOn: ["build-cli"],
          ci: { step: "Tests (all packages)", run: "pnpm test", note: "本地按变更范围收窄" },
        }
      : scope.mode === "none"
        ? {
            id: "tests",
            label: scope.reason,
            command: "node",
            args: ["-e", `console.log(${JSON.stringify(scope.reason)})`],
            dependsOn: [],
            ci: { step: "Tests (all packages)", run: "pnpm test", note: "无受影响包，未执行" },
          }
        : {
            id: "tests",
            label: "全量测试（所有包，串行）",
            ...pnpmStage,
            args: ["test"],
            dependsOn: ["build-cli"],
            ci: { step: "Tests (all packages)", run: "pnpm test" },
          };

  return [
    {
      id: "lint",
      label: "根 workspace lint（oxlint）",
      ...pnpmStage,
      args: ["lint"],
      dependsOn: [],
      ci: { step: "Lint", run: "pnpm lint" },
    },
    {
      id: "architecture",
      label: "架构检查（全量，与 CI 同范围，非 --changed）",
      ...pnpmStage,
      args: ["architecture:check"],
      dependsOn: [],
      ci: { step: "Architecture check", run: "pnpm architecture:check" },
    },
    {
      id: "knip",
      label: "死文件/死依赖门禁",
      ...pnpmStage,
      args: ["knip:gate"],
      dependsOn: [],
      ci: { step: "Knip (files & dependencies gate)", run: "pnpm knip:gate" },
    },
    {
      id: "ledger",
      label: "third-party 台账 inputs 新鲜度",
      command: "node",
      args: ["scripts/licenses.mjs", "reproducibility", "--inputs-only"],
      dependsOn: [],
      ci: {
        step: "Third-party ledger inputs freshness",
        run: "node scripts/licenses.mjs reproducibility --inputs-only",
      },
    },
    {
      id: "typecheck",
      label: "统一类型门禁（三阶段单一入口）",
      ...pnpmStage,
      args: ["typecheck"],
      dependsOn: [],
      ci: { step: "Typecheck", run: "pnpm typecheck" },
    },
    {
      id: "build-cli",
      label: "构建 CLI workspace 兄弟包 dist（tests 的前置）",
      command: "node",
      args: [
        TURBO_ENTRY,
        "--skip-infer",
        "--cwd",
        "apps/acode-cli",
        "run",
        "build",
        "--filter=!@acode/cli",
      ],
      // CI 里该步骤紧随 Typecheck，turbo 本地缓存命中故仅 11s；本地同序以复用同一份 dist。
      dependsOn: ["typecheck"],
      ci: {
        step: "Build CLI workspace packages",
        run: "npx turbo --skip-infer --cwd apps/acode-cli run build --filter='!@acode/cli'",
        note: "本地经 node 直跑 turbo 入口，等价于 npx turbo",
      },
    },
    {
      id: "lint-cli",
      label: "CLI workspace lint（独立 oxlint 配置，根 lint 扫不到）",
      command: "node",
      args: [TURBO_ENTRY, "--cwd", "apps/acode-cli", "run", "lint"],
      dependsOn: [],
      ci: {
        step: "Lint CLI workspace",
        run: "pnpm exec turbo --cwd apps/acode-cli run lint",
        note: "本地经 node 直跑 turbo 入口，等价于 pnpm exec turbo",
      },
    },
    tests,
  ];
}

const USAGE = `用法：node scripts/verify-local.mjs [--full] [--only <gate>]... [--list]

门禁（按单次成本升序，与 ci.yml verify 的 run 逐字对应）：
  lint / architecture / knip / ledger / typecheck / build-cli / lint-cli / tests

默认档（pnpm verify:pre-push）：前 7 道门全跑 + tests 只跑受影响包。
--full（pnpm verify:ci）：tests 跑全量，语义 = ci.yml verify 的本地等价。
--only 只用于开发快循环；跳过的前置门会在输出里显式声明，不等于通过。`;

function parseArgs(argv) {
  const options = { full: false, only: [], list: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--full") options.full = true;
    else if (arg === "--list") options.list = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--only") {
      const value = argv[++i];
      if (!value) throw new VerifyUsageError("--only 需要门禁 id");
      options.only.push(value);
    } else throw new VerifyUsageError(`未知参数：${arg}`);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const scope = await resolveTestScope({ full: options.full });
  if (options.list) {
    for (const stage of buildStages(scope)) {
      process.stdout.write(
        `${stage.id.padEnd(14)} ${stage.ci.run}${stage.ci.note ? `  # ${stage.ci.note}` : ""}\n`,
      );
    }
    return 0;
  }
  process.stdout.write(`tests 范围：${scope.reason}\n\n`);
  return runStagedGate({
    stages: buildStages(scope),
    only: options.only,
    // 串行是刻意的：本门禁的价值在于「便宜的先跑、第一处失败即停」，
    // 并行会让 4 分钟的 typecheck 与秒级的 lint 同时启动，失败信号被淹没。
    sequential: true,
    repoRoot,
    title: "本地验证门禁",
    reproScript: "node scripts/verify-local.mjs",
    env: withPinnedNodePath(process.env, process.execPath),
    UsageError: VerifyUsageError,
  });
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      if (error instanceof VerifyUsageError) {
        process.stderr.write(`${error.message}\n${USAGE}\n`);
        process.exitCode = 2;
        return;
      }
      throw error;
    },
  );
}
