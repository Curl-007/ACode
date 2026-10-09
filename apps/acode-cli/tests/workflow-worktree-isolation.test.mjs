import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";

/**
 * S1 验收测试（apps/acode-cli/specs/workflow-worktree-isolation.md 场景 1-7）：
 * worktree 生命周期管理器的真实 git 行为（临时仓，绝不触碰用户仓库）+ 注入 runner
 * 的竞争/重试/失败分支 + runtime 接线源码不变量（照 auth-login-vault-wiring 模式）。
 */

const { WorkflowWorktreeManager, buildWorktreeBranchName } =
  await import("../packages/cli-workflow/src/workflow-worktree-manager.ts");

const tempDirs = [];
function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
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
  const dir = tempDir("acode-wt-repo-");
  git(["init", "-b", "main"], dir);
  git(["config", "user.email", "wt-eval@example.com"], dir);
  git(["config", "user.name", "wt-eval"], dir);
  writeFileSync(join(dir, "README.md"), "# shared repo\n", "utf-8");
  git(["add", "."], dir);
  git(["commit", "-m", "init"], dir);
  return dir;
}

function fakeGit(handler) {
  const log = [];
  const runner = async (args, cwd) => {
    log.push({ phase: "start", args: [...args] });
    const result = await handler(args, cwd);
    log.push({ phase: "end", args: [...args] });
    return result ?? { stdout: "", stderr: "" };
  };
  return { runner, log };
}

// ── 场景 1：ensure（真实 git）与 fail-loud ─────────────────────────

test("(场景1) ensure：命名空间落点/分支 slug/HEAD 内容一致；非 git 仓与空仓 fail-loud", async () => {
  const repo = createRealRepo();
  const tmpRoot = tempDir("acode-wt-tmp-");
  const manager = new WorkflowWorktreeManager({ tmpRoot });
  const handle = await manager.ensureWorktree({
    activityId: "activity_abc-123",
    label: "My Label!",
    repoDir: repo,
    runId: "run-1",
  });
  try {
    assert.ok(handle.path.startsWith(tmpRoot), "worktree 必须落在注入的命名空间下");
    assert.equal(handle.branch, buildWorktreeBranchName("run-1", "My Label!", "activity_abc-123"));
    assert.match(handle.branch, /^acode\/workflow\/run-1\/My-Label-activity_abc-123$/);
    assert.equal(git(["rev-parse", "HEAD"], handle.path), handle.baseRef);
    // git checkout 在 Windows 会做 LF→CRLF 转换，内容断言按仓库测试惯例做 EOL 归一。
    assert.equal(
      readFileSync(join(handle.path, "README.md"), "utf-8").replace(/\r\n/g, "\n"),
      "# shared repo\n",
    );
    // 主 checkout 的 worktree 登记可见（porcelain 解析，Windows 路径大小写/分隔符归一）：
    const listed = git(["worktree", "list", "--porcelain"], repo)
      .split(/\r?\n/)
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length).trim().toLowerCase());
    assert.equal(listed.length, 2, "主 worktree + 新建的隔离 worktree");
    assert.ok(
      listed.some(
        (entry) =>
          entry === handle.path.replace(/\\/g, "/").toLowerCase() ||
          entry === handle.path.toLowerCase(),
      ),
      `登记路径应含 ${handle.path}`,
    );
  } finally {
    await manager.releaseWorktree(handle);
  }

  // 非 git 仓 → fail-loud（R7），绝不静默降级：
  const notRepo = tempDir("acode-wt-notrepo-");
  await assert.rejects(
    () =>
      new WorkflowWorktreeManager({ tmpRoot }).ensureWorktree({
        activityId: "a",
        repoDir: notRepo,
        runId: "r",
      }),
    /requires a git repository/,
  );
  // 空仓（unborn HEAD）→ fail-loud：
  const emptyRepo = tempDir("acode-wt-empty-");
  git(["init", "-b", "main"], emptyRepo);
  await assert.rejects(
    () =>
      new WorkflowWorktreeManager({ tmpRoot }).ensureWorktree({
        activityId: "a",
        repoDir: emptyRepo,
        runId: "r",
      }),
    /at least one commit/,
  );
});

