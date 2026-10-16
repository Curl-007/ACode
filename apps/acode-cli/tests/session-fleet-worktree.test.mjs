// 会话舰队验收（apps/acode-cli/specs/session-fleet.md 场景 8）：
// use_worktree 与波次 2 台账联动——真实 git 子进程 fixture（临时仓，绝不触碰
// 用户仓库）：launch 前 worktree 已建（HEAD 切出、不携带未提交改动）、launch 后
// 台账键 = childSessionId（临时键 tombstone）、child workingDirectory = worktree
// 路径、围栏重绑到 child、非 git 仓拒绝、launch 失败 → 临时键回收无孤儿绑定。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

const { createStartSessionToolEntry } = await import(
  "../packages/core/src/tool/handlers/start-session.ts"
);
const { FleetRegistry } = await import("../packages/core/src/fleet/registry.ts");
const { InMemoryRuntimeTaskRegistry } = await import(
  "../packages/core/src/runtime-task/registry.ts"
);
const { SessionWorktreeLedger } = await import(
  "../packages/core/src/worktree/session-worktree-ledger.ts"
);
const { createSessionWorktreeManager } = await import(
  "../packages/core/src/worktree/session-worktree-manager.ts"
);
const {
  lookupSessionWorktreeFenceBinding,
  resetSessionWorktreeFenceForTest,
} = await import("../packages/core/src/worktree/session-worktree-fence.ts");

const tempDirs = [];
function tempDir(prefix) {
  // realpath.native 展开 %TEMP% 的 8.3 短名（波次 2 测试同款实证依据）。
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
  const dir = tempDir("acode-fleet-repo-");
  git(["init", "-b", "main"], dir);
  git(["config", "user.email", "fleet-eval@example.com"], dir);
  git(["config", "user.name", "fleet-eval"], dir);
  writeFileSync(join(dir, "README.md"), "# fleet repo\n", "utf-8");
  git(["add", "."], dir);
  git(["commit", "-m", "init"], dir);
  return dir;
}

afterEach(() => {
  resetSessionWorktreeFenceForTest();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 4 });
    } catch {
      // best-effort 清理
    }
  }
});

let agentCounter = 0;

function createFakeSubagentPort(taskRegistry, options = {}) {
  return {
    launchCalls: [],
    async launch(request) {
      this.launchCalls.push(request);
      if (options.failLaunch) throw options.failLaunch;
      agentCounter += 1;
      const agentId = `agent_wt-${agentCounter}`;
      const childSessionId = `sess_subagent_${agentId}`;
      taskRegistry.register({
        taskId: agentId,
        agentId,
        agentType: request.agentType,
        description: request.description,
        status: "running",
        startedAt: new Date(),
        type: "local_agent",
        childSessionId,
        isBackgrounded: true,
      });
      return {
        status: "async_launched",
        isAsync: true,
        agentId,
        agentType: request.agentType,
        description: request.description,
        prompt: request.prompt,
        childSessionId,
        backgroundTaskId: agentId,
        outputFile: `/tmp/fake/${agentId}/output.txt`,
        canReadOutputFile: true,
      };
    },
  };
}

function makeHarness(repo, portOptions = {}) {
  const registry = new FleetRegistry();
  const taskRegistry = new InMemoryRuntimeTaskRegistry();
  const subagentPort = createFakeSubagentPort(taskRegistry, portOptions);
  const ledger = new SessionWorktreeLedger({ dataRootDir: tempDir("acode-fleet-ledger-") });
  const manager = createSessionWorktreeManager({ tmpRoot: tempDir("acode-fleet-wt-") });
  // fenceFlushIntervalMs 拉大：测试期不落心跳 touch（波次 2 测试同款做法）。
  const deps = {
    registry,
    worktreeDeps: { ledger, manager, fenceFlushIntervalMs: 60 * 60 * 1000 },
  };
  const context = {
    toolCallId: "tc-wt-test",
    traceId: "trace-wt-test",
    abortSignal: new AbortController().signal,
    workingDirectory: repo,
    workspaceRoot: repo,
    sessionId: "sess_wt-launcher",
    subagentPort,
    runtimeTaskRegistry: taskRegistry,
    sessionModePort: { getMode: () => "build", isPlanEnabled: () => false },
  };
  return {
    registry,
    taskRegistry,
    subagentPort,
    ledger,
    manager,
    context,
    startEntry: createStartSessionToolEntry(deps),
  };
}

