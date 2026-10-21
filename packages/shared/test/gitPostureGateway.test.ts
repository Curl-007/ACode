import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  applyGitPostureGateway,
  DEFAULT_GIT_POSTURE,
  GIT_POSTURE_ERROR_CODE,
  GIT_POSTURES,
  GitPostureError,
  type GitPosture,
} from "../src/git-posture/index.js";

/**
 * posture 意图网关判定器全档正反例（specs/git-posture-gateway.md R1-R5，
 * 机制来源 index.chunk-CHbrg8it.js:76-687）。纯函数测试，无 git 依赖。
 */

const SHA = "a".repeat(40);
const SHA2 = "b".repeat(40);
const SHA64 = "c".repeat(64);
const ZERO_SHA = "0".repeat(40);

function denied(posture: GitPosture, args: string[]): GitPostureError {
  try {
    applyGitPostureGateway(posture, args);
  } catch (error) {
    assert.ok(error instanceof GitPostureError, `expected GitPostureError, got ${String(error)}`);
    assert.equal(error.code, GIT_POSTURE_ERROR_CODE);
    assert.equal(error.code, "EGITPOSTURE");
    assert.equal(error.posture, posture);
    assert.match(error.message, /is not permitted under the ".*" posture$/u);
    return error;
  }
  assert.fail(`expected posture denial: ${posture} ${args.join(" ")}`);
}

function allowed(posture: GitPosture, args: string[]): string[] {
  return applyGitPostureGateway(posture, args);
}

describe("git posture gateway: closed set and defaults (R1/R2)", () => {
  test("档位闭集恰为 spec R1 十值（clone 为 ACode 第 10 档）", () => {
    assert.deepEqual(
      [...GIT_POSTURES],
      [
        "read",
        "push",
        "pushProbe",
        "fetch",
        "scrub",
        "populate",
        "hydrate",
        "merge",
        "infra",
        "clone",
      ],
    );
  });

  test("缺省档位是 read（未声明拒绝写形状）", () => {
    assert.equal(DEFAULT_GIT_POSTURE, "read");
    denied("read", ["add", "-A"]);
    denied("read", ["commit", "-m", "x"]);
    denied("read", ["update-ref", "refs/heads/x", SHA]);
  });

  test("判定器纯函数：不改入参、输出为新数组", () => {
    const input = ["status", "--porcelain"];
    const frozen = [...input];
    const output = allowed("read", input);
    assert.deepEqual(input, frozen);
    assert.notEqual(output, input);
  });
});