test("(场景1a SWF-06) 相同显示 label 仍按 activityId 分配独立分支与 worktree", async () => {
  const repo = createRealRepo();
  const manager = new WorkflowWorktreeManager({ tmpRoot: tempDir("acode-wt-tmp-") });
  const first = await manager.ensureWorktree({
    activityId: "activity_1",
    label: "review",
    repoDir: repo,
    runId: "run-label-collision",
  });
  const second = await manager.ensureWorktree({
    activityId: "activity_2",
    label: "review",
    repoDir: repo,
    runId: "run-label-collision",
  });
  try {
    assert.notEqual(first.branch, second.branch);
    assert.notEqual(first.path, second.path);
    assert.match(first.branch, /activity_1$/);
    assert.match(second.branch, /activity_2$/);
    assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], first.path), first.branch);
    assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], second.path), second.branch);
  } finally {
    await manager.releaseWorktree(first);
    await manager.releaseWorktree(second);
  }
});

// ── 场景 2/3：release 裁决（clean 回收 / dirty 保留）────────────────

test("(场景2) release clean：worktree 移除、分支删除、kept:false", async () => {
  const repo = createRealRepo();
  const manager = new WorkflowWorktreeManager({ tmpRoot: tempDir("acode-wt-tmp-") });
  const handle = await manager.ensureWorktree({
    activityId: "act-clean",
    repoDir: repo,
    runId: "run-c",
  });
  const release = await manager.releaseWorktree(handle);
  assert.deepEqual(
    { kept: release.kept, reason: release.reason },
    { kept: false, reason: "clean-reclaimed" },
  );
  assert.ok(!existsSync(handle.path), "clean worktree 目录必须移除");
  assert.equal(git(["branch", "--list", handle.branch], repo), "", "指向 baseRef 的分支必须删除");
});

test("(场景3) release dirty：未提交改动或领先提交都保留 + dirty-kept；remove 失败 → reclaim-failed-kept", async () => {
  const repo = createRealRepo();
  const manager = new WorkflowWorktreeManager({ tmpRoot: tempDir("acode-wt-tmp-") });

  // 未提交改动 → 保留（材料优先，R5）：
  const uncommitted = await manager.ensureWorktree({
    activityId: "act-dirty-1",
    repoDir: repo,
    runId: "run-d1",
  });
  writeFileSync(join(uncommitted.path, "wip.txt"), "half-done work\n", "utf-8");
  const releaseUncommitted = await manager.releaseWorktree(uncommitted);
  assert.deepEqual(
    { kept: releaseUncommitted.kept, reason: releaseUncommitted.reason },
    { kept: true, reason: "dirty-kept" },
  );
  assert.ok(existsSync(join(uncommitted.path, "wip.txt")), "dirty 材料绝不销毁");

  // 仅提交（工作区干净但领先 baseRef）→ 同样保留：
  const committed = await manager.ensureWorktree({
    activityId: "act-dirty-2",
    repoDir: repo,
    runId: "run-d2",
  });
  writeFileSync(join(committed.path, "done.txt"), "committed work\n", "utf-8");
  git(["add", "."], committed.path);
  git(["commit", "-m", "actor work"], committed.path);
  const releaseCommitted = await manager.releaseWorktree(committed);
  assert.deepEqual(
    { kept: releaseCommitted.kept, reason: releaseCommitted.reason },
    { kept: true, reason: "dirty-kept" },
  );
  assert.equal(git(["rev-list", "--count", `${committed.baseRef}..HEAD`], committed.path), "1");
});

test("(场景3) remove 失败 → reclaim-failed-kept（注入 runner）", async () => {
  const { runner } = fakeGit(async (args) => {
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel")
      return { stdout: "/fake/repo\n", stderr: "" };
    if (args[0] === "rev-parse") return { stdout: "f".repeat(40), stderr: "" };
    if (args[0] === "worktree" && args[1] === "remove") throw new Error("fatal: 'wt' is in use");
    return { stdout: "", stderr: "" };
  });
  const manager = new WorkflowWorktreeManager({ git: runner, tmpRoot: tempDir("acode-wt-tmp-") });
  const release = await manager.releaseWorktree({
    baseRef: "f".repeat(40),
    branch: "acode/workflow/r/a",
    path: join(tempDir("acode-wt-fake-"), "wt"),
    repoRoot: "/fake/repo",
  });
  assert.deepEqual(
    { kept: release.kept, reason: release.reason },
    { kept: true, reason: "reclaim-failed-kept" },
  );
});

// ── 场景 4：幂等复用与残骸重建 ─────────────────────────────────────

