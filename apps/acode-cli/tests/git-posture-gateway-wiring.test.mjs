import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

/**
 * git posture 网关孪生侧接线验收（apps/acode-cli/specs/git-invocation-hardening.md R6
 * 闭合表）：8 消费点逐点接线断言——stub 执行入口捕获 argv（core/cli-workflow/cli），
 * 真实 git 功能实证（adapters git-snapshot / marketplace clone，git 不可用则 skip）。
 *
 * 判定的纯函数面（10 档闭集、clone 形状正反例、read 增补）在
 * packages/shared/test/gitPostureGateway.test.ts；本文件只钉「消费点声明了档位、
 * argv 过了网关」这层接线事实。
 */

const { withSessionGitPosture } =
  await import("../packages/core/src/worktree/session-worktree-git.ts");
const { createSessionWorktreeManager } =
  await import("../packages/core/src/worktree/session-worktree-manager.ts");
const { withHostGitPosture, mergeBaseBranchIntoSessionBranch } =
  await import("../packages/core/src/worktree/base-branch-merge.ts");
const { WorkflowWorktreeManager } =
  await import("../packages/cli-workflow/src/workflow-worktree-manager.ts");
const { executeWorldRead } = await import("../packages/cli-workflow/src/workflow-world-read.ts");
const { resolveGitSnapshot } = await import("../packages/adapters/src/context/git-snapshot.ts");
const { addMarketplace } = await import("../packages/adapters/src/plugins/marketplace.ts");
const { createOvernightController } =
  await import("../packages/bootstrap/src/app/overnight-controller.ts");
const { resolveWorkspaceGitBranch } = await import("../packages/cli/src/tui-workspace-git.ts");

const SHA = "a".repeat(40);
const SHA2 = "b".repeat(40);

const tempDirs = [];
function tempDir(prefix) {
  const dir = mkdtempSync(join(realpathSync.native(tmpdir()), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { force: true, recursive: true });
  }
});

function gitAvailable() {
  return spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;
}

function assertPostureDenied(error, posture) {
  assert.match(String(error?.message ?? error), /EGITPOSTURE|is not permitted under the/u);
  if (posture) assert.match(String(error?.message ?? error), new RegExp(`"${posture}"`, "u"));
}

// ── 消费点 #3（core session-worktree-git）：read 包装注入确定性旗标 + fail-closed ──
test("session-worktree-git: withSessionGitPosture read 重写 status、拒写形状；worktree list/show-ref 放行", async () => {
  const calls = [];
  const stub = async (args, cwd) => {
    calls.push({ args: [...args], cwd });
    return { stdout: "", stderr: "" };
  };
  const read = withSessionGitPosture("read", stub);
  await read(["status", "--porcelain"], "/repo");
  assert.deepEqual(calls[0].args, ["status", "--ignore-submodules=dirty", "--porcelain"]);
  // R4-8 增补形状：worktree list 与 show-ref verify 形归 read（本消费点真实形状）。
  await read(["worktree", "list", "--porcelain"], "/repo");
  assert.deepEqual(calls[1].args, ["worktree", "list", "--porcelain"]);
  await read(["show-ref", "--verify", "--quiet", "refs/heads/main"], "/repo");
  assert.deepEqual(calls[2].args, ["show-ref", "--verify", "--quiet", "refs/heads/main"]);
  await assert.rejects(
    () => read(["add", "-A"], "/repo"),
    (error) => {
      assertPostureDenied(error, "read");
      return true;
    },
  );
  await assert.rejects(
    () => read(["config", "user.name"], "/repo"),
    (error) => {
      assertPostureDenied(error, "read");
      return true;
    },
  );
});