describe("git posture gateway: read posture (R3 + R4-2 additions)", () => {
  test("W 集读命令通过；diff/log/show/status 注入子模块确定性旗标", () => {
    assert.deepEqual(allowed("read", ["diff", "--cached", "--numstat", "-z", "--"]), [
      "diff",
      "--ignore-submodules=dirty",
      "--submodule=short",
      "--cached",
      "--numstat",
      "-z",
      "--",
    ]);
    assert.deepEqual(allowed("read", ["status", "--porcelain=v2", "-z"]), [
      "status",
      "--ignore-submodules=dirty",
      "--porcelain=v2",
      "-z",
    ]);
    assert.deepEqual(allowed("read", ["log", "-1", "--format=%s", "HEAD"]), [
      "log",
      "--ignore-submodules=dirty",
      "--submodule=short",
      "-1",
      "--format=%s",
      "HEAD",
    ]);
    assert.deepEqual(allowed("read", ["show", `HEAD:file.txt`]), [
      "show",
      "--ignore-submodules=dirty",
      "--submodule=short",
      "HEAD:file.txt",
    ]);
  });

  test("透传形读命令：rev-parse/ls-files/for-each-ref/check-ignore/merge-base/ls-tree/rev-list/check-attr", () => {
    for (const args of [
      ["rev-parse", "--show-toplevel", "--git-common-dir"],
      ["rev-parse", "--verify", "HEAD"],
      ["ls-files", "--stage", "-z", "--", "a.txt"],
      ["for-each-ref", "refs/heads", "--format=%(refname:short)"],
      ["check-ignore", "--", "a.txt"],
      ["merge-base", "origin/main", "HEAD"],
      ["ls-tree", "-r", "-z", SHA, "--", "dir"],
      ["rev-list", "HEAD"],
      ["check-attr", "diff", "--", "a.txt"],
    ]) {
      assert.deepEqual(allowed("read", args), args, args.join(" "));
    }
  });

  test("-c 前缀与全局透传旗标被子命令扫描跳过", () => {
    assert.deepEqual(allowed("read", ["-c", "core.x=y", "--no-pager", "status", "-z"]), [
      "-c",
      "core.x=y",
      "--no-pager",
      "status",
      "--ignore-submodules=dirty",
      "-z",
    ]);
  });

  test("ACode 登记增补：remote 无参列表/get-url、config 只读形、check-ref-format --branch", () => {
    assert.deepEqual(allowed("read", ["remote"]), ["remote"]);
    assert.deepEqual(allowed("read", ["remote", "get-url", "origin"]), [
      "remote",
      "get-url",
      "origin",
    ]);
    assert.deepEqual(allowed("read", ["config", "--get", "branch.main.remote"]), [
      "config",
      "--get",
      "branch.main.remote",
    ]);
    assert.deepEqual(
      allowed("read", ["config", "--show-scope", "--show-origin", "--get", "user.name"]),
      ["config", "--show-scope", "--show-origin", "--get", "user.name"],
    );
    assert.deepEqual(allowed("read", ["check-ref-format", "--branch", "feature/x"]), [
      "check-ref-format",
      "--branch",
      "feature/x",
    ]);
  });

  test("branch 仅列表形；symbolic-ref 仅单位置参查询形", () => {
    assert.deepEqual(allowed("read", ["branch", "--list", "--all"]), ["branch", "--list", "--all"]);
    assert.deepEqual(allowed("read", ["branch", "--show-current"]), ["branch", "--show-current"]);
    denied("read", ["branch", "-d", "feature/x"]);
    denied("read", ["branch", "feature/x"]);
    assert.deepEqual(allowed("read", ["symbolic-ref", "HEAD"]), ["symbolic-ref", "HEAD"]);
    // 双位置参 = 写形（改 HEAD 指向），read 档拒绝。
    denied("read", ["symbolic-ref", "HEAD", "refs/heads/main"]);
  });

  test("cat-file/hash-object 精确形状", () => {
    assert.deepEqual(allowed("read", ["cat-file", "--batch-check"]), ["cat-file", "--batch-check"]);
    assert.deepEqual(allowed("read", ["cat-file", "commit", SHA]), ["cat-file", "commit", SHA]);
    assert.deepEqual(allowed("read", ["cat-file", "tree", SHA64]), ["cat-file", "tree", SHA64]);
    denied("read", ["cat-file", "-p", SHA]);
    assert.deepEqual(allowed("read", ["hash-object", "--no-filters", "a.txt"]), [
      "hash-object",
      "--no-filters",
      "a.txt",
    ]);
    denied("read", ["hash-object", "-w", "a.txt"]);
  });

  test("read 档拒绝一切写/网络形状", () => {
    denied("read", ["add", "--", "a.txt"]);
    denied("read", ["push", "origin", `refs/heads/a:refs/heads/a`]);
    denied("read", ["fetch", "origin"]);
    denied("read", ["ls-remote", "origin"]);
    denied("read", ["switch", "main"]);
    denied("read", ["restore", "--staged", "--", "a.txt"]);
    denied("read", ["reset", "--quiet", "HEAD"]);
    denied("read", ["read-tree", "HEAD"]);
    denied("read", ["update-index", "-q", "--refresh"]);
    denied("read", ["clean", "-fd"]);
    denied("read", ["worktree", "add", "--no-checkout", "x"]);
    denied("read", []);
    // config 写形拒绝。
    denied("read", ["config", "user.name", "evil"]);
    denied("read", ["config", "--unset", "user.name"]);
    denied("read", ["config", "-f", ".git/config", "--get", "x"]);
    denied("read", ["config", "--get", "a", "b"]);
    denied("read", ["check-ref-format", "--print", "x"]);
    // remote 写形拒绝。
    denied("read", ["remote", "add", "origin", "url"]);
  });

  test("read 档子模块旗标约束（仅 dirty/all 与 submodule=short）", () => {
    denied("read", ["diff", "--ignore-submodules=none"]);
    denied("read", ["status", "--submodule=log"]);
    assert.deepEqual(allowed("read", ["diff", "--ignore-submodules=dirty"]), [
      "diff",
      "--ignore-submodules=dirty",
      "--submodule=short",
      "--ignore-submodules=dirty",
    ]);
  });
});