test("(场景4) 同 handle 重复 ensure 复用已登记 worktree；未登记残骸清掉重建", async () => {
  const repo = createRealRepo();
  const manager = new WorkflowWorktreeManager({ tmpRoot: tempDir("acode-wt-tmp-") });
  const input = { activityId: "act-reuse", label: "reuse", repoDir: repo, runId: "run-r" };
  const first = await manager.ensureWorktree(input);
  const marker = join(first.path, "keep-me.txt");
  writeFileSync(marker, "live\n", "utf-8"); // 让目录 dirty，确保复用而非重建（重建会清掉它）
  const second = await manager.ensureWorktree(input);
  assert.equal(second.path, first.path);
  assert.ok(existsSync(marker), "复用路径不得触碰既有 worktree 内容");

  // 未登记残骸（failed-add 遗留形态）：目录在场但 git 不认 → 清掉重建成功。
  const staleManager = new WorkflowWorktreeManager({ tmpRoot: tempDir("acode-wt-tmp-") });
  const staleRepo = createRealRepo();
  const planned = await staleManager.ensureWorktree({
    activityId: "act-stale",
    repoDir: staleRepo,
    runId: "run-s",
  });
  await staleManager.releaseWorktree(planned); // clean 回收后目录已移除
  mkdirSync(planned.path, { recursive: true });
  writeFileSync(join(planned.path, "junk.txt"), "failed-add leftover\n", "utf-8");
  const rebuilt = await staleManager.ensureWorktree({
    activityId: "act-stale",
    repoDir: staleRepo,
    runId: "run-s",
  });
  assert.equal(rebuilt.path, planned.path);
  assert.ok(!existsSync(join(rebuilt.path, "junk.txt")), "残骸必须被清掉后由 git 重建");
  assert.ok(existsSync(join(rebuilt.path, "README.md")));
  await staleManager.releaseWorktree(rebuilt);
});

// ── 场景 5/6：串行化、锁重试、分支已存在、prune ────────────────────

test("(场景5) 并发 ensure×3 的 git 调用严格串行（进程内互斥队列）", async () => {
  const repoRoot = "/fake/repo";
  const { runner, log } = fakeGit(async (args) => {
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel")
      return { stdout: `${repoRoot}\n`, stderr: "" };
    if (args[0] === "rev-parse") return { stdout: "a".repeat(40), stderr: "" };
    await new Promise((r) => setTimeout(r, 2)); // 放大交叠窗口
    return { stdout: "", stderr: "" };
  });
  const manager = new WorkflowWorktreeManager({ git: runner, tmpRoot: tempDir("acode-wt-tmp-") });
  await Promise.all([
    manager.ensureWorktree({ activityId: "a1", repoDir: repoRoot, runId: "r1" }),
    manager.ensureWorktree({ activityId: "a2", repoDir: repoRoot, runId: "r2" }),
    manager.ensureWorktree({ activityId: "a3", repoDir: repoRoot, runId: "r3" }),
  ]);
  // 串行 = start/end 严格交替，绝无 start,start 交叠：
  for (let i = 0; i < log.length; i += 2) {
    assert.equal(log[i].phase, "start", `log[${i}] 应为 start`);
    assert.equal(log[i + 1]?.phase, "end", `log[${i + 1}] 应为同一调用的 end（无交叠）`);
  }
});

