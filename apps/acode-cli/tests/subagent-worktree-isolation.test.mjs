import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

/**
 * 子代理声明式 worktree 隔离验收（specs/subagent-declarative-keys.md R2，场景 3）：
 * 真实 git fixture（临时仓，绝不触碰用户仓库）驱动 createExploreSubagentPort().run()——
 * - child cwd = 临时 worktree（tmp 命名空间、acode/session/subagent-* 分支），
 *   workspaceRoot 身份锚不变，systemPrompt 追加隔离回收语义段；
 * - settle 后 clean → 目录移除 + ledger tombstone(reaped) + fence 解绑 + 分支保留；
 * - dirty → 材料优先保留（目录在、ledger active）；
 * - 非 git 仓 → fail-loud 派发拒绝（闭集 isolationReason），child 绝不启动；
 * - metadata.json 诚实（cwd=worktree + worktreeBranch/worktreePath，终态不丢）。
 */

const { createExploreSubagentPort } = await import(
  "../packages/core/src/subagent/runner.ts"
);
const { createSessionWorktreeManager } = await import(
  "../packages/core/src/worktree/session-worktree-manager.ts"
);
const { SessionWorktreeLedger } = await import(
  "../packages/core/src/worktree/session-worktree-ledger.ts"
);
const { lookupSessionWorktreeFenceBinding, resetSessionWorktreeFenceForTest } = await import(
  "../packages/core/src/worktree/session-worktree-fence.ts"
);
const { createSessionId, createTraceId } = await import(
  "../packages/contracts/src/interfaces/shared.ts"
);

const tempDirs = [];
function tempDir(prefix) {
  // realpath.native 展开 %TEMP% 的 8.3 短名（session-worktree-enter.test.mjs 同款依据）。
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
  const dir = tempDir("acode-subiso-repo-");
  git(["init", "-b", "main"], dir);
  git(["config", "user.email", "subiso@example.com"], dir);
  git(["config", "user.name", "subiso"], dir);
  writeFileSync(join(dir, "README.md"), "# shared repo\n", "utf-8");
  git(["add", "."], dir);
  git(["commit", "-m", "init"], dir);
  return dir;
}

function makeHarness() {
  const tmpRoot = tempDir("acode-subiso-tmp-");
  const ledgerFile = join(tempDir("acode-subiso-data-"), "ledger.jsonl");
  return {
    tmpRoot,
    ledgerFile,
    deps: {
      manager: createSessionWorktreeManager({ tmpRoot }),
      ledger: new SessionWorktreeLedger({ filePath: ledgerFile }),
    },
  };
}

const ISO_PROFILE = {
  description: "isolated worker",
  isolation: "worktree",
  name: "iso",
  source: "user",
  systemPrompt: "You are iso.",
};

function makePort(harness, stub, extraOptions = {}) {
  return createExploreSubagentPort({
    emitParentEvent: async () => undefined,
    outputRootDir: tempDir("acode-subiso-out-"),
    profiles: [ISO_PROFILE],
    runExploreAgent: stub,
    subagentWorktreeDeps: harness.deps,
    ...extraOptions,
  });
}

function runRequest(repo) {
  return {
    agentType: "iso",
    description: "isolated task",
    parentToolCallId: "call_iso_1",
    prompt: "do the work",
    sessionId: createSessionId("sess_subiso"),
    trace: { traceId: createTraceId() },
    workingDirectory: repo,
    workspaceRoot: repo,
  };
}

afterEach(() => {
  resetSessionWorktreeFenceForTest();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(R2) clean run：child cwd=worktree、身份锚不变、settle 后 reap（目录移除/墓碑/分支保留/fence 解绑）", async () => {
  const repo = createRealRepo();
  const harness = makeHarness();
  const captured = [];
  const stub = async (request) => {
    await request.onSessionReady?.();
    captured.push({
      sessionId: request.sessionId,
      systemPrompt: request.systemPrompt,
      workingDirectory: request.workingDirectory,
      workspaceRoot: request.workspaceRoot,
    });
    // 运行期事实：worktree 在场、fence 已按 childSessionId 绑定。
    assert.ok(existsSync(request.workingDirectory), "运行期 worktree 目录必须在场");
    const binding = lookupSessionWorktreeFenceBinding(request.workingDirectory);
    assert.equal(binding?.sessionId, request.sessionId, "fence 必须以 childSessionId 绑定");
    return { events: [], response: "done", traceId: request.traceContext.traceId };
  };
  const output = await makePort(harness, stub).run(runRequest(repo));
  assert.equal(output.status, "completed");
  assert.equal(captured.length, 1);

  const child = captured[0];
  // cwd = tmp 命名空间内的 worktree（不是父 checkout），workspaceRoot 身份锚不变。
  assert.ok(child.workingDirectory.startsWith(harness.tmpRoot), "child cwd 必须在隔离命名空间内");
  assert.notEqual(child.workingDirectory, repo);
  assert.equal(child.workspaceRoot, repo, "workspaceRoot 身份锚不得随隔离漂移");
  // systemPrompt 追加隔离回收语义段（自撰英文，spec R2）。
  assert.match(child.systemPrompt, /isolated temporary git worktree/i);
  assert.match(child.systemPrompt, /reclaims the worktree/i);
  assert.ok(child.systemPrompt.startsWith("You are iso."), "profile prompt 原文不动");

  // settle 后：clean → 目录移除、ledger tombstone(reaped)、fence 解绑、分支保留。
  assert.ok(!existsSync(child.workingDirectory), "clean worktree 必须被回收");
  const bindings = await harness.deps.ledger.load();
  const binding = bindings.find((entry) => entry.sessionId === child.sessionId);
  assert.equal(binding?.state, "tombstone");
  assert.equal(binding?.tombstoneReason, "reaped");
  assert.match(binding?.branch ?? "", /^acode\/session\/subagent-iso-/);
  assert.equal(lookupSessionWorktreeFenceBinding(child.workingDirectory), undefined);
  const branches = git(["branch", "--list", binding.branch], repo);
  assert.ok(branches.includes(binding.branch), "分支材料必须保留（合并归工具面/用户）");
});