describe("git posture gateway: recurse-submodules guard (all postures)", () => {
  test("be 集子命令拒绝 --recurse-submodules 系（缩写捕获），放行 no 形", () => {
    denied("read", ["ls-files", "--recurse-submodules"]);
    denied("read", ["ls-files", "--recurse"]);
    assert.deepEqual(allowed("read", ["ls-files", "--no-recurse-submodules"]), [
      "ls-files",
      "--no-recurse-submodules",
    ]);
    assert.deepEqual(allowed("read", ["ls-files", "--recurse-submodules=no"]), [
      "ls-files",
      "--recurse-submodules=no",
    ]);
    denied("populate", ["checkout", "--recurse-submodules", "main"]);
  });
});

describe("git posture gateway: push posture (R3/R4-1 concrete refspec)", () => {
  test("具体 refspec 通过并追加防御旗标", () => {
    assert.deepEqual(allowed("push", ["push", "origin", `refs/heads/a:refs/heads/a`]), [
      "push",
      "--no-recurse-submodules",
      "--no-follow-tags",
      "origin",
      `refs/heads/a:refs/heads/a`,
    ]);
    assert.deepEqual(
      allowed("push", ["push", "--set-upstream", "origin", `refs/heads/a:refs/heads/a`]),
      [
        "push",
        "--no-recurse-submodules",
        "--no-follow-tags",
        "--set-upstream",
        "origin",
        `refs/heads/a:refs/heads/a`,
      ],
    );
    // + 强制前缀与非 heads 命名空间目标合法。
    assert.deepEqual(allowed("push", ["push", "origin", `+refs/heads/a:refs/heads/b`]).length, 5);
    assert.deepEqual(allowed("push", ["push", "origin", `refs/tags/v1:refs/tags/v1`]).length, 5);
  });

  test("pushProbe 与 push 同形", () => {
    assert.deepEqual(allowed("pushProbe", ["push", "origin", `refs/heads/a:refs/heads/a`]), [
      "push",
      "--no-recurse-submodules",
      "--no-follow-tags",
      "origin",
      `refs/heads/a:refs/heads/a`,
    ]);
    denied("pushProbe", ["push"]);
  });

  test("裸 push / 隐式上游推断 / 放大形状全部拒绝", () => {
    const bare = denied("push", ["push"]);
    assert.match(bare.detail, /concrete refspec is required/);
    denied("push", ["push", "origin"]);
    denied("push", ["push", "origin", "main"]);
    denied("push", ["push", "origin", "main:main"]);
    denied("push", ["push", "--mirror", "origin"]);
    denied("push", ["push", "--all", "origin"]);
    denied("push", ["push", "--tags", "origin"]);
    denied("push", ["push", "--follow-tags", "origin", `refs/heads/a:refs/heads/a`]);
    denied("push", ["push", "--delete", "origin", "main"]);
    denied("push", ["push", "-f", "origin", `refs/heads/a:refs/heads/a`]);
    denied("push", ["push", "-u", "origin", `refs/heads/a:refs/heads/a`]);
    denied("push", ["push", "--receive-pack=evil", "origin", `refs/heads/a:refs/heads/a`]);
    denied("push", ["push", "origin", `refs/heads/a:refs/heads/HEAD`]);
    denied("push", ["push", "-"]);
    // 缩写捕获：--mir 命中 mirror。
    denied("push", ["push", "--mir", "origin"]);
    // 非 push 子命令。
    denied("push", ["fetch", "origin"]);
    // `--` 形态：其后必须 ≥2 且首 token 非旗标；`--` 前不得有位置参。
    denied("push", ["push", "origin", "--", `refs/heads/a:refs/heads/a`]);
    assert.deepEqual(
      allowed("push", ["push", "--", "origin", `refs/heads/a:refs/heads/a`]).length,
      6,
    );
  });
});

