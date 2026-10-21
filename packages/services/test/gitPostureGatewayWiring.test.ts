import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { createGitCommandProvider } from "../src/git/providers/gitCommandProvider.js";
import type { GitEnvironmentProvider } from "../src/git/providers/gitEnvironmentProvider.js";
import { GitPostureError } from "../src/git/providers/gitPostureGateway.js";

/**
 * posture 网关接线集成测（specs/git-posture-gateway.md R2/R5，验收 1/8）：
 * 段一用 stub binary（node 自身）验证 provider 漏斗的网关语义，不依赖 git——
 * 缺省 read 拒写形状、拒绝先于 binary 解析、重写 argv 反映到 spawn 与 result.args；
 * 段二用真实 git 临时 repo 验证链路级行为（git 不可用则 skip，形态同
 * gitHardeningPresets.test.ts）。
 */

function expectPostureRejection(promise: Promise<unknown>): Promise<void> {
  return assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof GitPostureError, `expected GitPostureError, got ${String(error)}`);
    assert.equal(error.code, "EGITPOSTURE");
    return true;
  });
}

// ---- 段一：stub binary（node 自身），无 git 依赖 ----

describe("git posture gateway wiring (stub binary)", () => {
  const stubEnvironmentProvider: GitEnvironmentProvider = {
    async resolveGitBinary(): Promise<string | null> {
      return process.execPath;
    },
    createCommandEnv(): NodeJS.ProcessEnv {
      return { ...process.env };
    },
  };
  const provider = createGitCommandProvider({ environmentProvider: stubEnvironmentProvider });
  const cwd = tmpdir();

  test("未声明档位 = read：写形状在 spawn 前拒绝（EGITPOSTURE）", async () => {
    await expectPostureRejection(provider.run({ cwd, args: ["add", "-A"] }));
    await expectPostureRejection(provider.run({ cwd, args: ["commit", "-m", "x"] }));
    await expectPostureRejection(provider.run({ cwd, args: ["push", "origin"] }));
    await expectPostureRejection(
      provider.run({ cwd, args: ["update-ref", "refs/heads/x", "a".repeat(40)] }),
    );
  });

  test("拒绝先于 binary 解析：binary 不可用时写形状仍报 EGITPOSTURE 而非 binary 错误", async () => {
    const unavailableProvider = createGitCommandProvider({
      environmentProvider: {
        async resolveGitBinary(): Promise<string | null> {
          return null;
        },
        createCommandEnv(): NodeJS.ProcessEnv {
          return {};
        },
      },
    });
    await expectPostureRejection(unavailableProvider.run({ cwd, args: ["add", "-A"] }));
    await assert.rejects(
      unavailableProvider.run({ cwd, args: ["rev-parse", "HEAD"] }),
      /Git binary is not available/u,
    );
  });

  test("infra 档透传 spawn：argv 原样执行、result.args 不变", async () => {
    const result = await provider.run({
      cwd,
      args: ["-e", "process.exit(0)"],
      posture: "infra",
    });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(result.args, ["-e", "process.exit(0)"]);
  });

  test("read 档重写反映到 result.args（status 注入 --ignore-submodules=dirty）", async () => {
    const result = await provider.run({ cwd, args: ["status", "--porcelain"], posture: "read" });
    // stub binary（node）不认识这些参数，必然非零退出；这里只验证网关重写进入了 spawn argv。
    assert.notEqual(result.exitCode, 0);
    assert.deepEqual(result.args, ["status", "--ignore-submodules=dirty", "--porcelain"]);
  });

  test("fetch 档重建 argv 反映到 result.args（六个 -c 钉死键）", async () => {
    const result = await provider.run({ cwd, args: ["fetch", "origin"], posture: "fetch" });
    assert.notEqual(result.exitCode, 0);
    assert.deepEqual(result.args, [
      "-c",
      "fetch.prune=false",
      "-c",
      "remote.origin.prune=false",
      "-c",
      "fetch.pruneTags=false",
      "-c",
      "remote.origin.pruneTags=false",
      "-c",
      "remote.origin.mirror=false",
      "-c",
      "remote.origin.followRemoteHEAD=never",
      "fetch",
      "--no-recurse-submodules",
      "--no-tags",
      "--refmap=",
      "origin",
    ]);
  });

  test("显式 push 档也拒裸 push / 无冒号 refspec（R4-1 形状纪律）", async () => {
    await expectPostureRejection(provider.run({ cwd, args: ["push"], posture: "push" }));
    await expectPostureRejection(
      provider.run({ cwd, args: ["push", "origin", "main"], posture: "push" }),
    );
  });
});

