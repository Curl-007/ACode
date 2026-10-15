import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

/**
 * base 合并验收（apps/acode-cli/specs/session-worktree-lifecycle.md 场景 4）：
 * 宿主执行层（注入 ExecutionPort 捕获 argv/sandbox 形态并真跑 git）、base 闭集、
 * dirty 即拒、冲突保留现场 + abort 语义、不 push 不删除。
 */

const { enterSessionWorktree } = await import(
  "../packages/core/src/worktree/session-worktree-enter.ts"
);
const { createSessionWorktreeManager } = await import(
  "../packages/core/src/worktree/session-worktree-manager.ts"
);
const { SessionWorktreeLedger } = await import(
  "../packages/core/src/worktree/session-worktree-ledger.ts"
);
const { resetSessionWorktreeFenceForTest } = await import(
  "../packages/core/src/worktree/session-worktree-fence.ts"
);
const { createMergeBaseBranchToolEntry } = await import(
  "../packages/core/src/tool/handlers/merge-base-branch.ts"
);

const tempDirs = [];
function tempDir(prefix) {
  const dir = mkdtempSync(join(realpathSync.native(tmpdir()), prefix));
  tempDirs.push(dir);
  return dir;
}

function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function createRealRepo() {
  const dir = tempDir("acode-swtm-repo-");
  git(["init", "-b", "main"], dir);
  git(["config", "user.email", "swt-eval@example.com"], dir);
  git(["config", "user.name", "swt-eval"], dir);
  writeFileSync(join(dir, "README.md"), "# shared repo\n", "utf-8");
  git(["add", "."], dir);
  git(["commit", "-m", "init"], dir);
  return dir;
}

/** 宿主执行层替身：捕获请求形态并真跑 git（合并语义必须过真实 git 才算数）。 */
function createHostExecutionPortSpy() {
  const requests = [];
  return {
    requests,
    port: {
      async run(request) {
        requests.push(request);
        assert.equal(request.command.mode, "argv", "宿主执行必须是 argv 模式（非 shell 拼接）");
        assert.equal(request.command.file, "git");
        assert.deepEqual(request.sandbox, { enabled: false }, "合并跑沙箱外（spec R5）");
        const startedAt = new Date();
        try {
          const stdout = execFileSync(request.command.file, request.command.args, {
            cwd: request.cwd,
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "pipe"],
          });
          return completed(stdout, "", 0, startedAt);
        } catch (error) {
          return completed(
            error.stdout?.toString() ?? "",
            error.stderr?.toString() ?? "",
            typeof error.status === "number" ? error.status : 1,
            startedAt,
          );
        }
      },
    },
  };
}

function completed(stdout, stderr, exitCode, startedAt) {
  const completedAt = new Date();
  return {
    status: "completed",
    exitCode,
    stdout: { text: stdout, bytes: Buffer.byteLength(stdout), truncated: false },
    stderr: { text: stderr, bytes: Buffer.byteLength(stderr), truncated: false },
    durationMs: completedAt.getTime() - startedAt.getTime(),
    timedOut: false,
    cancelled: false,
    startedAt,
    completedAt,
  };
}

function makeContext(workingDirectory, sessionId, executionPort) {
  return {
    toolCallId: "tc-swtm-test",
    traceId: "trace-swtm-test",
    abortSignal: new AbortController().signal,
    workingDirectory,
    workspaceRoot: workingDirectory,
    sessionId,
    ...(executionPort ? { executionPort } : {}),
  };
}

async function setupEnteredSession(sessionId = "sess_merge") {
  const repo = createRealRepo();
  const tmpRoot = tempDir("acode-swtm-tmp-");
  const ledger = new SessionWorktreeLedger({
    filePath: join(tempDir("acode-swtm-data-"), "ledger.jsonl"),
  });
  const manager = createSessionWorktreeManager({ tmpRoot });
  const deps = { manager, ledger };
  const entered = await enterSessionWorktree({ repoDir: repo, sessionId }, deps);
  assert.equal(entered.outcome, "entered");
  const spy = createHostExecutionPortSpy();
  const entry = createMergeBaseBranchToolEntry(deps);
  return { repo, deps, entered, spy, entry, worktree: entered.handle.path };
}

afterEach(() => {
  resetSessionWorktreeFenceForTest();
});

// ── 场景 4：merge-base ─────────────────────────────────────────────