describe("git posture gateway: fetch posture (R3 weaponization pins)", () => {
  test("重建 argv：六个 -c 钉死键 + 归一防御旗标 + 保留合法旗标", () => {
    assert.deepEqual(
      allowed("fetch", [
        "fetch",
        "--no-tags",
        "origin",
        `refs/heads/main:refs/remotes/origin/main`,
      ]),
      [
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
        `refs/heads/main:refs/remotes/origin/main`,
      ],
    );
    // 无 refspec 的 fetch <remote> 合法（refspec 可选），武器化键仍被钉死。
    const rebuilt = allowed("fetch", ["fetch", "origin"]);
    assert.deepEqual(rebuilt.slice(0, 13), [
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
    ]);
    // 前缀（-c/全局旗标）保留在重建 argv 头部。
    const withPrefix = allowed("fetch", ["-c", "core.x=y", "fetch", "origin"]);
    assert.deepEqual(withPrefix.slice(0, 4), ["-c", "core.x=y", "-c", "fetch.prune=false"]);
  });

  test("恶意 .git/config 武器化旗标与 shallow 系拒绝（含缩写捕获）", () => {
    denied("fetch", ["fetch"]);
    denied("fetch", ["fetch", "--prune", "origin"]);
    denied("fetch", ["fetch", "--prune-tags", "origin"]);
    denied("fetch", ["fetch", "--mirror", "origin"]);
    denied("fetch", ["fetch", "--all"]);
    denied("fetch", ["fetch", "--multiple", "a", "b"]);
    denied("fetch", ["fetch", "--refmap=evil", "origin"]);
    denied("fetch", ["fetch", "--upload-pack=evil", "origin"]);
    denied("fetch", ["fetch", "--depth=1", "origin"]);
    denied("fetch", ["fetch", "--dep=1", "origin"]);
    denied("fetch", ["fetch", "--unshallow", "origin"]);
    denied("fetch", ["fetch", "--refetch", "origin"]);
    denied("fetch", ["fetch", "-p", "origin"]);
    denied("fetch", ["fetch", "origin", "--", "x"]);
  });

  test("refspec 目标必须落 refs/remotes/<remote>/，拒 HEAD 劫持", () => {
    denied("fetch", ["fetch", "origin", `refs/heads/a:refs/heads/b`]);
    denied("fetch", ["fetch", "origin", `refs/heads/a:refs/remotes/other/a`]);
    denied("fetch", ["fetch", "origin", `refs/heads/a:refs/remotes/origin/HEAD`]);
    denied("fetch", ["fetch", "origin", "main"]);
    assert.deepEqual(
      allowed("fetch", ["fetch", "origin", `+refs/heads/a:refs/remotes/origin/a`]).length,
      18,
    );
  });

  test("ls-remote 透传；upload-pack/exec 与短旗标拒绝", () => {
    assert.deepEqual(allowed("fetch", ["ls-remote", "origin"]), ["ls-remote", "origin"]);
    assert.deepEqual(allowed("fetch", ["ls-remote", "--heads", "origin"]), [
      "ls-remote",
      "--heads",
      "origin",
    ]);
    denied("fetch", ["ls-remote", "--upload-pack=evil", "origin"]);
    denied("fetch", ["ls-remote", "-h", "origin"]);
    // fetch 档非 fetch/ls-remote 子命令拒绝。
    denied("fetch", ["pull", "origin"]);
  });
});

