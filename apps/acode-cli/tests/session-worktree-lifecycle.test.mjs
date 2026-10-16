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
 * 全链验收（波次 2 任务书要求的端到端形态）：真实 git 子进程 fixture 上跑
 * 建仓 → enter → 改动 → merge-base → 收割 → 重开重挂 的完整生命周期，全程走
 * **工具 handler 面**（不是内部模块直调），围栏 warn 语义在链路中间被行使一次。
 */

const { createEnterSessionWorktreeToolEntry } = await import(
  "../packages/core/src/tool/handlers/enter-session-worktree.ts"
);
const { createMergeBaseBranchToolEntry } = await import(
  "../packages/core/src/tool/handlers/merge-base-branch.ts"
);
const { createReapSessionWorktreesToolEntry } = await import(
  "../packages/core/src/tool/handlers/reap-session-worktrees.ts"
);
const { createSessionWorktreeManager } = await import(
  "../packages/core/src/worktree/session-worktree-manager.ts"
);
const { SessionWorktreeLedger } = await import(
  "../packages/core/src/worktree/session-worktree-ledger.ts"
);
const { resolveWorkspacePath } = await import("../packages/core/src/tool/path-policy.ts");
const {
  resetSessionWorktreeFenceForTest,
  snapshotSessionWorktreeFenceViolations,
} = await import("../packages/core/src/worktree/session-worktree-fence.ts");

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