test("(场景8) use_worktree：launch 前建 worktree、child cwd = worktree、台账重键到 childSessionId、未提交改动不携带", async () => {
  const repo = createRealRepo();
  writeFileSync(join(repo, "wip.txt"), "user work in progress\n", "utf-8");
  const head = git(["rev-parse", "HEAD"], repo);
  const h = makeHarness(repo);

  const output = await h.startEntry.handler(
    { title: "isolated refactor", prompt: "refactor things", use_worktree: true },
    h.context,
  );
  assert.equal(output.outcome, "started", JSON.stringify(output));
  assert.ok(output.worktree_path, "worktree 路径进结果");
  assert.match(output.branch, /^acode\/session\/isolated-refactor$/, "分支 slug 取标题");
  assert.equal(output.base_ref, head, "从当前 HEAD 切出");

  // child 以 worktree 为 workingDirectory 启动（launch 前 provision 的意义）。
  assert.equal(h.subagentPort.launchCalls[0].workingDirectory, output.worktree_path);
  assert.equal(h.subagentPort.launchCalls[0].workspaceRoot, repo, "工作区身份不随 cwd 漂移");

  // 未提交改动不携带；内容与 HEAD 一致（EOL 归一照仓库测试惯例）。
  assert.ok(!existsSync(join(output.worktree_path, "wip.txt")), "未提交改动绝不携带");
  assert.ok(existsSync(join(repo, "wip.txt")), "用户 checkout 材料原地保留");
  assert.equal(
    readFileSync(join(output.worktree_path, "README.md"), "utf-8").replace(/\r\n/g, "\n"),
    "# fleet repo\n",
  );

  // 台账：临时键 tombstone（released），childSessionId 持有 active 绑定（重键完成）。
  const bindings = await h.ledger.load();
  const childBinding = bindings.find((b) => b.sessionId === output.session_id);
  assert.ok(childBinding, "台账键 = childSessionId");
  assert.equal(childBinding.state, "active");
  assert.equal(childBinding.branch, output.branch);
  const tempActive = bindings.filter(
    (b) => b.sessionId.startsWith("fleet_") && b.state === "active",
  );
  assert.equal(tempActive.length, 0, "临时键已 tombstone（无 active 残留；tombstone 行按台账语义保留）");
  const tempTomb = bindings.find((b) => b.sessionId.startsWith("fleet_"));
  assert.equal(tempTomb?.state, "tombstone", "临时键折叠后是 tombstone（released）");

  // 围栏重绑到 child：按 worktree 路径查得的绑定 sessionId = childSessionId
  // （child 自己的 EnterSessionWorktree 会得到 already_in_session_worktree，
  // MergeBaseBranch/Reap 的键一致性与波次 2 语义对齐）。
  const fence = lookupSessionWorktreeFenceBinding(output.worktree_path);
  assert.ok(fence, "围栏在场");
  assert.equal(fence.sessionId, output.session_id, "围栏重绑到 child 会话");

  // 舰队记录登记 worktree 事实（归档级联的共享判定依据）。
  const record = h.registry.get(output.session_id);
  assert.equal(record.worktree.path, output.worktree_path);
  assert.equal(record.worktree.branch, output.branch);
});

test("(场景8) 非 git 仓 → worktree_rejected（enter 闭集 reason 透传），零进程面消耗", async () => {
  const plain = tempDir("acode-fleet-plain-");
  const h = makeHarness(plain);
  const output = await h.startEntry.handler(
    { title: "no repo", prompt: "work", use_worktree: true },
    h.context,
  );
  assert.equal(output.outcome, "rejected");
  assert.equal(output.reason, "worktree_rejected");
  assert.match(output.message, /not_git_repo/);
  assert.equal(h.subagentPort.launchCalls.length, 0, "拒绝先于 launch");
  assert.equal(h.registry.listByLauncher("sess_wt-launcher").length, 0);
});

test("(场景8) launch 失败 → 临时键回收：无孤儿绑定、围栏解绑、worktree 本体删除", async () => {
  const repo = createRealRepo();
  const h = makeHarness(repo, { failLaunch: new Error("provider down") });

  await assert.rejects(
    () =>
      h.startEntry.handler(
        { title: "doomed isolation", prompt: "work", use_worktree: true },
        h.context,
      ),
    /provider down/,
  );

  const bindings = await h.ledger.load();
  assert.equal(
    bindings.filter((b) => b.state === "active").length,
    0,
    "临时键 tombstone，无 active 孤儿绑定",
  );
  // 围栏解绑 + worktree 本体 best-effort 删除（git 登记面同步 prune）。
  const remaining = git(["worktree", "list", "--porcelain"], repo);
  assert.ok(!remaining.includes("doomed-isolation"), "worktree 本体已回收");
  assert.equal(h.registry.listByLauncher("sess_wt-launcher").length, 0, "失败不确立所有权");
});

test("(场景8 补充) use_worktree 缺席 → child 在发起者当前目录启动，台账零新增", async () => {
  const repo = createRealRepo();
  const h = makeHarness(repo);
  const output = await h.startEntry.handler({ title: "shared cwd", prompt: "work" }, h.context);
  assert.equal(output.outcome, "started");
  assert.equal(output.worktree_path, undefined);
  assert.equal(h.subagentPort.launchCalls[0].workingDirectory, repo);
  const bindings = await h.ledger.load();
  assert.equal(bindings.length, 0);
});
