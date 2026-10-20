import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

/**
 * CLI git 调用硬化验收（apps/acode-cli/specs/git-invocation-hardening.md，含 R3
 * 修订/R4 预设增量）：
 * 漏斗模块（packages/shared/src/git-invocation-env.ts）的矩阵/防串仓/overlay 纯断言
 * + 真实 git 临时仓功能实证（hooks 对照组、ext:: 拒绝、worktree 生命周期冒烟）。
 * 语义对齐守护参照 packages/services/test/gitInvocationHardening.test.ts；预设
 * 增量全闭集/replace-ref/bare repo 功能段在 packages/shared/test/
 * gitHardeningPresets.test.ts（本文件键闭集为前缀守护，防两处重复维护全表）。
 */

const {
  CLI_MARKETPLACE_GIT_PROTOCOL_ALLOWLIST,
  CLI_GIT_HARDENING_ENV,
  getCliGitHardenedConfigEntries,
  getCliGitHooksNullDevicePath,
  getCliGitInvocationEnv,
  getCliGitInvocationEnvOverlay,
} = await import("../../../packages/shared/src/git-invocation-env.ts");
const { WorkflowWorktreeManager } = await import(
  "../packages/cli-workflow/src/workflow-worktree-manager.ts"
);

const tempDirs = [];
function tempDir(prefix) {
  // realpath.native 展开 %TEMP% 的 8.3 短名（同 workflow-worktree-isolation.test.mjs：
  // git 登记长名，短名比对会失配）。
  const dir = mkdtempSync(join(realpathSync.native(tmpdir()), prefix));
  tempDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});

const savedEnv = new Map();
function polluteEnv() {
  const pollution = {
    GIT_DIR: "/evil/repo/.git",
    GIT_WORK_TREE: "/evil/repo",
    GIT_INDEX_FILE: "/evil/index",
    GIT_CONFIG: "/evil/config",
    GIT_CONFIG_COUNT: "9",
    GIT_CONFIG_PARAMETERS: "'safe.directory=*'",
    GIT_CONFIG_KEY_0: "safe.directory",
    GIT_CONFIG_VALUE_0: "*",
    GIT_CONFIG_KEY_99: "alias.x",
    GIT_CONFIG_VALUE_99: "!sh -c evil",
    GIT_CONFIG_GLOBAL: "/evil/global-config",
    GIT_CONFIG_SYSTEM: "/evil/system-config",
    GIT_GRAFT_FILE: "/evil/grafts",
    GIT_NO_REPLACE_OBJECTS: "0",
    GIT_TERMINAL_PROMPT: "1",
    GIT_ASKPASS: "/evil/askpass.sh",
    GIT_NO_LAZY_FETCH: "0",
    GIT_ALLOW_PROTOCOL: "ext",
    GIT_OPTIONAL_LOCKS: "1",
  };
  for (const [key, value] of Object.entries(pollution)) {
    savedEnv.set(key, process.env[key]);
    process.env[key] = value;
  }
}
function restoreEnv() {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv.clear();
}

/** R2 基础键闭集（与 services spec R2 表一致）：矩阵键漂移会改变全部 git 命令
 * 有效配置。R4 预设增量后的全闭集守护在 shared 侧 gitHardeningPresets.test.ts；
 * 本文件按前缀守护（与 services gitInvocationHardening.test.ts 修订同款手法）。 */
const EXPECTED_CONFIG_KEYS = [
  "core.hooksPath",
  "core.fsmonitor",
  "core.askPass",
  "core.excludesFile",
  "core.attributesFile",
  "gc.auto",
  "maintenance.auto",
  "core.commitGraph",
  "gc.writeCommitGraph",
  "log.showSignature",
  "core.logAllRefUpdates",
  "submodule.recurse",
  "filter.lfs.required",
];