describe("git posture gateway: infra posture (R3 hijack guard)", () => {
  test("普通 argv 透传（不重写）", () => {
    const args = ["commit", "-m", "message", "--", "a.txt"];
    assert.deepEqual(allowed("infra", args), args);
    assert.deepEqual(allowed("infra", ["add", "-A", "--", "."]), ["add", "-A", "--", "."]);
    // rev-parse 的 --git-dir 旗标（非子命令位）不受守卫影响。
    assert.deepEqual(allowed("infra", ["rev-parse", "--git-dir"]), ["rev-parse", "--git-dir"]);
  });

  test("子命令位 -C/--git-dir/--work-tree/--namespace/--super-prefix（含 = 形）拒绝", () => {
    for (const flag of ["-C", "--git-dir", "--work-tree", "--namespace", "--super-prefix"]) {
      denied("infra", [flag, "/tmp/evil", "status"]);
      denied("infra", [`${flag}=/tmp/evil`, "status"]);
    }
    // -c 前缀后的劫持旗标同样命中（子命令扫描跳过 -c 对）。
    denied("infra", ["-c", "core.x=y", "-C", "/tmp/evil", "status"]);
  });

  test("worktree add 必须含 --no-checkout", () => {
    denied("infra", ["worktree", "add", "/tmp/wt", "main"]);
    assert.deepEqual(allowed("infra", ["worktree", "add", "--no-checkout", "/tmp/wt", "main"]), [
      "worktree",
      "add",
      "--no-checkout",
      "/tmp/wt",
      "main",
    ]);
  });
});

describe("git posture gateway: populate posture", () => {
  test("checkout 旗标子集通过并注入 --quiet --no-recurse-submodules", () => {
    assert.deepEqual(allowed("populate", ["checkout", "main"]), [
      "checkout",
      "--quiet",
      "--no-recurse-submodules",
      "main",
    ]);
    assert.deepEqual(allowed("populate", ["checkout", "-B", "x", "main"]).length, 6);
    denied("populate", ["checkout", "--merge", "main"]);
    denied("populate", ["checkout"]);
  });

  test("read-tree 仅单 token；--empty/多参拒绝", () => {
    assert.deepEqual(allowed("populate", ["read-tree", "HEAD"]), ["read-tree", "HEAD"]);
    denied("populate", ["read-tree", "--empty"]);
    denied("populate", ["read-tree", SHA, SHA2]);
    denied("populate", ["add", "-A"]);
  });
});

