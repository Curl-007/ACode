import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import {
  GIT_ALLOW_PROTOCOL_WHITELIST,
  GIT_HARDENING_ENV,
  getGitCommandEnv,
  getGitHardenedConfigEntries,
  getGitHooksNullDevicePath,
} from "../src/git/config.js";

/**
 * git 调用硬化预设矩阵守护（specs/git-invocation-hardening.md）。
 * 纯函数断言覆盖 env 层/config 层矩阵与防串仓保留；功能段用临时 repo fixture
 * 验证 hooksPath 空设备真实停用仓库 hooks（git 不可用则该段 skip）。
 */

const savedEnv = new Map<string, string | undefined>();

function polluteEnv(): void {
  const pollution: Record<string, string> = {
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

function restoreEnv(): void {
  for (const [key, value] of savedEnv) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  savedEnv.clear();
}

/** R2 键闭集：矩阵键集合漂移会直接改变全部 git 命令的有效配置，必须显式守护。 */
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

describe("git invocation hardening matrix", () => {
  test("env 层矩阵：防弹窗三保险 + 懒取/协议收口（R3/R4）", () => {
    polluteEnv();
    try {
      const env = getGitCommandEnv();
      assert.equal(env.GIT_TERMINAL_PROMPT, "0");
      assert.equal(env.GIT_ASKPASS, "");
      assert.equal(env.GIT_NO_LAZY_FETCH, "1");
      assert.equal(env.GIT_ALLOW_PROTOCOL, GIT_ALLOW_PROTOCOL_WHITELIST);
      assert.equal(GIT_ALLOW_PROTOCOL_WHITELIST, "file:https:ssh");
      // 白名单形态：ext（remote-helper RCE 主向量）/git/fd/http 必须不在名单内。
      for (const blocked of ["ext", "git", "fd", "http"]) {
        assert.ok(
          !GIT_ALLOW_PROTOCOL_WHITELIST.split(":").includes(blocked),
          `GIT_ALLOW_PROTOCOL 不应放行 ${blocked}`,
        );
      }
      assert.equal(GIT_HARDENING_ENV.GIT_TERMINAL_PROMPT, "0");
    } finally {
      restoreEnv();
    }
  });

  test("既有防串仓与约束变量保留（R5）", () => {
    polluteEnv();
    try {
      const env = getGitCommandEnv();
      // local env 剥离：串仓注入面必须被清掉。
      assert.equal(env.GIT_DIR, undefined);
      assert.equal(env.GIT_WORK_TREE, undefined);
      assert.equal(env.GIT_INDEX_FILE, undefined);
      assert.equal(env.GIT_CONFIG, undefined);
      assert.equal(env.GIT_CONFIG_PARAMETERS, undefined);
      // 既有约束变量不被继承值覆盖。
      assert.equal(env.GIT_OPTIONAL_LOCKS, "0");
      assert.equal(env.GIT_PAGER, "cat");
      assert.equal(env.PAGER, "cat");
      assert.equal(env.TERM, "dumb");
      assert.equal(env.LC_ALL, "C");
      assert.equal(env.LANG, "C");
    } finally {
      restoreEnv();
    }
  });

  test("config 层矩阵经 GIT_CONFIG_* 注入，继承编号键先删后写（R1/R5）", () => {
    polluteEnv();
    try {
      const env = getGitCommandEnv();
      const entries = getGitHardenedConfigEntries();
      assert.equal(env.GIT_CONFIG_COUNT, String(entries.length));
      entries.forEach(([key, value], index) => {
        assert.equal(env[`GIT_CONFIG_KEY_${index}`], key);
        assert.equal(env[`GIT_CONFIG_VALUE_${index}`], value);
      });
      // 污染的 safe.directory 注入被矩阵第 0 键覆盖，而非并存。
      assert.equal(env.GIT_CONFIG_KEY_0, entries[0]![0]);
      assert.notEqual(env.GIT_CONFIG_KEY_0, "safe.directory");
      // 超出矩阵长度的残留编号键必须被删除（防夹带）。
      assert.equal(env.GIT_CONFIG_KEY_99, undefined);
      assert.equal(env.GIT_CONFIG_VALUE_99, undefined);
    } finally {
      restoreEnv();
    }
  });

  test("矩阵键闭集与关键值（R2 表一致性，防漂移）", () => {
    const entries = getGitHardenedConfigEntries("linux");
    assert.deepEqual(
      entries.map(([key]) => key),
      EXPECTED_CONFIG_KEYS,
    );
    const asMap = new Map(entries);
    assert.equal(asMap.get("core.hooksPath"), "/dev/null");
    assert.equal(asMap.get("core.fsmonitor"), "");
    assert.equal(asMap.get("core.askPass"), "");
    assert.equal(asMap.get("core.excludesFile"), "");
    assert.equal(asMap.get("core.attributesFile"), "");
    assert.equal(asMap.get("gc.auto"), "0");
    assert.equal(asMap.get("maintenance.auto"), "false");
    assert.equal(asMap.get("core.commitGraph"), "false");
    assert.equal(asMap.get("gc.writeCommitGraph"), "false");
    assert.equal(asMap.get("log.showSignature"), "false");
    assert.equal(asMap.get("core.logAllRefUpdates"), "false");
    assert.equal(asMap.get("submodule.recurse"), "false");
    assert.equal(asMap.get("filter.lfs.required"), "false");
    // LFS clean/smudge/process 有意不清空（会写坏 LFS 仓库 switch/commit 语义）。
    assert.equal(asMap.has("filter.lfs.clean"), false);
    assert.equal(asMap.has("filter.lfs.smudge"), false);
    assert.equal(asMap.has("filter.lfs.process"), false);
    // credential.helper 有意不清空（显式 push 的 https 认证依赖静默取凭据）。
    assert.equal(asMap.has("credential.helper"), false);
  });

  test("hooksPath 空设备双平台分支（R2）", () => {
    assert.equal(getGitHooksNullDevicePath("win32"), "\\\\.\\NUL");
    assert.equal(getGitHooksNullDevicePath("linux"), "/dev/null");
    assert.equal(getGitHooksNullDevicePath("darwin"), "/dev/null");
    assert.equal(new Map(getGitHardenedConfigEntries("win32")).get("core.hooksPath"), "\\\\.\\NUL");
  });
});

// ---- 功能段：真实 git 临时 repo fixture（git 不可用则 skip）----

const gitProbe = spawnSync("git", ["--version"], { stdio: "ignore" });
const gitAvailable = gitProbe.status === 0;

describe(
  "git invocation hardening functional (temp repo)",
  { skip: gitAvailable ? false : "git binary not available" },
  () => {
    let repoRoot: string;

    before(async () => {
      repoRoot = await mkdtemp(join(tmpdir(), "acode-git-hardening-"));
      const run = (args: string[], env?: NodeJS.ProcessEnv) =>
        spawnSync("git", args, { cwd: repoRoot, env: env ?? process.env, encoding: "utf8" });
      assert.equal(run(["init", "-q", "."]).status, 0);
      run(["config", "user.email", "hardening@test.local"]);
      run(["config", "user.name", "hardening-test"]);
      // 仓库自带 pre-commit hook：硬化 env 下不得执行（写不出 hook-proof）。
      const hooksDir = join(repoRoot, ".git", "hooks");
      await writeFile(
        join(hooksDir, "pre-commit"),
        "#!/bin/sh\necho HOOK_RAN > hook-proof.txt\nexit 0\n",
        { mode: 0o755 },
      );
      await writeFile(join(repoRoot, "a.txt"), "a\n");
      run(["add", "a.txt"]);
    });

    after(async () => {
      if (repoRoot) {
        await rm(repoRoot, { recursive: true, force: true, maxRetries: 5 });
      }
    });

    test("硬化 env 下只读命令正常、config 注入生效", () => {
      const env = getGitCommandEnv();
      const status = spawnSync("git", ["status", "--porcelain"], {
        cwd: repoRoot,
        env,
        encoding: "utf8",
      });
      assert.equal(status.status, 0, status.stderr);
      const hooksPath = spawnSync("git", ["config", "--get", "core.hooksPath"], {
        cwd: repoRoot,
        env,
        encoding: "utf8",
      });
      assert.equal(hooksPath.status, 0);
      assert.equal(hooksPath.stdout.trim(), getGitHooksNullDevicePath());
      const gcAuto = spawnSync("git", ["config", "--get", "gc.auto"], {
        cwd: repoRoot,
        env,
        encoding: "utf8",
      });
      assert.equal(gcAuto.stdout.trim(), "0");
    });

    test("硬化 env 下 commit 成功且仓库 hooks 不执行；对照组 hooks 执行", async () => {
      const hardened = getGitCommandEnv();
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
      await writeFile(join(repoRoot, "b.txt"), "b\n");
      spawnSync("git", ["add", "b.txt"], { cwd: repoRoot, encoding: "utf8" });
      const control = spawnSync("git", ["commit", "-q", "-m", "control"], {
        cwd: repoRoot,
        env: process.env,
        encoding: "utf8",
      });
      assert.equal(control.status, 0, control.stderr);
      assert.equal(existsSync(hookProofPath), true);
    });

    test("GIT_TERMINAL_PROMPT=0：凭据类交互立即失败而非挂起", () => {
      // 无网络依赖的功能性近似：ls-remote 指向不存在协议的本地路径，
      // 硬化 env 下命令必须快速非零退出（不等待 stdin）。
      const env = getGitCommandEnv();
      const startedAt = Date.now();
      const result = spawnSync("git", ["ls-remote", "ext::sh -c echo%20HACKED"], {
        cwd: repoRoot,
        env,
        encoding: "utf8",
        timeout: 20_000,
      });
      const elapsed = Date.now() - startedAt;
      assert.notEqual(result.status, 0, "ext:: 传输应被 GIT_ALLOW_PROTOCOL 拒绝");
      assert.ok(!result.stderr.includes("HACKED"), "ext remote-helper 不得被执行");
      assert.ok(elapsed < 20_000, "不得挂起等待输入");
    });
  },
);