describe("cli git invocation hardening matrix", () => {
  test("env 层矩阵：防弹窗三保险 + 懒取/协议收口（spec R2/R3）", () => {
    polluteEnv();
    try {
      const env = getCliGitInvocationEnv();
      assert.equal(env.GIT_TERMINAL_PROMPT, "0");
      assert.equal(env.GIT_ASKPASS, "");
      assert.equal(env.GIT_NO_LAZY_FETCH, "1");
      assert.equal(env.GIT_OPTIONAL_LOCKS, "0");
      // R3 修订：默认调用点协议全拒（空串），继承的放行名单不透传。
      assert.equal(env.GIT_ALLOW_PROTOCOL, "");
      // marketplace 调用点 opt-in 白名单：内容与旧全局白名单等值（CLI 面差异：
      // 比 services push 白名单多 http，marketplace 级源存量面，spec R5 差异集）。
      assert.deepEqual([...CLI_MARKETPLACE_GIT_PROTOCOL_ALLOWLIST], [
        "file",
        "http",
        "https",
        "ssh",
      ]);
      // ext（remote-helper RCE 主向量）/git/fd 必须不在名单内。
      for (const blocked of ["ext", "git", "fd"]) {
        assert.ok(
          !CLI_MARKETPLACE_GIT_PROTOCOL_ALLOWLIST.includes(blocked),
          `marketplace 协议放行不应含 ${blocked}`,
        );
      }
      // R4/P3 完整性三件套 env 两件套：继承污染值不得弱化。
      assert.equal(env.GIT_NO_REPLACE_OBJECTS, "1");
      assert.ok(String(env.GIT_GRAFT_FILE).endsWith("no-grafts"));
      assert.notEqual(env.GIT_GRAFT_FILE, "/evil/grafts");
      assert.equal(CLI_GIT_HARDENING_ENV.GIT_TERMINAL_PROMPT, "0");
      // pager/TERM/LC 固定（与 services 漏斗尾部同款）。
      assert.equal(env.GIT_PAGER, "cat");
      assert.equal(env.PAGER, "cat");
      assert.equal(env.TERM, "dumb");
      assert.equal(env.LC_ALL, "C");
      assert.equal(env.LANG, "C");
    } finally {
      restoreEnv();
    }
  });

  test("防串仓：local env 剥离、矩阵不被继承值覆盖、残留编号键删净（spec R2）", () => {
    polluteEnv();
    try {
      const env = getCliGitInvocationEnv();
      assert.equal(env.GIT_DIR, undefined);
      assert.equal(env.GIT_WORK_TREE, undefined);
      assert.equal(env.GIT_INDEX_FILE, undefined);
      assert.equal(env.GIT_CONFIG, undefined);
      assert.equal(env.GIT_CONFIG_PARAMETERS, undefined);
      // R4/P2 入站消毒增量：全局/系统配置重定向通道被剥离。
      assert.equal(env.GIT_CONFIG_GLOBAL, undefined);
      assert.equal(env.GIT_CONFIG_SYSTEM, undefined);
      const entries = getCliGitHardenedConfigEntries();
      assert.equal(env.GIT_CONFIG_COUNT, String(entries.length));
      entries.forEach(([key, value], index) => {
        assert.equal(env[`GIT_CONFIG_KEY_${index}`], key);
        assert.equal(env[`GIT_CONFIG_VALUE_${index}`], value);
      });
      // 污染的 safe.directory 注入被矩阵第 0 键覆盖，而非并存。
      assert.equal(env.GIT_CONFIG_KEY_0, entries[0][0]);
      assert.notEqual(env.GIT_CONFIG_KEY_0, "safe.directory");
      // 超出矩阵长度的残留编号键必须被删除（防夹带）。
      assert.equal(env.GIT_CONFIG_KEY_99, undefined);
      assert.equal(env.GIT_CONFIG_VALUE_99, undefined);
    } finally {
      restoreEnv();
    }
  });

  test("矩阵键闭集与关键值（services R2 表一致性，防漂移）", () => {
    const entries = getCliGitHardenedConfigEntries("linux");
    // 前缀守护：基础 13 键顺序与 services R2 表一致；R4 增量键跟随其后
    // （全闭集断言在 shared 侧 gitHardeningPresets.test.ts，防两处维护全表）。
    assert.deepEqual(
      entries.slice(0, EXPECTED_CONFIG_KEYS.length).map(([key]) => key),
      EXPECTED_CONFIG_KEYS,
    );
    assert.ok(entries.length > EXPECTED_CONFIG_KEYS.length, "R4 预设增量键应已落地");
    const asMap = new Map(entries);
    assert.equal(asMap.get("core.hooksPath"), "/dev/null");
    assert.equal(asMap.get("gc.auto"), "0");
    assert.equal(asMap.get("maintenance.auto"), "false");
    assert.equal(asMap.get("core.commitGraph"), "false");
    assert.equal(asMap.get("gc.writeCommitGraph"), "false");
    assert.equal(asMap.get("log.showSignature"), "false");
    assert.equal(asMap.get("core.logAllRefUpdates"), "false");
    assert.equal(asMap.get("submodule.recurse"), "false");
    assert.equal(asMap.get("filter.lfs.required"), "false");
    // LFS clean/smudge/process 有意不清空（会写坏 LFS 仓库 switch/commit 语义，
    // 照搬 services R2 偏差）。
    for (const absent of ["filter.lfs.clean", "filter.lfs.smudge", "filter.lfs.process"]) {
      assert.equal(asMap.has(absent), false);
    }
    // credential.helper 有意不清空（https 静默取凭据依赖，照搬 services R3 偏差）。
    assert.equal(asMap.has("credential.helper"), false);
  });

  test("hooksPath 空设备双平台分支（win32 \\\\.\\NUL / POSIX /dev/null）", () => {
    assert.equal(getCliGitHooksNullDevicePath("win32"), "\\\\.\\NUL");
    assert.equal(getCliGitHooksNullDevicePath("linux"), "/dev/null");
    assert.equal(getCliGitHooksNullDevicePath("darwin"), "/dev/null");
    assert.equal(
      new Map(getCliGitHardenedConfigEntries("win32")).get("core.hooksPath"),
      "\\\\.\\NUL",
    );
  });

  test("overlay 形态：set 全矩阵、unset 含 local env 与继承编号键（spec R2）", () => {
    polluteEnv();
    try {
      const overlay = getCliGitInvocationEnvOverlay();
      const entries = getCliGitHardenedConfigEntries();
      assert.equal(overlay.set.GIT_CONFIG_COUNT, String(entries.length));
      assert.equal(overlay.set.GIT_CONFIG_KEY_0, entries[0][0]);
      assert.equal(overlay.set.GIT_TERMINAL_PROMPT, "0");
      assert.equal(overlay.set.GIT_ASKPASS, "");
      // R3 修订：overlay 默认同样全拒；协议键进 unset（继承值先删，per-call 后写）。
      assert.equal(overlay.set.GIT_ALLOW_PROTOCOL, "");
      assert.ok(overlay.unset.includes("GIT_ALLOW_PROTOCOL"));
      assert.equal(overlay.set.GIT_OPTIONAL_LOCKS, "0");
      for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_CONFIG", "GIT_CONFIG_PARAMETERS"]) {
        assert.ok(overlay.unset.includes(key), `unset 应含 ${key}`);
      }
      for (const key of ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM"]) {
        assert.ok(overlay.unset.includes(key), `unset 应含 ${key}`);
      }
      // 超出矩阵长度的继承编号键进 unset（set 只覆盖 0..N-1）。
      assert.ok(overlay.unset.includes("GIT_CONFIG_KEY_99"));
      assert.ok(overlay.unset.includes("GIT_CONFIG_VALUE_99"));

      // opt-in 形态（API 对称性；当前 overlay 消费点全为本地命令，无生产放行点）。
      const opted = getCliGitInvocationEnvOverlay(process.env, process.platform, {
        allowedProtocols: CLI_MARKETPLACE_GIT_PROTOCOL_ALLOWLIST,
      });
      assert.equal(opted.set.GIT_ALLOW_PROTOCOL, "file:http:https:ssh");
    } finally {
      restoreEnv();
    }
  });

  test("baseEnv 注入：marketplace 叠加形态保留基底键、硬化键后写（spec R2）", () => {
    const base = { HTTPS_PROXY: "http://proxy:8080", GIT_DIR: "/evil/.git", PATH: "/bin" };
    const env = getCliGitInvocationEnv(base);
    assert.equal(env.HTTPS_PROXY, "http://proxy:8080");
    assert.equal(env.PATH, "/bin");
    assert.equal(env.GIT_DIR, undefined);
    assert.equal(env.GIT_TERMINAL_PROMPT, "0");
  });
});