describe("git posture gateway: scrub posture", () => {
  test("clean 透传；maintenance run --task 精确形", () => {
    assert.deepEqual(allowed("scrub", ["clean", "-fdx"]), ["clean", "-fdx"]);
    assert.deepEqual(allowed("scrub", ["maintenance", "run", "--task=loose-objects"]), [
      "maintenance",
      "run",
      "--task=loose-objects",
    ]);
    denied("scrub", ["maintenance", "run"]);
    denied("scrub", ["maintenance", "run", "--task=gc"]);
  });

  test("read-tree 重置形注入 --no-recurse-submodules", () => {
    assert.deepEqual(allowed("scrub", ["read-tree", "--reset", "-u", SHA]), [
      "read-tree",
      "--no-recurse-submodules",
      "--reset",
      "-u",
      SHA,
    ]);
    assert.deepEqual(
      allowed("scrub", ["read-tree", "-m", "-u", SHA, SHA2]).includes("--no-recurse-submodules"),
      true,
    );
    denied("scrub", ["read-tree", "--reset", "-u", ZERO_SHA]);
    denied("scrub", ["read-tree", "HEAD"]);
  });

  test("update-ref：heads/remotes/stash/bisect 形通过并强制 --no-deref；越界 ref 拒绝", () => {
    assert.deepEqual(allowed("scrub", ["update-ref", `refs/heads/x`, SHA, SHA2]), [
      "update-ref",
      "--no-deref",
      `refs/heads/x`,
      SHA,
      SHA2,
    ]);
    assert.deepEqual(allowed("scrub", ["update-ref", "--no-deref", "-d", `refs/heads/x`, SHA]), [
      "update-ref",
      "--no-deref",
      "-d",
      `refs/heads/x`,
      SHA,
    ]);
    assert.deepEqual(allowed("scrub", ["update-ref", "-d", `refs/bisect/bad`]).length, 4);
    assert.deepEqual(allowed("scrub", ["update-ref", `refs/remotes/o/main`, SHA]).length, 4);
    assert.deepEqual(
      allowed("scrub", ["update-ref", "--create-reflog", "-m", "stash entry", "refs/stash", SHA]),
      ["update-ref", "--no-deref", "--create-reflog", "-m", "stash entry", "refs/stash", SHA],
    );
    // 越界命名空间 / 非 sha / 全零 sha / -m 消息含控制字符。
    denied("scrub", ["update-ref", "refs/acode/x", SHA]);
    denied("scrub", ["update-ref", "refs/heads/x", "notasha"]);
    denied("scrub", ["update-ref", "refs/heads/x", ZERO_SHA, SHA2]);
    denied("scrub", ["update-ref", "-m", "a\u0000b", "refs/heads/x", SHA, SHA2]);
    denied("scrub", ["update-ref", "--deref", "refs/heads/x", SHA, SHA2]);
  });

  test("symbolic-ref：HEAD→分支 / remote HEAD 指向形；非法 ref 拒绝", () => {
    assert.deepEqual(allowed("scrub", ["symbolic-ref", "HEAD", "refs/heads/main"]), [
      "symbolic-ref",
      "HEAD",
      "refs/heads/main",
    ]);
    assert.deepEqual(
      allowed("scrub", ["symbolic-ref", "refs/remotes/o/HEAD", "refs/remotes/o/main"]),
      ["symbolic-ref", "refs/remotes/o/HEAD", "refs/remotes/o/main"],
    );
    denied("scrub", ["symbolic-ref", "HEAD", "main"]);
    denied("scrub", ["symbolic-ref", "HEAD", "refs/heads/..x"]);
    denied("scrub", ["symbolic-ref", "refs/remotes/o/HEAD", "refs/remotes/o/HEAD"]);
    denied("scrub", ["symbolic-ref", "refs/remotes/o/HEAD", "refs/remotes/other/main"]);
    denied("scrub", ["symbolic-ref", "refs/remotes/o/HEAD", "refs/remotes/o/x.lock"]);
  });

  test("update-index 仅两个精确形；面板写形拒绝", () => {
    assert.deepEqual(allowed("scrub", ["update-index", "-q", "--ignore-submodules", "--refresh"]), [
      "update-index",
      "-q",
      "--ignore-submodules",
      "--refresh",
    ]);
    assert.deepEqual(allowed("scrub", ["update-index", "--skip-worktree", "-z", "--stdin"]), [
      "update-index",
      "--skip-worktree",
      "-z",
      "--stdin",
    ]);
    denied("scrub", ["update-index", "--force-remove", "--", "a.txt"]);
    denied("scrub", ["update-index", "--add", "--cacheinfo", "100644", SHA, "a.txt"]);
    denied("scrub", ["commit", "-m", "x"]);
  });
});

describe("git posture gateway: hydrate posture", () => {
  test("update-index -q --refresh / lfs checkout / lfs ls-files 白名单形", () => {
    assert.deepEqual(allowed("hydrate", ["update-index", "-q", "--refresh"]), [
      "update-index",
      "-q",
      "--refresh",
    ]);
    assert.deepEqual(allowed("hydrate", ["lfs", "checkout"]), ["lfs", "checkout"]);
    assert.deepEqual(allowed("hydrate", ["lfs", "checkout", "--", "a.txt"]), [
      "lfs",
      "checkout",
      "--",
      "a.txt",
    ]);
    assert.deepEqual(allowed("hydrate", ["lfs", "ls-files", "--json"]), [
      "lfs",
      "ls-files",
      "--json",
    ]);
    denied("hydrate", ["lfs", "checkout", "--all"]);
    denied("hydrate", ["lfs", "ls-files", "--all"]);
    denied("hydrate", ["lfs", "pull"]);
    denied("hydrate", ["update-index", "-q"]);
    denied("hydrate", ["status"]);
  });
});