// ── 消费点 #3（core session-worktree-manager）：worktree add=infra --no-checkout + populate checkout 物化 ──
test("session-worktree-manager: createWorktree 的 argv 序列 = worktree add --no-checkout（infra）→ checkout（populate）", async () => {
  const calls = [];
  const stub = async (args, cwd) => {
    calls.push({ args: [...args], cwd });
    return { stdout: "", stderr: "" };
  };
  const tmpRoot = tempDir("acode-posture-sess-wt-");
  const manager = createSessionWorktreeManager({ git: stub, tmpRoot });
  const worktreePath = join(tmpRoot, "ns", "wt1");
  await manager.createWorktree({
    repoRoot: "/repo",
    path: worktreePath,
    branch: "acode/sess-x",
    startRef: SHA,
  });
  assert.equal(calls.length, 2, JSON.stringify(calls));
  assert.deepEqual(calls[0].args, [
    "worktree",
    "add",
    "--no-checkout",
    "-b",
    "acode/sess-x",
    worktreePath,
    SHA,
  ]);
  assert.equal(calls[0].cwd, "/repo");
  // populate 档重写注入 --quiet --no-recurse-submodules；cwd 落在 worktree（非 -C 前缀）。
  assert.deepEqual(calls[1].args, [
    "checkout",
    "--quiet",
    "--no-recurse-submodules",
    "acode/sess-x",
  ]);
  assert.equal(calls[1].cwd, worktreePath);
  // infra 档位置劫持守卫在包装层生效（stub 不可能收到的 argv 直接被拒）。
  const infra = withSessionGitPosture("infra", stub);
  await assert.rejects(
    () => infra(["worktree", "add", "/p", "b"], "/repo"),
    (error) => {
      assertPostureDenied(error, "infra");
      return true;
    },
  );
});