// ---- 段二：真实 git 临时 repo（git 不可用则 skip）----

const gitProbe = spawnSync("git", ["--version"], { stdio: "ignore" });
const gitAvailable = gitProbe.status === 0;

describe(
  "git posture gateway wiring (real git, temp repo)",
  { skip: gitAvailable ? false : "git binary not available" },
  () => {
    let root: string;
    let repo: string;
    let originBare: string;
    const provider = createGitCommandProvider();

    function plain(args: string[], cwd: string): ReturnType<typeof spawnSync> {
      return spawnSync("git", args, { cwd, env: process.env, encoding: "utf8" });
    }

    before(async () => {
      root = await mkdtemp(join(tmpdir(), "acode-posture-wiring-"));
      repo = join(root, "repo");
      originBare = join(root, "origin.git");
      assert.equal(plain(["init", "-q", "-b", "main", repo], root).status, 0);
      plain(["config", "user.email", "posture@test.local"], repo);
      plain(["config", "user.name", "posture-test"], repo);
      await writeFile(join(repo, "a.txt"), "a\n");
      assert.equal(plain(["add", "a.txt"], repo).status, 0);
      assert.equal(plain(["commit", "-q", "-m", "seed"], repo).status, 0);
      assert.equal(plain(["init", "-q", "--bare", originBare], root).status, 0);
      // push 链路用例需要显式 remote（push 档强制 `push <remote> <refspec>` 形状）。
      assert.equal(plain(["remote", "add", "origin", originBare], repo).status, 0);
    });

    after(async () => {
      if (root) {
        await rm(root, { recursive: true, force: true, maxRetries: 5 });
      }
    });

    test("缺省 read 档：status 成功且注入旗标，add 被拒且零副作用", async () => {
      const status = await provider.run({ cwd: repo, args: ["status", "--porcelain=v2", "-z"] });
      assert.equal(status.exitCode, 0, status.stderr);
      assert.deepEqual(status.args, [
        "status",
        "--ignore-submodules=dirty",
        "--porcelain=v2",
        "-z",
      ]);

      await writeFile(join(repo, "b.txt"), "b\n");
      await expectPostureRejection(provider.run({ cwd: repo, args: ["add", "--", "b.txt"] }));
      // fail-closed 零副作用：b.txt 未被暂存。
      const staged = plain(["diff", "--cached", "--name-only"], repo);
      assert.equal(staged.stdout.trim(), "");
    });

    test("infra 档：add/commit 写链路放行（Git 面板宿主档位）", async () => {
      const add = await provider.run({ cwd: repo, args: ["add", "--", "b.txt"], posture: "infra" });
      assert.equal(add.exitCode, 0, add.stderr);
      const commit = await provider.run({
        cwd: repo,
        args: ["commit", "-m", "panel write"],
        posture: "infra",
      });
      assert.equal(commit.exitCode, 0, commit.stderr);
      const subject = plain(["log", "-1", "--format=%s"], repo).stdout.trim();
      assert.equal(subject, "panel write");
    });

    test("infra 档仍拒位置劫持：-C/--git-dir 子命令位", async () => {
      await expectPostureRejection(
        provider.run({ cwd: repo, args: ["-C", originBare, "status"], posture: "infra" }),
      );
      await expectPostureRejection(
        provider.run({ cwd: repo, args: [`--git-dir=${originBare}`, "status"], posture: "infra" }),
      );
    });

    test("push 档：具体 refspec + E1 协议放行成功；裸 push 网关拒绝", async () => {
      await expectPostureRejection(
        provider.run({ cwd: repo, args: ["push", "origin"], posture: "push" }),
      );

      const push = await provider.run({
        cwd: repo,
        args: ["push", "origin", "refs/heads/main:refs/heads/main"],
        posture: "push",
        envOptions: { allowedProtocols: ["file"] },
        timeoutMs: 60_000,
      });
      assert.equal(push.exitCode, 0, push.stderr);
      // 网关追加的防御旗标进入了实际 argv。
      assert.ok(push.args.includes("--no-recurse-submodules"));
      assert.ok(push.args.includes("--no-follow-tags"));
      const remoteHead = plain(["rev-parse", "main"], originBare).stdout.trim();
      const localHead = plain(["rev-parse", "HEAD"], repo).stdout.trim();
      assert.equal(remoteHead, localHead);
    });
  },
);