test("(场景4) source_branch 合并：main 前进 → merge → 文件在场、merge commit、不 push", async () => {
  const { repo, entry, spy, worktree } = await setupEnteredSession();

  // 会话侧提交：
  writeFileSync(join(worktree, "session.txt"), "session work\n", "utf-8");
  git(["add", "."], worktree);
  git(["commit", "-m", "session commit"], worktree);

  // base（main，即切出分支）前进：
  writeFileSync(join(repo, "base.txt"), "base progress\n", "utf-8");
  git(["add", "."], repo);
  git(["commit", "-m", "base commit"], repo);

  const output = await entry.handler({ base: "source_branch" }, makeContext(worktree, "sess_merge", spy.port));
  assert.equal(output.outcome, "merged", JSON.stringify(output));
  assert.equal(output.base_ref, "main");
  assert.match(output.merge_commit, /^[0-9a-f]{40}$/);
  assert.ok(existsSync(join(worktree, "base.txt")), "base 的材料必须合并进会话 worktree");
  assert.ok(existsSync(join(worktree, "session.txt")), "会话材料原样");

  // merge commit 真实存在（两个 parent）：
  const parents = git(["rev-list", "--parents", "-n", "1", "HEAD"], worktree).split(" ");
  assert.equal(parents.length, 3, "merge commit 必须有双 parent");

  // 宿主执行层证据链：全部 git 调用经注入的 ExecutionPort（argv + sandbox disabled）。
  assert.ok(spy.requests.length >= 2);
  assert.ok(
    spy.requests.some((request) => request.command.args[0] === "merge"),
    "merge 必须经宿主执行层",
  );

  // 不 push：仓库没有远端，任何 push 都会失败——merge 成功本身即证明；
  // 再钉一条：本地 reflog 里没有 push 痕迹（远端引用零变化）。
  assert.equal(git(["branch", "-r"], repo), "", "不得产生远端引用");
});

test("(场景4) default_branch 与 up_to_date", async () => {
  const { repo, entry, spy, worktree } = await setupEnteredSession("sess_default");

  // 无远端仓库：default_branch 解析走本地 main 候选。
  const first = await entry.handler({ base: "default_branch" }, makeContext(worktree, "sess_default", spy.port));
  assert.equal(first.outcome, "up_to_date", JSON.stringify(first));
  assert.equal(first.base_ref, "main");

  // base 前进后 default_branch 真合并：
  writeFileSync(join(repo, "d.txt"), "d\n", "utf-8");
  git(["add", "."], repo);
  git(["commit", "-m", "d"], repo);
  const second = await entry.handler({ base: "default_branch" }, makeContext(worktree, "sess_default", spy.port));
  assert.equal(second.outcome, "merged");
  assert.ok(existsSync(join(worktree, "d.txt")));
});

test("(场景4) 冲突：保留现场 + conflicted_files；action=abort 恢复干净", async () => {
  const { repo, entry, spy, worktree } = await setupEnteredSession("sess_conflict");

  // 双方改同一行 → 必然冲突：
  writeFileSync(join(worktree, "shared.txt"), "session side\n", "utf-8");
  git(["add", "."], worktree);
  git(["commit", "-m", "session side"], worktree);
  writeFileSync(join(repo, "shared.txt"), "main side\n", "utf-8");
  git(["add", "."], repo);
  git(["commit", "-m", "main side"], repo);

  const conflict = await entry.handler({ base: "source_branch" }, makeContext(worktree, "sess_conflict", spy.port));
  assert.equal(conflict.outcome, "conflict", JSON.stringify(conflict));
  assert.deepEqual(conflict.conflicted_files, ["shared.txt"]);
  const gitDirFile = readFileSync(join(worktree, ".git"), "utf-8");
  assert.ok(gitDirFile.startsWith("gitdir:"), "worktree 的 .git 是文件指针");
  // MERGE_HEAD 在场（冲突现场保留，模型可解决）：
  const mergeHead = git(["rev-parse", "-q", "--verify", "MERGE_HEAD"], worktree);
  assert.match(mergeHead, /^[0-9a-f]{40}$/);
  assert.ok(readFileSync(join(worktree, "shared.txt"), "utf-8").includes("<<<<<<<"), "冲突标记在文件里");

  // 冲突态上再 merge → merge_in_progress 拒绝（绝不叠加）：
  const stacked = await entry.handler({ base: "source_branch" }, makeContext(worktree, "sess_conflict", spy.port));
  assert.deepEqual(
    { outcome: stacked.outcome, reason: stacked.reason },
    { outcome: "rejected", reason: "merge_in_progress" },
  );

  // abort → 干净态：
  const aborted = await entry.handler({ action: "abort" }, makeContext(worktree, "sess_conflict", spy.port));
  assert.equal(aborted.outcome, "aborted");
  assert.equal(git(["status", "--porcelain"], worktree), "", "abort 后工作区必须干净");
  assert.throws(() => git(["rev-parse", "-q", "--verify", "MERGE_HEAD"], worktree), /MERGE_HEAD/, "MERGE_HEAD 必须消失");

  // 无冲突现场时 abort → no_merge_in_progress：
  const noop = await entry.handler({ action: "abort" }, makeContext(worktree, "sess_conflict", spy.port));
  assert.equal(noop.outcome, "no_merge_in_progress");
});