// ── 消费点 #6（core base-branch-merge）：merge 档两步形状 + read 前置检查 ──
test("base-branch-merge: merge 走 ff-only → no-ff --no-commit + commit 两步（merge 档），`merge --no-edit` 被拒", async () => {
  const calls = [];
  const stub = async (args, cwd) => {
    const key = args.join(" ");
    calls.push({ args: [...args], cwd });
    if (key === "rev-parse -q --verify MERGE_HEAD") {
      return { exitCode: 1, stdout: "", stderr: "" };
    }
    if (key === "status --ignore-submodules=dirty --porcelain") {
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "show-ref") {
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (key === `rev-parse --verify main^{commit}`) {
      return { exitCode: 0, stdout: `${SHA}\n`, stderr: "" };
    }
    if (key === `merge --ff-only --no-overwrite-ignore ${SHA}`) {
      return {
        exitCode: 128,
        stdout: "",
        stderr: "fatal: Not possible to fast-forward, aborting.",
      };
    }
    if (args[0] === "merge" && args.includes("--no-ff")) {
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "commit") {
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (key === "rev-parse HEAD") {
      return { exitCode: 0, stdout: `${SHA2}\n`, stderr: "" };
    }
    throw new Error(`unexpected git argv in stub: ${key}`);
  };
  const output = await mergeBaseBranchIntoSessionBranch(
    {
      action: "merge",
      base: "source_branch",
      worktreePath: "/wt",
      sessionBranch: "acode/sess-x",
      sourceBranch: "main",
    },
    { git: stub },
  );
  assert.equal(output.outcome, "merged", JSON.stringify(output));
  assert.equal(output.merge_commit, SHA2);
  const keys = calls.map((call) => call.args.join(" "));
  assert.ok(keys.includes(`merge --ff-only --no-overwrite-ignore ${SHA}`), keys.join("\n"));
  assert.ok(
    keys.includes(
      `merge --no-ff --no-commit --no-overwrite-ignore -m Merge branch 'main' into acode/sess-x ${SHA}`,
    ),
    keys.join("\n"),
  );
  assert.ok(
    keys.includes(`commit -m Merge branch 'main' into acode/sess-x --quiet --no-verify`),
    keys.join("\n"),
  );
  // 单步 --no-edit 形状不落在 merge 档：fail-closed。
  const mergeGit = withHostGitPosture("merge", stub);
  await assert.rejects(
    () => mergeGit(["merge", "--no-edit", "main"], "/wt"),
    (error) => {
      assertPostureDenied(error, "merge");
      return true;
    },
  );
});

// ── 消费点 #4（cli-workflow workflow-worktree-manager）：ensure=infra+populate、release=read+infra ──
test("workflow-worktree-manager: ensure 的 add --no-checkout + populate checkout；release 的 status 读档重写、remove/branch -D 走 infra", async () => {
  const calls = [];
  const stub = async (args, cwd) => {
    calls.push({ args: [...args], cwd });
    if (args[0] === "rev-parse") return { stdout: `${SHA}\n`, stderr: "" };
    if (args[0] === "rev-list") return { stdout: "0\n", stderr: "" };
    return { stdout: "", stderr: "" };
  };
  const tmpRoot = tempDir("acode-posture-wf-wt-");
  const manager = new WorkflowWorktreeManager({ git: stub, tmpRoot });
  const repoDir = tempDir("acode-posture-wf-repo-");
  const handle = await manager.ensureWorktree({ repoDir, runId: "run1", activityId: "act1" });
  const addCall = calls.find((call) => call.args[0] === "worktree" && call.args[1] === "add");
  assert.ok(addCall, calls.map((call) => call.args.join(" ")).join("\n"));
  assert.ok(addCall.args.includes("--no-checkout"), addCall.args.join(" "));
  const checkoutCall = calls.find((call) => call.args[0] === "checkout");
  assert.ok(checkoutCall, "populate checkout 必须跟随 --no-checkout add");
  assert.deepEqual(checkoutCall.args.slice(0, 3), [
    "checkout",
    "--quiet",
    "--no-recurse-submodules",
  ]);
  assert.equal(checkoutCall.cwd, handle.path);
  calls.length = 0;
  const release = await manager.releaseWorktree(handle);
  assert.equal(release.reason, "clean-reclaimed", JSON.stringify(release));
  const statusCall = calls.find((call) => call.args[0] === "status");
  assert.deepEqual(statusCall.args, ["status", "--ignore-submodules=dirty", "--porcelain"]);
  assert.ok(
    calls.some((call) => call.args.join(" ") === `worktree remove ${handle.path}`),
    "worktree remove 必须走 infra 透传",
  );
  assert.ok(
    calls.some((call) => call.args.join(" ") === `branch -D ${handle.branch}`),
    "branch -D 必须走 infra 透传",
  );
});

// ── 消费点 #7（cli-workflow workflow-world-read）：runGit 统一 read 档重写 ──
test("workflow-world-read: git-log 经 executionPort 的 argv 被 read 档注入子模块确定性旗标", async () => {
  const requests = [];
  const deps = {
    cwd: "/ws",
    fileSystemPort: {},
    executionPort: {
      run: async (request) => {
        requests.push(request);
        return {
          status: "completed",
          exitCode: 0,
          stdout: { text: "", bytes: 0, truncated: false },
          stderr: { text: "", bytes: 0, truncated: false },
        };
      },
    },
  };
  await executeWorldRead(deps, "git-log", [2]);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].command.args, [
    "log",
    "--ignore-submodules=dirty",
    "--submodule=short",
    "-n2",
    "--pretty=format:%H%x00%s%x00%an%x00%aI",
  ]);
});

// ── 消费点 #1（adapters git-snapshot）：真实 git 全链路 read 接线（含 config --get 增补形） ──
test("git-snapshot: 真实 git 上 resolveGitSnapshot 全链路通过 read 档（status/log/config --get/symbolic-ref/show-ref）", async (t) => {
  if (!gitAvailable()) {
    t.skip("git not available");
    return;
  }
  const repo = tempDir("acode-posture-snap-");
  const git = (args) => execFileSync("git", args, { cwd: repo, encoding: "utf-8" });
  git(["init", "-b", "main"]);
  git(["config", "user.email", "posture@example.com"]);
  git(["config", "user.name", "posture-eval"]);
  writeFileSync(join(repo, "a.txt"), "hello\n", "utf-8");
  git(["add", "."]);
  git(["commit", "-m", "init"]);
  const snapshot = await resolveGitSnapshot(repo);
  assert.equal(snapshot.isGitRepository, true, JSON.stringify(snapshot));
  assert.equal(snapshot.gitBranch, "main");
  assert.equal(snapshot.gitUser, "posture-eval");
  assert.equal(snapshot.gitStatus, "clean");
  assert.equal(snapshot.recentCommits.length, 1);
});