describe("git posture gateway: merge posture", () => {
  test("merge --abort / ff-only sha / no-ff -m sha 形", () => {
    assert.deepEqual(allowed("merge", ["merge", "--abort"]), ["merge", "--abort"]);
    assert.deepEqual(allowed("merge", ["merge", "--ff-only", "--no-overwrite-ignore", SHA]), [
      "merge",
      "--ff-only",
      "--no-overwrite-ignore",
      SHA,
    ]);
    assert.deepEqual(
      allowed("merge", [
        "merge",
        "--no-ff",
        "--no-commit",
        "--no-overwrite-ignore",
        "--quiet",
        "-m",
        "msg",
        SHA64,
      ]).length,
      8,
    );
    denied("merge", ["merge", SHA]);
    denied("merge", ["merge", "--ff-only", "--no-overwrite-ignore", "notasha"]);
    denied("merge", ["merge", "--ff-only", "--no-overwrite-ignore", "--quiet", "--quiet", SHA]);
    denied("merge", ["merge", "feature/x"]);
  });

  test("checkout/rm 需 --literal-pathspecs 前缀 + sha + -- 分段", () => {
    assert.deepEqual(allowed("merge", ["--literal-pathspecs", "checkout", SHA, "--", "a.txt"]), [
      "--literal-pathspecs",
      "checkout",
      "--no-recurse-submodules",
      SHA,
      "--",
      "a.txt",
    ]);
    denied("merge", ["checkout", SHA, "--", "a.txt"]);
    denied("merge", ["--literal-pathspecs", "checkout", "main", "--", "a.txt"]);
    assert.deepEqual(
      allowed("merge", ["--literal-pathspecs", "rm", "--quiet", "--force", "--", "a.txt"]).length,
      6,
    );
    denied("merge", ["rm", "-rf", "a.txt"]);
  });

  test("commit 仅 -m + --quiet --no-verify 精确形", () => {
    assert.deepEqual(allowed("merge", ["commit", "-m", "msg", "--quiet", "--no-verify"]), [
      "commit",
      "-m",
      "msg",
      "--quiet",
      "--no-verify",
    ]);
    denied("merge", ["commit", "-m", "msg"]);
    denied("merge", ["commit", "-m", "msg", "--quiet", "--no-verify", "--", "a.txt"]);
    denied("merge", ["commit", "-m", "-x", "--quiet", "--no-verify"]);
  });
});

describe("git posture gateway: read posture ACode additions (R4-8: show-ref / worktree list)", () => {
  test("show-ref 仅 verify 存在性检查形", () => {
    assert.deepEqual(allowed("read", ["show-ref", "--verify", "--quiet", "refs/heads/main"]), [
      "show-ref",
      "--verify",
      "--quiet",
      "refs/heads/main",
    ]);
    assert.deepEqual(allowed("read", ["show-ref", "--verify", "-q", "refs/remotes/origin/main"]), [
      "show-ref",
      "--verify",
      "-q",
      "refs/remotes/origin/main",
    ]);
    denied("read", ["show-ref", "--heads"]);
    denied("read", ["show-ref", "--quiet", "refs/heads/main"]);
    denied("read", ["show-ref", "-d", "refs/heads/main"]);
    denied("read", ["show-ref", "--verify", "--", "refs/heads/main"]);
  });

  test("worktree 仅 list [--porcelain] 读形；写形不归 read", () => {
    assert.deepEqual(allowed("read", ["worktree", "list", "--porcelain"]), [
      "worktree",
      "list",
      "--porcelain",
    ]);
    assert.deepEqual(allowed("read", ["worktree", "list"]), ["worktree", "list"]);
    denied("read", ["worktree", "add", "--no-checkout", "/tmp/x", "b"]);
    denied("read", ["worktree", "remove", "/tmp/x"]);
    denied("read", ["worktree", "prune"]);
    denied("read", ["worktree", "list", "-z"]);
  });
});