/** 宿主执行层替身：真跑 git，但只接受 argv 模式 + sandbox disabled（spec R5 形态钉死）。 */
function createHostGitPort() {
  const calls = [];
  const completed = (stdout, stderr, exitCode, startedAt) => {
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
  };
  return {
    calls,
    port: {
      async run(request) {
        calls.push(request.command.args.join(" "));
        assert.equal(request.command.mode, "argv");
        assert.equal(request.command.file, "git");
        assert.deepEqual(request.sandbox, { enabled: false });
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

function makeContext(workingDirectory, sessionId, executionPort) {
  const ctx = {
    toolCallId: "tc-chain",
    traceId: "trace-chain",
    abortSignal: new AbortController().signal,
    workingDirectory,
    workspaceRoot: workingDirectory,
    sessionId,
    cwdCalls: [],
    ...(executionPort ? { executionPort } : {}),
  };
  ctx.setWorkingDirectory = (cwd) => {
    ctx.cwdCalls.push(cwd);
    ctx.workingDirectory = cwd;
    ctx.workspaceRoot = ctx.workspaceRoot; // workspaceRoot 不随执行 cwd 漂移（config.ts 不变量）
  };
  return ctx;
}

afterEach(() => {
  resetSessionWorktreeFenceForTest();
});

test("全链：建仓 → enter → 改动 → merge-base → 收割 → 重开重挂", async () => {
  // ── 建仓（main 有历史，用户 checkout 有未提交材料）──
  const repo = tempDir("acode-swt-chain-repo-");
  git(["init", "-b", "main"], repo);
  git(["config", "user.email", "chain@example.com"], repo);
  git(["config", "user.name", "chain"], repo);
  writeFileSync(join(repo, "app.txt"), "v1\n", "utf-8");
  git(["add", "."], repo);
  git(["commit", "-m", "init"], repo);
  const head0 = git(["rev-parse", "HEAD"], repo);
  writeFileSync(join(repo, "user-wip.txt"), "user uncommitted material\n", "utf-8");

  const harnessDeps = {
    manager: createSessionWorktreeManager({ tmpRoot: tempDir("acode-swt-chain-tmp-") }),
    ledger: new SessionWorktreeLedger({
      filePath: join(tempDir("acode-swt-chain-data-"), "ledger.jsonl"),
    }),
  };
  const enterEntry = createEnterSessionWorktreeToolEntry(harnessDeps);
  const host = createHostGitPort();
  const mergeEntry = createMergeBaseBranchToolEntry(harnessDeps);
  const reapEntry = createReapSessionWorktreesToolEntry(harnessDeps);
  const ctx = makeContext(repo, "sess_chain-01", host.port);

  // ── enter ──
  const entered = await enterEntry.handler({}, ctx);
  assert.equal(entered.outcome, "entered", JSON.stringify(entered));
  const worktree = entered.worktree_path;
  assert.equal(ctx.workingDirectory, worktree, "会话 cwd 已切进 worktree");
  assert.ok(!existsSync(join(worktree, "user-wip.txt")), "未提交改动不携带");
  assert.ok(existsSync(join(repo, "user-wip.txt")), "用户材料原地保留");
  assert.equal(entered.base_ref, head0);

  // ── 围栏（warn 档）在链路中间被行使：写 worktree 内放行，写主 checkout 记录 ──
  const violationsBefore = snapshotSessionWorktreeFenceViolations().total;
  resolveWorkspacePath({
    inputPath: "feature.txt",
    workingDirectory: ctx.workingDirectory,
    workspaceRoot: repo,
    operation: "write",
  });
  assert.equal(snapshotSessionWorktreeFenceViolations().total, violationsBefore);
  resolveWorkspacePath({
    inputPath: join(repo, "sneaky.txt"),
    workingDirectory: ctx.workingDirectory,
    workspaceRoot: repo,
    operation: "write",
  });
  assert.equal(
    snapshotSessionWorktreeFenceViolations().total,
    violationsBefore + 1,
    "warn 档：写主 checkout 被记录（不拦截，现状语义）",
  );

  // ── 改动（会话在 worktree 里干活并提交）──
  writeFileSync(join(worktree, "feature.txt"), "session feature\n", "utf-8");
  git(["add", "."], worktree);
  git(["commit", "-m", "feature"], worktree);

  // ── base 前进（main 上新提交）──
  writeFileSync(join(repo, "app.txt"), "v2 from main\n", "utf-8");
  git(["add", "."], repo);
  git(["commit", "-m", "main progress"], repo);

  // ── merge-base（source_branch=main，宿主执行层）──
  const merged = await mergeEntry.handler({ base: "source_branch" }, ctx);
  assert.equal(merged.outcome, "merged", JSON.stringify(merged));
  assert.equal(
    readFileSync(join(worktree, "app.txt"), "utf-8").replace(/\r\n/g, "\n"),
    "v2 from main\n",
    "base 材料合并进会话分支",
  );
  assert.ok(
    readFileSync(join(worktree, "feature.txt"), "utf-8").includes("session feature"),
    "会话材料原样",
  );
  assert.ok(
    host.calls.some((call) => call.startsWith("merge --no-edit")),
    "合并必须经宿主执行层 git（argv、沙箱外）",
  );
  // 不 push 不删除：远端引用零、分支全在场。
  assert.equal(git(["branch", "-r"], repo), "");
  assert.ok(git(["branch", "--list", "main"], repo).includes("main"));

  // ── 收割（台账时间回拨 61 天 → 但 worktree 是 clean 才会被收）──
  // 会话已提交全部材料 → clean。先解绑本进程围栏（模拟会话已关闭），再回拨台账。
  const bindings = await harnessDeps.ledger.load();
  const chainBinding = bindings.find((binding) => binding.sessionId === "sess_chain-01");
  assert.equal(chainBinding.state, "active");
  resetSessionWorktreeFenceForTest();
  await harnessDeps.ledger.append({
    v: 1,
    event: "bind",
    sessionId: chainBinding.sessionId,
    repoFingerprint: chainBinding.repoFingerprint,
    repoRoot: chainBinding.repoRoot,
    worktreePath: chainBinding.worktreePath,
    branch: chainBinding.branch,
    baseRef: chainBinding.baseRef,
    sourceBranch: chainBinding.sourceBranch,
    at: Date.now() - 61 * 24 * 60 * 60 * 1000,
  });

  const reaped = await reapEntry.handler(
    { older_than_days: 60 },
    makeContext(repo, "sess_settings-surface", host.port),
  );
  assert.equal(reaped.reaped, 1, JSON.stringify(reaped));
  assert.equal(reaped.entries[0].outcome, "reaped");
  assert.ok(!existsSync(worktree), "worktree 目录已移除");
  assert.ok(
    git(["branch", "--list", entered.branch], repo).includes(entered.branch),
    "分支保留（重开重挂的材料）",
  );

  // ── 重开重挂：同 sessionId 重进 → reattached，merge commit 材料在分支 tip ──
  const reopenCtx = makeContext(repo, "sess_chain-01", host.port);
  const reattached = await enterEntry.handler({}, reopenCtx);
  assert.equal(reattached.outcome, "reattached", JSON.stringify(reattached));
  assert.equal(reattached.branch, entered.branch);
  assert.ok(existsSync(join(reattached.worktree_path, "feature.txt")), "会话材料随分支回来");
  assert.equal(
    readFileSync(join(reattached.worktree_path, "app.txt"), "utf-8").replace(/\r\n/g, "\n"),
    "v2 from main\n",
    "合并结果随分支回来",
  );

  // 台账终态：一条 active（重挂后）+ 历史 tombstone 折叠为最新 bind。
  const finalBindings = await harnessDeps.ledger.load();
  const finalChain = finalBindings.filter((binding) => binding.sessionId === "sess_chain-01");
  assert.equal(finalChain.length, 1);
  assert.equal(finalChain[0].state, "active");
});

test("清理临时目录", () => {
  resetSessionWorktreeFenceForTest();
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