test("(R2) dirty run：未提交改动材料优先保留（目录在、ledger active）", async () => {
  const repo = createRealRepo();
  const harness = makeHarness();
  let worktreePath;
  let childSessionId;
  const stub = async (request) => {
    await request.onSessionReady?.();
    worktreePath = request.workingDirectory;
    childSessionId = request.sessionId;
    // child 留下未提交改动（材料）。
    writeFileSync(join(worktreePath, "wip.txt"), "uncommitted material\n", "utf-8");
    return { events: [], response: "done", traceId: request.traceContext.traceId };
  };
  await makePort(harness, stub).run(runRequest(repo));
  assert.ok(existsSync(join(worktreePath, "wip.txt")), "dirty worktree 必须保留（材料优先）");
  const bindings = await harness.deps.ledger.load();
  const binding = bindings.find((entry) => entry.sessionId === childSessionId);
  assert.equal(binding?.state, "active", "dirty 条目保持 active，交给既有收割面/用户处置");
  assert.equal(binding?.worktreePath, worktreePath);
});

test("(R2) 非 git 仓 → fail-loud 派发拒绝（闭集 isolationReason），child 绝不静默跑共享 cwd", async () => {
  const plainDir = tempDir("acode-subiso-plain-");
  const harness = makeHarness();
  let stubCalled = false;
  const stub = async (request) => {
    stubCalled = true;
    await request.onSessionReady?.();
    return { events: [], response: "done", traceId: request.traceContext.traceId };
  };
  await assert.rejects(
    () => makePort(harness, stub).run(runRequest(plainDir)),
    (error) => {
      assert.match(error.message, /isolation: worktree/);
      assert.equal(error.context?.reason, "worktree_isolation_unavailable");
      assert.equal(error.context?.isolationReason, "not_git_repo");
      assert.equal(error.context?.code, "agent_subagent_unavailable");
      assert.equal(error.recoverable, true);
      return true;
    },
  );
  assert.equal(stubCalled, false, "拒绝必须发生在 child 启动之前（绝不降级共享 cwd）");
});

test("(R2) metadata 诚实：运行期重写与终态写入都携带 cwd=worktree + 分支事实", async () => {
  const repo = createRealRepo();
  const harness = makeHarness();
  let childCwd;
  const stub = async (request) => {
    await request.onSessionReady?.();
    childCwd = request.workingDirectory;
    return { events: [], response: "done", traceId: request.traceContext.traceId };
  };
  const outputRootDir = tempDir("acode-subiso-out-");
  const output = await makePort(harness, stub, { outputRootDir }).run(runRequest(repo));
  assert.equal(output.status, "completed");
  // 输出目录结构：<outputRootDir>/<parentSessionId>/<agentId>/metadata.json
  const sessionDirs = readdirSync(outputRootDir);
  assert.equal(sessionDirs.length, 1);
  const agentDirs = readdirSync(join(outputRootDir, sessionDirs[0]));
  assert.equal(agentDirs.length, 1);
  const metadata = JSON.parse(
    readFileSync(join(outputRootDir, sessionDirs[0], agentDirs[0], "metadata.json"), "utf-8"),
  );
  assert.equal(metadata.status, "completed");
  assert.equal(metadata.cwd, childCwd, "终态 cwd 必须是 worktree 而非父 checkout");
  assert.notEqual(metadata.cwd, repo);
  assert.match(metadata.worktreeBranch ?? "", /^acode\/session\/subagent-iso-/);
  assert.equal(metadata.worktreePath, childCwd, "终态 metadata 必须保留 worktreePath 事实");
  assert.equal(metadata.workspaceRoot, repo);
});