test("(场景5/R6) 锁冲突一次退避重试；分支已存在回退挂载既有分支", async () => {
  // 锁冲突：第一次 add 报 lock，第二次成功。
  let addAttempts = 0;
  const lockRepo = "/fake/lock-repo";
  const lockGit = fakeGit(async (args) => {
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel")
      return { stdout: `${lockRepo}\n`, stderr: "" };
    if (args[0] === "rev-parse") return { stdout: "b".repeat(40), stderr: "" };
    if (args[0] === "worktree" && args[1] === "add") {
      addAttempts += 1;
      if (addAttempts === 1)
        throw new Error("fatal: unable to create '.git/worktrees/x.lock': File exists");
    }
    return { stdout: "", stderr: "" };
  });
  const lockManager = new WorkflowWorktreeManager({
    git: lockGit.runner,
    tmpRoot: tempDir("acode-wt-tmp-"),
  });
  const lockHandle = await lockManager.ensureWorktree({
    activityId: "a-lock",
    repoDir: lockRepo,
    runId: "r-lock",
  });
  assert.equal(addAttempts, 2, "锁冲突必须重试一次后成功");
  // manager 对 toplevel 做 resolve() 归一（Windows 下 /fake/... → C:\fake\...）。
  assert.equal(lockHandle.repoRoot, resolve(lockRepo));

  // 分支已存在（resume 形态）：-b 变体失败 → 无 -b 变体挂载既有分支。
  const seenAddArgSets = [];
  const branchRepo = "/fake/branch-repo";
  const branchGit = fakeGit(async (args) => {
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel")
      return { stdout: `${branchRepo}\n`, stderr: "" };
    if (args[0] === "rev-parse") return { stdout: "c".repeat(40), stderr: "" };
    if (args[0] === "worktree" && args[1] === "add") {
      seenAddArgSets.push(args);
      if (args.includes("-b"))
        throw new Error("fatal: a branch named 'acode/workflow/r-b/l-b' already exists");
    }
    return { stdout: "", stderr: "" };
  });
  const branchManager = new WorkflowWorktreeManager({
    git: branchGit.runner,
    tmpRoot: tempDir("acode-wt-tmp-"),
  });
  await branchManager.ensureWorktree({
    activityId: "a-b",
    label: "l-b",
    repoDir: branchRepo,
    runId: "r-b",
  });
  assert.equal(seenAddArgSets.length, 2);
  assert.ok(seenAddArgSets[0].includes("-b"), "首选带 -b 新建分支");
  assert.ok(!seenAddArgSets[1].includes("-b"), "分支已存在时回退为挂载既有分支");
});

test("(场景6) prune：git 登记外的老龄残骸被清；登记内与新鲜目录不动", async () => {
  const repo = createRealRepo();
  const tmpRoot = tempDir("acode-wt-tmp-");
  const manager = new WorkflowWorktreeManager({ tmpRoot });
  const live = await manager.ensureWorktree({
    activityId: "act-live",
    repoDir: repo,
    runId: "run-p",
  });
  // 命名空间 = tmpRoot/<fingerprint>；live worktree 所在目录即命名空间成员。
  const namespace = dirname(live.path);
  const oldOrphan = join(namespace, "orphan-old");
  const freshOrphan = join(namespace, "orphan-fresh");
  mkdirSync(oldOrphan, { recursive: true });
  mkdirSync(freshOrphan, { recursive: true });
  const twoHoursAgo = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
  utimesSync(oldOrphan, twoHoursAgo, twoHoursAgo);
  await manager.pruneOrphans(repo);
  assert.ok(!existsSync(oldOrphan), "未登记且老龄的残骸必须清理");
  assert.ok(existsSync(freshOrphan), "新鲜目录不动（避开并发进程刚建的）");
  assert.ok(existsSync(live.path), "git 仍登记的活 worktree 绝不动（材料优先）");
  await manager.releaseWorktree(live);
});

// ── 场景 7：runtime 接线源码不变量 ─────────────────────────────────

test("(场景7) runtime 接线：桩已移除，ensure/release/注入/信封登记全部在场", () => {
  const source = readFileSync(
    new URL("../packages/cli-workflow/src/script-workflow-runtime.ts", import.meta.url),
    "utf-8",
  );
  assert.ok(!source.includes("not implemented yet"), "not-implemented 桩必须移除");
  assert.match(source, /ensureWorktree\(\{/);
  assert.match(source, /configOverrides:\s*\{\s*workingDirectory:\s*worktree\.path\s*\}/);
  assert.match(source, /releaseWorktree\(worktree\)/);
  assert.match(source, /buildWorktreeRecord\(worktree, worktreeRelease\)/);
  // catch 与 finally 都有回收（成功路径在 try 内、失败在 catch、兜底在 finally）：
  assert.equal(
    source.match(/releaseWorktree\(worktree\)/g).length,
    3,
    "try/catch/finally 三处回收",
  );
  // 子 runtime 工厂零改动（注入走既有 configOverrides 通道）：
  const childSource = readFileSync(
    new URL("../packages/cli-workflow/src/script-workflow-child-runtime.ts", import.meta.url),
    "utf-8",
  );
  assert.ok(!childSource.includes("worktree"), "child-runtime 不得感知 worktree（R4 零新接口）");
});

// ── 清理 ───────────────────────────────────────────────────────────

test("清理临时目录", () => {
  for (const dir of tempDirs) {
    // dirty-kept 的 worktree 目录被 git 管理条目引用，先 prune 再删（best-effort）。
    rmSync(dir, { recursive: true, force: true });
  }
});