// ── 消费点 #2（adapters marketplace）：clone argv 过 clone 档后抵达 spawn 入口 ──
test("marketplace: clone argv 通过 clone 档抵达二进制解析（stub 二进制缺席 → plugin_git_unavailable，而非 EGITPOSTURE）", async () => {
  // 负向控制接线证据：posture 拒绝会在 spawn 前以 EGITPOSTURE 冒泡；这里把
  // ACODE_GIT_BINARY 指向不存在路径——错误必须是「git 不可用」（证明 argv 已过
  // 网关进入执行面），而不是 EGITPOSTURE 或来源策略门拒绝。
  // github URL + sparsePaths 走 cloneMarketplaceSource 的 clone+sparse-checkout 链
  // （策略门要求 https/ssh 白名单 host，本地 file 源无法过门——正向形状断言在
  // packages/shared/test/gitPostureGateway.test.ts 的 marketplace clone 形状用例）。
  const storageRoot = tempDir("acode-posture-mkt-store-");
  const previousBinary = process.env.ACODE_GIT_BINARY;
  process.env.ACODE_GIT_BINARY = join(tempDir("acode-posture-no-git-"), "git");
  try {
    await assert.rejects(
      () =>
        addMarketplace({
          source: {
            source: "git",
            sparsePaths: [".claude-plugin"],
            url: "https://github.com/acode-posture/fixture.git",
          },
          storageRoot,
        }),
      (error) => {
        assert.equal(error?.diagnosticCode, "plugin_git_unavailable", JSON.stringify(error));
        return true;
      },
    );
  } finally {
    if (previousBinary === undefined) {
      delete process.env.ACODE_GIT_BINARY;
    } else {
      process.env.ACODE_GIT_BINARY = previousBinary;
    }
  }
});

// ── 消费点 #8（bootstrap overnight-controller）：collectGitStatus 的 status argv 经 read 档 ──
test("overnight-controller: collectGitStatus 经 executionPort 的 status argv 被 read 档重写", async () => {
  const requests = [];
  const workspace = tempDir("acode-posture-overnight-");
  const controller = createOvernightController({
    executionPort: {
      run: async (request) => {
        requests.push(request);
        return {
          status: "completed",
          exitCode: 0,
          stdout: { text: "## main\n", bytes: 8, truncated: false },
          stderr: { text: "", bytes: 0, truncated: false },
        };
      },
    },
    fileSystemPort: {
      writeTextFile: async () => ({}),
      stat: async () => {
        throw new Error("not found");
      },
      listDirectory: async () => {
        throw new Error("not found");
      },
    },
    runtime: {
      getSessionId: () => "sess_posture",
      getSessionModelSelection: () => undefined,
    },
    runtimeConfig: {},
    runtimeTaskRegistry: { register: () => undefined },
    sessionStore: {
      getSession: async () => undefined,
      messages: async () => [],
    },
    traceContext: { traceId: "trace-posture", spanId: "span-posture" },
    workingDirectory: workspace,
  });
  // start 会在 preflight 之后因父会话缺席而失败（{ok:false}），采集阶段的 git argv 已捕获。
  const result = await controller.start(60_000, { traceId: "trace-posture" });
  const gitRequest = requests.find((request) => request.command?.file === "git");
  assert.ok(gitRequest, `未捕获 git 请求（start=${JSON.stringify(result)}）`);
  assert.deepEqual(gitRequest.command.args, [
    "status",
    "--ignore-submodules=dirty",
    "--porcelain=v1",
    "--branch",
  ]);
});

// ── 消费点 #5（cli tui-workspace-git）：symbolic-ref read 档 + -C 消除为 cwd ──
test("tui-workspace-git: symbolic-ref 走 read 档原形（无 -C 前缀），目录定位经 cwd 字段", async () => {
  const calls = [];
  const branch = await resolveWorkspaceGitBranch({
    runCommand: async (file, args, options) => {
      calls.push({ file, args: [...args], options });
      return { exitCode: 0, stdout: "main\n" };
    },
    workspaceDirectory: "/ws",
  });
  assert.equal(branch, "main");
  assert.deepEqual(calls[0].args, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  assert.equal(calls[0].options.cwd, "/ws");
});