describe("git posture gateway: clone posture (R3 clone 行/R4-9, 第 10 档)", () => {
  test("marketplace clone 形状：--depth/--branch 空格形、--filter=blob:none --sparse、url+dest", () => {
    assert.deepEqual(allowed("clone", ["clone", "--depth", "1", "https://x/y.git", "/tmp/d"]), [
      "clone",
      "--depth",
      "1",
      "https://x/y.git",
      "/tmp/d",
    ]);
    assert.deepEqual(
      allowed("clone", [
        "clone",
        "--depth",
        "1",
        "--branch",
        "main",
        "--filter=blob:none",
        "--sparse",
        "git@h:o/r.git",
        "/tmp/d",
      ]),
      [
        "clone",
        "--depth",
        "1",
        "--branch",
        "main",
        "--filter=blob:none",
        "--sparse",
        "git@h:o/r.git",
        "/tmp/d",
      ],
    );
  });

  test("放行形状：无旗标 url[+dest]、名值旗标 = 形、--filter 前缀闭集其余两形、--no-checkout 等精确旗标", () => {
    assert.deepEqual(allowed("clone", ["clone", "https://x/y.git"]), ["clone", "https://x/y.git"]);
    allowed("clone", [
      "clone",
      "--quiet",
      "-q",
      "--no-checkout",
      "--single-branch",
      "--no-tags",
      "u",
      "d",
    ]);
    allowed("clone", ["clone", "--origin=upstream", "--branch=dev", "--depth=2", "u"]);
    allowed("clone", ["clone", "--filter=blob:limit=1m", "u"]);
    allowed("clone", ["clone", "--filter=tree:0", "u"]);
  });

  test("执行/配置注入拒绝：--upload-pack、--exec（含缩写与 = 形）、-c、--config", () => {
    denied("clone", ["clone", "--upload-pack=x", "u"]);
    denied("clone", ["clone", "--upload-pack", "x", "u"]);
    denied("clone", ["clone", "--exec=sh", "u"]);
    denied("clone", ["clone", "--upl=x", "u"]);
    denied("clone", ["clone", "-c", "user.email=a@b", "u"]);
    denied("clone", ["-c", "user.email=a@b", "clone", "u"]);
    denied("clone", ["clone", "--config", "user.email=a@b", "u"]);
    denied("clone", ["clone", "--config=user.email=a@b", "u"]);
  });

  test("镜像/子模块扇出/shallow 复合面拒绝：--mirror（含缩写）、--recurse-submodules、--shallow-since/--shallow-exclude", () => {
    denied("clone", ["clone", "--mirror", "u"]);
    denied("clone", ["clone", "--mir", "u"]);
    denied("clone", ["clone", "--recurse-submodules", "u"]);
    denied("clone", ["clone", "--shallow-since=2026-01-01", "u"]);
    denied("clone", ["clone", "--shallow-exclude=refs/heads/x", "u"]);
  });

  test("值形状拒绝：--depth 非正整数/缺值、--branch 旗标值、未知旗标、-- 分隔、位置参超两个", () => {
    denied("clone", ["clone", "--depth", "0", "u"]);
    denied("clone", ["clone", "--depth", "-1", "u"]);
    denied("clone", ["clone", "--depth=abc", "u"]);
    denied("clone", ["clone", "--depth", "u"]);
    denied("clone", ["clone", "--branch", "--depth", "u"]);
    denied("clone", ["clone", "--verbose", "u"]);
    denied("clone", ["clone", "--", "u"]);
    denied("clone", ["clone", "u", "d", "extra"]);
  });

  test("非 clone 子命令在 clone 档拒绝；判定器通过时不重写 argv", () => {
    denied("clone", ["fetch", "origin"]);
    denied("clone", ["checkout", "u"]);
    const argv = ["clone", "--depth", "1", "u", "d"];
    assert.deepEqual(allowed("clone", argv), argv);
  });
});