test("(场景4) 拒绝面：dirty 即拒 / 不在受管 worktree / pr_base / base 缺席", async () => {
  const { repo, entry, spy, worktree } = await setupEnteredSession("sess_deny");

  // dirty → uncommitted_changes：
  writeFileSync(join(worktree, "wip.txt"), "wip\n", "utf-8");
  const dirty = await entry.handler({ base: "source_branch" }, makeContext(worktree, "sess_deny", spy.port));
  assert.deepEqual(
    { outcome: dirty.outcome, reason: dirty.reason },
    { outcome: "rejected", reason: "uncommitted_changes" },
  );
  rmSync(join(worktree, "wip.txt"));

  // cwd 不在受管 worktree → not_in_session_worktree（绝不回退到主 checkout 上合并）：
  const outside = await entry.handler({ base: "source_branch" }, makeContext(repo, "sess_deny", spy.port));
  assert.deepEqual(
    { outcome: outside.outcome, reason: outside.reason },
    { outcome: "rejected", reason: "not_in_session_worktree" },
  );

  // pr_base：PR 面缺席 → pr_surface_unavailable（闭集拒绝，不是错误）：
  const pr = await entry.handler({ base: "pr_base" }, makeContext(worktree, "sess_deny", spy.port));
  assert.deepEqual(
    { outcome: pr.outcome, reason: pr.reason },
    { outcome: "rejected", reason: "pr_surface_unavailable" },
  );

  // merge 缺 base → base_not_allowed：
  const noBase = await entry.handler({ action: "merge" }, makeContext(worktree, "sess_deny", spy.port));
  assert.deepEqual(
    { outcome: noBase.outcome, reason: noBase.reason },
    { outcome: "rejected", reason: "base_not_allowed" },
  );
});

test("(场景4) detached 起源 → source_branch_unknown；executionPort 缺席 → ConfigurationError", async () => {
  const repo = createRealRepo();
  const tmpRoot = tempDir("acode-swtm-tmp2-");
  const ledger = new SessionWorktreeLedger({
    filePath: join(tempDir("acode-swtm-data2-"), "ledger.jsonl"),
  });
  const deps = { manager: createSessionWorktreeManager({ tmpRoot }), ledger };

  // detached HEAD 起源：
  git(["checkout", "--detach", "HEAD"], repo);
  const entered = await enterSessionWorktree({ repoDir: repo, sessionId: "sess_detached" }, deps);
  assert.equal(entered.outcome, "entered");
  assert.equal(entered.handle.sourceBranch, undefined, "detached 起源没有 sourceBranch");

  const spy = createHostExecutionPortSpy();
  const entry = createMergeBaseBranchToolEntry(deps);
  const unknown = await entry.handler(
    { base: "source_branch" },
    makeContext(entered.handle.path, "sess_detached", spy.port),
  );
  assert.deepEqual(
    { outcome: unknown.outcome, reason: unknown.reason },
    { outcome: "rejected", reason: "source_branch_unknown" },
  );

  // executionPort 缺席是接线故障（ConfigurationError），不是业务结局：
  await assert.rejects(
    () =>
      entry.handler(
        { base: "default_branch" },
        makeContext(entered.handle.path, "sess_detached", undefined),
      ),
    /executionPort is not available/,
  );
});

// ── 清理 ───────────────────────────────────────────────────────────

test("清理临时目录", () => {
  resetSessionWorktreeFenceForTest();
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