// ---- 功能段：真实 git 临时仓 fixture（git 不可用则 skip）----

const gitProbe = spawnSync("git", ["--version"], { stdio: "ignore" });
const gitAvailable = gitProbe.status === 0;

function fixtureGit(args, cwd, env) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    ...(env ? { env } : {}),
  }).trim();
}

describe(
  "cli git invocation hardening functional (temp repo)",
  { skip: gitAvailable ? false : "git binary not available" },
  () => {
    let repoRoot;

    before(() => {
      repoRoot = tempDir("acode-cli-git-hardening-");
      fixtureGit(["init", "-q", "-b", "main", "."], repoRoot);
      fixtureGit(["config", "user.email", "hardening@test.local"], repoRoot);
      fixtureGit(["config", "user.name", "hardening-test"], repoRoot);
      // 仓库自带 pre-commit hook：硬化 env 下不得执行（写不出 hook-proof）。
      writeFileSync(
        join(repoRoot, ".git", "hooks", "pre-commit"),
        "#!/bin/sh\necho HOOK_RAN > hook-proof.txt\nexit 0\n",
        { mode: 0o755 },
      );
      writeFileSync(join(repoRoot, "a.txt"), "a\n");
      fixtureGit(["add", "a.txt"], repoRoot);
    });

    test("硬化 env 下只读命令正常、config 注入生效", () => {
      const env = getCliGitInvocationEnv();
      const status = spawnSync("git", ["status", "--porcelain"], {
        cwd: repoRoot,
        env,
        encoding: "utf8",
      });
      assert.equal(status.status, 0, status.stderr);
      const hooksPath = fixtureGit(["config", "--get", "core.hooksPath"], repoRoot, env);
      assert.equal(hooksPath, getCliGitHooksNullDevicePath());
      assert.equal(fixtureGit(["config", "--get", "gc.auto"], repoRoot, env), "0");
    });

    test("硬化 env 下 commit 成功且仓库 hooks 不执行；对照组 hooks 执行", () => {
      const hardened = getCliGitInvocationEnv();
      const hookProofPath = join(repoRoot, "hook-proof.txt");
      const commit = spawnSync("git", ["commit", "-q", "-m", "hardened"], {
        cwd: repoRoot,
        env: hardened,
        encoding: "utf8",
      });
      assert.equal(commit.status, 0, commit.stderr);
      // hooksPath 指向空设备：pre-commit 打不开，hook-proof.txt 不应出现。
      assert.equal(existsSync(hookProofPath), false);

      // 对照组：无硬化 env 时 git 走默认 .git/hooks，pre-commit 应当执行。
      writeFileSync(join(repoRoot, "b.txt"), "b\n");
      fixtureGit(["add", "b.txt"], repoRoot);
      const control = spawnSync("git", ["commit", "-q", "-m", "control"], {
        cwd: repoRoot,
        env: process.env,
        encoding: "utf8",
      });
      assert.equal(control.status, 0, control.stderr);
      assert.equal(existsSync(hookProofPath), true);
    });

    test("GIT_ALLOW_PROTOCOL 封 ext::：拒绝且 remote-helper 不执行、不挂起", () => {
      const env = getCliGitInvocationEnv();
      const startedAt = Date.now();
      const result = spawnSync("git", ["ls-remote", "ext::sh -c echo%20HACKED"], {
        cwd: repoRoot,
        env,
        encoding: "utf8",
        timeout: 20_000,
      });
      assert.notEqual(result.status, 0, "ext:: 传输应被 GIT_ALLOW_PROTOCOL 拒绝");
      assert.ok(!`${result.stderr}${result.stdout}`.includes("HACKED"), "remote-helper 不得被执行");
      assert.ok(Date.now() - startedAt < 20_000, "不得挂起等待输入");
    });

    test("worktree 生命周期冒烟：默认 runner（硬化 env）ensure/release 不受损", async () => {
      // 走 WorkflowWorktreeManager 的缺省 execFile runner —— 即消费点 #4 接线后的
      // 真实执行面：worktree add/list/prune/remove、rev-parse、status、branch -D
      // 全部在硬化 env 下跑（既有 workflow-worktree-isolation.test.mjs 的紧凑冒烟）。
      const manager = new WorkflowWorktreeManager({ tmpRoot: tempDir("acode-cli-wt-smoke-") });
      const handle = await manager.ensureWorktree({
        repoDir: repoRoot,
        runId: "hardening-smoke",
        activityId: "a1",
      });
      assert.ok(existsSync(handle.path), "worktree 目录应已创建");
      // win32 盘符大小写在 git 输出与 fs 规范形态间可能漂移，按平台归一比对。
      const normalizeRoot = (value) =>
        process.platform === "win32" ? value.toLowerCase() : value;
      assert.equal(normalizeRoot(handle.repoRoot), normalizeRoot(realpathSync.native(repoRoot)));
      assert.ok(handle.branch.startsWith("acode/workflow/hardening-smoke/"));
      // 幂等复用：同 activity 再 ensure 返回同一 handle 形态。
      const again = await manager.ensureWorktree({
        repoDir: repoRoot,
        runId: "hardening-smoke",
        activityId: "a1",
      });
      assert.equal(again.path, handle.path);
      const released = await manager.releaseWorktree(handle);
      assert.deepEqual(
        { kept: released.kept, reason: released.reason },
        { kept: false, reason: "clean-reclaimed" },
      );
      assert.equal(existsSync(handle.path), false, "clean worktree 应被回收");
    });
  },
);
