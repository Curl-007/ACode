import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { promisify } from "node:util";
import { TeamStore } from "../src/state/store.js";
import { createToolContext, type ToolContext } from "../src/tools/registry.js";
import { teamTools } from "../src/tools/team.js";
import { memberTools } from "../src/tools/members.js";
import { taskTools } from "../src/tools/tasks.js";
import { messageTools } from "../src/tools/messages.js";
import { worktreeTools } from "../src/tools/worktree.js";
import { reviewDiffTools } from "../src/tools/review-diff.js";
import { runChecksTools } from "../src/tools/run-checks.js";
import { waitForWorkTool } from "../src/tools/member-wait.js";
import { subagentSessionIdForAgent } from "../src/identity.js";
import { DEFAULT_MAX_REASSIGN_ROUNDS, type MemberWorktree } from "../src/state/types.js";
import {
  argvEquals,
  hasForbiddenTokenChars,
  normalizeArgv,
  parseVerifyDeclarations,
  resolveCommand,
  runBoundedCommand,
} from "../src/worktree/exec.js";

/**
 * 批次 0 验收工具面（R1）：`agent_teams_review_member_diff` / `agent_teams_run_checks`。
 * 验收场景 ①-⑥ 用真实 temp git 仓与真实工具（无 git 环境整体跳过）；声明解析 / Windows
 * 解析 / 有界输出等纯边界用单元断言。固定时钟 + 临时目录，不触网、不上报（EI-121）。
 */

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, windowsHide: true });
  return stdout;
}

function gitAvailable(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const GIT_AVAILABLE = gitAvailable();
const realGitDescribe = GIT_AVAILABLE ? describe : describe.skip;

async function makeRepo(): Promise<string> {
  const created = await mkdtemp(join(tmpdir(), "agent-teams-rev-"));
  // 与 worktree.test.ts 同因：Win tmpdir 可能是 8.3 短路径，规范成长路径以匹配 git 输出。
  const dir = await realpath(created);
  await git(dir, ["init", "-q", "-b", "main"]);
  await git(dir, ["config", "user.name", "Agent Teams Test"]);
  await git(dir, ["config", "user.email", "teams@example.com"]);
  await git(dir, ["config", "commit.gpgsign", "false"]);
  await writeFile(join(dir, "shared.txt"), "base\n");
  await git(dir, ["add", "."]);
  await git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

async function commitFile(
  cwd: string,
  name: string,
  content: string,
  message: string,
): Promise<void> {
  await writeFile(join(cwd, name), content);
  await git(cwd, ["add", "."]);
  await git(cwd, ["commit", "-q", "-m", message]);
}

const ALL_TOOLS = [
  ...teamTools,
  ...memberTools,
  ...taskTools,
  ...messageTools,
  ...worktreeTools,
  ...reviewDiffTools,
  ...runChecksTools,
  waitForWorkTool,
];

const tool = (name: string) => {
  const found = ALL_TOOLS.find((item) => item.name === name);
  assert.ok(found, `tool ${name} must exist`);
  return found;
};

function agentIdFor(name: string): string {
  return `agent_${name}`;
}

function rejectsWithCode(promise: Promise<unknown>, code: string): Promise<void> {
  return assert.rejects(promise, (error: unknown) => {
    const typed = error as { code?: string };
    assert.equal(typed.code, code, `expected error code ${code}, got ${typed.code ?? "<none>"}`);
    return true;
  });
}

interface ReviewResult {
  ok: boolean;
  teamId: string;
  member: string;
  branch: string;
  baseCommit: string;
  headCommit: string;
  branchHeadCommit: string;
  headIsBranchTip: boolean;
  files: Array<{ status: string; path: string; originalPath?: string }> | null;
  stat: string | null;
  diff: string | null;
  truncated: boolean;
  desync: boolean;
  task: { taskId: string; attemptId: string; status: string };
  notes: string[];
}

interface RunChecksResult {
  ok: boolean;
  teamId: string;
  member: string;
  command: string;
  cwd: string;
  exitCode: number;
  timedOut: boolean;
  stdout: string | null;
  stderr: string | null;
  truncated: boolean;
  desync: boolean;
  durationMs: number;
  task: { taskId: string; attemptId: string; status: string };
  notes: string[];
}

realGitDescribe("AgentTeams review/checks tools (batch 0, real git)", () => {
  let root: string;
  let repo: string;
  let store: TeamStore;
  let teamSeq = 0;

  const captain = (): ToolContext =>
    createToolContext({
      store,
      identity: {
        sessionId: "session-captain",
        runtimeScope: "main",
        workspaceKey: "ws-key",
        degraded: false,
      },
      workspaceKey: "ws-key",
      workingDirectory: repo,
      maxMembers: 8,
      maxReassignRounds: DEFAULT_MAX_REASSIGN_ROUNDS,
      maxActiveTeams: 32,
      panelUrl: undefined,
    });

  const member = (name: string): ToolContext =>
    createToolContext({
      store,
      identity: {
        sessionId: subagentSessionIdForAgent(agentIdFor(name)),
        runtimeScope: "subagent",
        workspaceKey: "ws-key",
        degraded: false,
      },
      memberNameHint: name,
      workspaceKey: "ws-key",
      workingDirectory: repo,
      maxMembers: 8,
      maxReassignRounds: DEFAULT_MAX_REASSIGN_ROUNDS,
      maxActiveTeams: 32,
      panelUrl: undefined,
    });

  async function call<T>(
    name: string,
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<T> {
    const result = await tool(name).handler(args, context);
    return result as unknown as T;
  }

  /** 建隔离团队 + 成员（含 worktree）+ 绑定 + 任务；默认由成员认领为 in_progress。 */
  async function setup(options?: { claim?: boolean }): Promise<{
    teamId: string;
    handle: MemberWorktree;
    taskId: string;
    attemptId: string;
  }> {
    teamSeq += 1;
    const created = await call<{ teamId: string }>(
      "agent_teams_create",
      { goal: `review fixture ${teamSeq}`, approval: "automatic", worktreeIsolation: true },
      captain(),
    );
    const teamId = created.teamId;
    await call(
      "agent_teams_add_member",
      { teamId, name: "dev-1", role: "dev", charter: "c" },
      captain(),
    );
    await call(
      "agent_teams_bind_member",
      { teamId, name: "dev-1", agentId: agentIdFor("dev-1") },
      captain(),
    );
    const task = await call<{ taskId: string }>(
      "agent_teams_create_task",
      { teamId, title: "build", objective: "o", acceptance: ["a"] },
      captain(),
    );
    const handle = store
      .findTeam(teamId)!
      .members.find((item) => item.name === "dev-1")!.worktree!;
    let attemptId = "";
    if (options?.claim !== false) {
      const claim = await call<{ attempt_id: string }>(
        "agent_teams_claim_task",
        { teamId, taskId: task.taskId },
        member("dev-1"),
      );
      attemptId = claim.attempt_id;
    }
    return { teamId, handle, taskId: task.taskId, attemptId };
  }

  /**
   * 自然路径（批次 1）：成员用 update_task(done, verify) 汇报 → 任务落到 in_review
   * （非终态，锚定仍有效）并写入 `$ ` 声明。review/run_checks 随后即按此锚定工作。
   */
  async function reportDone(
    fx: { teamId: string; taskId: string; attemptId: string },
    verify: string,
  ): Promise<void> {
    const updated = await call<{ status: string }>(
      "agent_teams_update_task",
      {
        teamId: fx.teamId,
        taskId: fx.taskId,
        attemptId: fx.attemptId,
        status: "done",
        summary: "delivered",
        verify,
      },
      member("dev-1"),
    );
    assert.equal(updated.status, "in_review");
  }

  /**
   * 直接写 verify 作为夹具：`$ ` 声明可经 update_task 自然写入，但「散文 verify」与
   * 「空 verify」在 acceptance 非空时无法经 update_task 表达，故这两类负向断言直接落盘。
   */
  function setVerify(teamId: string, taskId: string, verify: string): void {
    store.writeTask(teamId, taskId, (task) => {
      task.verify = verify;
    });
  }

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "agent-teams-rev-state-"));
    repo = await makeRepo();
    store = new TeamStore(root);
  });

  after(async () => {
    await rm(root, { force: true, recursive: true });
    await rm(repo, { force: true, recursive: true });
  });

  it("scenario 1: pins base to the worktree creation commit and head to the member branch tip", async () => {
    const fx = await setup();
    await commitFile(fx.handle.path, "feature-a.txt", "a\n", "member a");
    // 自然路径：成员汇报 → in_review（锚定有效），随后队长审。
    await reportDone(fx, "$ node -v");
    // 让主仓库 HEAD 前移：base 必须是建树时的 commit，不是主仓库当前 HEAD。
    await commitFile(repo, "main-advance.txt", "m\n", "captain advance");
    const mainHead = (await git(repo, ["rev-parse", "HEAD"])).trim();
    const branchTip = (await git(repo, ["rev-parse", `refs/heads/${fx.handle.branch}`])).trim();

    const review = await call<ReviewResult>(
      "agent_teams_review_member_diff",
      { teamId: fx.teamId, member: "dev-1" },
      captain(),
    );
    assert.equal(review.ok, true);
    assert.equal(review.baseCommit, fx.handle.baseCommit);
    assert.notEqual(review.baseCommit, mainHead);
    assert.equal(review.headCommit, branchTip);
    assert.equal(review.branchHeadCommit, branchTip);
    assert.equal(review.headIsBranchTip, true);
    assert.deepEqual(review.files?.map((file) => file.path), ["feature-a.txt"]);
    assert.equal(review.task.taskId, fx.taskId);
    assert.equal(review.task.attemptId, fx.attemptId);
    assert.equal(review.task.status, "in_review");
  });

  it("scenario 2: head follows new commits and an explicit old headRef pins the earlier delivery", async () => {
    const fx = await setup();
    await commitFile(fx.handle.path, "first.txt", "1\n", "first");
    await reportDone(fx, "$ node -v");
    const first = await call<ReviewResult>(
      "agent_teams_review_member_diff",
      { teamId: fx.teamId, member: "dev-1" },
      captain(),
    );
    // 成员在 review 之后又提交（OQ-9：in_review 期间继续在同一棵树里改）。
    await commitFile(fx.handle.path, "second.txt", "2\n", "second");
    const second = await call<ReviewResult>(
      "agent_teams_review_member_diff",
      { teamId: fx.teamId, member: "dev-1" },
      captain(),
    );
    assert.notEqual(second.headCommit, first.headCommit);
    assert.equal(second.headIsBranchTip, true);
    assert.deepEqual(second.files?.map((file) => file.path).sort(), ["first.txt", "second.txt"]);

    const pinned = await call<ReviewResult>(
      "agent_teams_review_member_diff",
      { teamId: fx.teamId, member: "dev-1", headRef: first.headCommit },
      captain(),
    );
    assert.equal(pinned.headCommit, first.headCommit);
    assert.equal(pinned.headIsBranchTip, false);
    assert.deepEqual(pinned.files?.map((file) => file.path), ["first.txt"]);
  });

  it("scenario 3: undeclared commands are refused and the executable is never run", async () => {
    const fx = await setup();
    await writeFile(
      join(fx.handle.path, "allowed.js"),
      "require('node:fs').writeFileSync('allowed-ran.txt','1')\n",
    );
    await writeFile(
      join(fx.handle.path, "blocked.js"),
      "require('node:fs').writeFileSync('blocked-ran.txt','1')\n",
    );
    setVerify(fx.teamId, fx.taskId, "Ran locally, see notes.\n$ node allowed.js\n");
    const blockedMarker = join(fx.handle.path, "blocked-ran.txt");
    const allowedMarker = join(fx.handle.path, "allowed-ran.txt");

    await rejectsWithCode(
      call(
        "agent_teams_run_checks",
        { teamId: fx.teamId, member: "dev-1", command: "node blocked.js" },
        captain(),
      ),
      "verify_required",
    );
    assert.equal(existsSync(blockedMarker), false, "undeclared command must not run");

    await rejectsWithCode(
      call(
        "agent_teams_run_checks",
        { teamId: fx.teamId, member: "dev-1", command: "node allowed.js && node blocked.js" },
        captain(),
      ),
      "invalid_input",
    );
    assert.equal(existsSync(blockedMarker), false, "shell-metachar command must not run");

    // 散文 verify（无 `$ ` 声明行）→ verify_required
    setVerify(fx.teamId, fx.taskId, "I ran the tests locally.");
    await rejectsWithCode(
      call(
        "agent_teams_run_checks",
        { teamId: fx.teamId, member: "dev-1", command: "node allowed.js" },
        captain(),
      ),
      "verify_required",
    );

    // 空 verify → verify_required
    setVerify(fx.teamId, fx.taskId, "");
    await rejectsWithCode(
      call(
        "agent_teams_run_checks",
        { teamId: fx.teamId, member: "dev-1", command: "node allowed.js" },
        captain(),
      ),
      "verify_required",
    );

    // 自然路径：成员汇报（写入 `$ ` 声明）→ in_review → 队长按声明执行成功。
    await reportDone(fx, "$ node allowed.js");
    const ok = await call<RunChecksResult>(
      "agent_teams_run_checks",
      { teamId: fx.teamId, member: "dev-1", command: "node allowed.js" },
      captain(),
    );
    assert.equal(ok.ok, true);
    assert.equal(ok.exitCode, 0);
    assert.equal(ok.cwd, fx.handle.path);
    assert.equal(ok.task.status, "in_review");
    // run_checks 落盘 lastCheck（面板 reviews[].check 的来源）。
    const task = store.readTask(fx.teamId, fx.taskId)!;
    assert.equal(task.lastCheck?.passed, true);
    assert.equal(task.lastCheck?.command, "node allowed.js");
    assert.equal(existsSync(allowedMarker), true, "declared command must run");
  });

  it("scenario 4: over-limit output is dropped whole with desync; statOnly omits the patch", async () => {
    const fx = await setup();
    await writeFile(
      join(fx.handle.path, "big.js"),
      "process.stdout.write('x'.repeat(300*1024))\n",
    );
    await reportDone(fx, "$ node big.js");
    const run = await call<RunChecksResult>(
      "agent_teams_run_checks",
      { teamId: fx.teamId, member: "dev-1", command: "node big.js" },
      captain(),
    );
    assert.equal(run.truncated, true);
    assert.equal(run.desync, true);
    assert.equal(run.stdout, null, "the over-limit stream is dropped whole, never half");
    assert.equal(typeof run.exitCode, "number");
    // 超限丢弃不冒充通过：lastCheck.passed 必须为 false。
    const overflowed = store.readTask(fx.teamId, fx.taskId)!;
    assert.equal(overflowed.lastCheck?.passed, false);
    assert.equal(overflowed.lastCheck?.truncated, true);

    // 统计路径仍在，只是补丁文本被省略（不是超限丢弃）。
    await rm(join(fx.handle.path, "big.js"), { force: true });
    await commitFile(fx.handle.path, "stat-only.txt", "s\n", "stat only");
    const review = await call<ReviewResult>(
      "agent_teams_review_member_diff",
      { teamId: fx.teamId, member: "dev-1", statOnly: true },
      captain(),
    );
    assert.equal(review.diff, null);
    assert.equal(review.truncated, false);
    assert.ok(review.stat);
    assert.deepEqual(review.files?.map((file) => file.path), ["stat-only.txt"]);
  });

  it("scenario 5: stale attempts refuse review/checks and run nothing", async () => {
    // (a) 打回（in_review --reassign--> todo）：旧 attempt 失效，声明过的命令零执行。
    const rework = await setup();
    await writeFile(
      join(rework.handle.path, "blocked.js"),
      "require('node:fs').writeFileSync('blocked-ran.txt','1')\n",
    );
    const marker = join(rework.handle.path, "blocked-ran.txt");
    await reportDone(rework, "$ node blocked.js");
    assert.equal(store.readTask(rework.teamId, rework.taskId)?.status, "in_review");
    // 打回前 review/run_checks 是通的（证明下面的 stale 确实来自打回，而不是别的原因）。
    const beforeReject = await call<ReviewResult>(
      "agent_teams_review_member_diff",
      { teamId: rework.teamId, member: "dev-1" },
      captain(),
    );
    assert.equal(beforeReject.ok, true);

    await call(
      "agent_teams_reassign_task",
      { teamId: rework.teamId, taskId: rework.taskId, assignee: "dev-1", reason: "rework" },
      captain(),
    );
    assert.equal(store.readTask(rework.teamId, rework.taskId)?.status, "todo");
    await rejectsWithCode(
      call("agent_teams_review_member_diff", { teamId: rework.teamId, member: "dev-1" }, captain()),
      "stale_attempt",
    );
    await rejectsWithCode(
      call(
        "agent_teams_run_checks",
        { teamId: rework.teamId, member: "dev-1", command: "node blocked.js" },
        captain(),
      ),
      "stale_attempt",
    );
    assert.equal(existsSync(marker), false, "a stale attempt must run nothing");

    // (b) 验收后（合并耦合 → done，真终态）：无活 attempt，review/run_checks 都 stale。
    const merged = await setup();
    await commitFile(merged.handle.path, "delivered.txt", "d\n", "deliver");
    await reportDone(merged, "$ node -v");
    const merge = await call<{ accepted_tasks: string[] }>(
      "agent_teams_merge_member_worktree",
      { teamId: merged.teamId, member: "dev-1" },
      captain(),
    );
    assert.deepEqual(merge.accepted_tasks, [merged.taskId]);
    assert.equal(store.readTask(merged.teamId, merged.taskId)?.status, "done");
    await rejectsWithCode(
      call("agent_teams_review_member_diff", { teamId: merged.teamId, member: "dev-1" }, captain()),
      "stale_attempt",
    );
    await rejectsWithCode(
      call(
        "agent_teams_run_checks",
        { teamId: merged.teamId, member: "dev-1", command: "node -v" },
        captain(),
      ),
      "stale_attempt",
    );
  });

  it("scenario 6a: admission boundary error codes are exhaustive", async () => {
    // worktree_disabled
    const plain = await call<{ teamId: string }>(
      "agent_teams_create",
      { goal: "plain", approval: "automatic" },
      captain(),
    );
    await rejectsWithCode(
      call("agent_teams_review_member_diff", { teamId: plain.teamId, member: "dev-1" }, captain()),
      "worktree_disabled",
    );
    await rejectsWithCode(
      call(
        "agent_teams_run_checks",
        { teamId: plain.teamId, member: "dev-1", command: "node -v" },
        captain(),
      ),
      "worktree_disabled",
    );

    // member_not_found
    const memberFx = await setup();
    await rejectsWithCode(
      call(
        "agent_teams_review_member_diff",
        { teamId: memberFx.teamId, member: "ghost" },
        captain(),
      ),
      "member_not_found",
    );
    await rejectsWithCode(
      call(
        "agent_teams_run_checks",
        { teamId: memberFx.teamId, member: "ghost", command: "node -v" },
        captain(),
      ),
      "member_not_found",
    );

    // worktree_not_found（手工清掉句柄，产品路径不会产生该形态）
    const noHandle = await setup();
    store.writeTeam(noHandle.teamId, (team) => {
      const target = team.members.find((item) => item.name === "dev-1")!;
      delete target.worktree;
    });
    await rejectsWithCode(
      call(
        "agent_teams_review_member_diff",
        { teamId: noHandle.teamId, member: "dev-1" },
        captain(),
      ),
      "worktree_not_found",
    );
    await rejectsWithCode(
      call(
        "agent_teams_run_checks",
        { teamId: noHandle.teamId, member: "dev-1", command: "node -v" },
        captain(),
      ),
      "worktree_not_found",
    );

    // 无活 attempt
    const idle = await setup({ claim: false });
    await rejectsWithCode(
      call("agent_teams_review_member_diff", { teamId: idle.teamId, member: "dev-1" }, captain()),
      "stale_attempt",
    );
    await rejectsWithCode(
      call(
        "agent_teams_run_checks",
        { teamId: idle.teamId, member: "dev-1", command: "node -v" },
        captain(),
      ),
      "stale_attempt",
    );

    // 成员被移除 → member_not_found（前置顺序：名册校验先于锚定；场景 5 的「已移除」按此码）
    const removed = await setup();
    await call(
      "agent_teams_remove_member",
      { teamId: removed.teamId, name: "dev-1", reason: "done with team" },
      captain(),
    );
    await rejectsWithCode(
      call(
        "agent_teams_review_member_diff",
        { teamId: removed.teamId, member: "dev-1" },
        captain(),
      ),
      "member_not_found",
    );
  });

  it("scenario 6b: ref resolution, declaration and command boundary error codes", async () => {
    const fx = await setup();
    await reportDone(fx, "$ node -v");
    await rejectsWithCode(
      call(
        "agent_teams_review_member_diff",
        { teamId: fx.teamId, member: "dev-1", baseRef: "no-such-ref" },
        captain(),
      ),
      "invalid_input",
    );
    await rejectsWithCode(
      call(
        "agent_teams_review_member_diff",
        { teamId: fx.teamId, member: "dev-1", headRef: "no-such-ref" },
        captain(),
      ),
      "invalid_input",
    );

    // 命令含通配 / 管道 → invalid_input（fail-closed），不执行
    for (const command of ["node *.js", "node -v | cat", "node -v > out.txt"]) {
      await rejectsWithCode(
        call("agent_teams_run_checks", { teamId: fx.teamId, member: "dev-1", command }, captain()),
        "invalid_input",
      );
    }

    // 命令不在声明集 → verify_required（复用同一错误码，OQ-8）
    await rejectsWithCode(
      call(
        "agent_teams_run_checks",
        { teamId: fx.teamId, member: "dev-1", command: "node --version" },
        captain(),
      ),
      "verify_required",
    );
    // 无 `$ ` 声明行（空 verify）→ verify_required
    setVerify(fx.teamId, fx.taskId, "");
    await rejectsWithCode(
      call(
        "agent_teams_run_checks",
        { teamId: fx.teamId, member: "dev-1", command: "node -v" },
        captain(),
      ),
      "verify_required",
    );

    // 显式 attemptId：不匹配 → stale_attempt；匹配当前（已汇报的）attempt 才放行
    await rejectsWithCode(
      call(
        "agent_teams_review_member_diff",
        { teamId: fx.teamId, member: "dev-1", attemptId: "00000000-0000-0000-0000-000000000000" },
        captain(),
      ),
      "stale_attempt",
    );
    const anchored = await call<ReviewResult>(
      "agent_teams_review_member_diff",
      { teamId: fx.teamId, member: "dev-1", attemptId: fx.attemptId },
      captain(),
    );
    assert.equal(anchored.task.attemptId, fx.attemptId);
  });
});

describe("declaration parsing and normalization (pure)", () => {
  it("collapses whitespace runs and splits on space/tab only", () => {
    assert.deepEqual(normalizeArgv("  pnpm \t typecheck   -w  "), ["pnpm", "typecheck", "-w"]);
    assert.deepEqual(normalizeArgv(""), []);
    assert.deepEqual(normalizeArgv("   "), []);
  });

  it("takes only `$ ` prefixed lines as machine declarations", () => {
    const verify = [
      "Ran locally, everything green.",
      "$ pnpm typecheck",
      "  $ indented is prose",
      "$   pnpm   test  ",
      "$",
      "$ ",
      "trailing prose",
    ].join("\n");
    assert.deepEqual(parseVerifyDeclarations(verify), [
      ["pnpm", "typecheck"],
      ["pnpm", "test"],
    ]);
    assert.deepEqual(parseVerifyDeclarations("no declarations here"), []);
    assert.deepEqual(parseVerifyDeclarations(undefined), []);
  });

  it("matches token sequences exactly and is case-sensitive", () => {
    assert.equal(argvEquals(["pnpm", "test"], ["pnpm", "test"]), true);
    assert.equal(argvEquals(["pnpm", "test"], ["pnpm"]), false);
    assert.equal(argvEquals(["pnpm", "test"], ["pnpm", "test", "-w"]), false);
    assert.equal(argvEquals(["PNPM", "test"], ["pnpm", "test"]), false);
  });

  it("rejects shell metacharacters, wildcards and control whitespace", () => {
    assert.equal(hasForbiddenTokenChars(["pnpm", "typecheck", "-w"]), false);
    for (const token of [
      "a&&b",
      "a|b",
      "a>b",
      "a<b",
      "a;b",
      "a*b",
      "a?b",
      "a$b",
      'a"b',
      "a'b",
      "a`b",
      "a\tb",
      "a\nb",
    ]) {
      assert.equal(hasForbiddenTokenChars([token]), true, `token ${token} must be rejected`);
    }
  });
});

describe("executable resolution (R1.3)", () => {
  it("resolves an extensionless executable via PATH (posix branch)", () => {
    const resolved = resolveCommand(["mytool"], {
      platform: "linux",
      pathEnv: "/opt/bin:/usr/bin",
      exists: (path) => path.endsWith("mytool"),
      isExecutable: () => true,
    });
    assert.ok(resolved);
    assert.equal(resolved?.viaShellHop, false);
    assert.equal(resolved?.file, resolved?.resolvedPath);
  });

  it("returns undefined when nothing matches", () => {
    const resolved = resolveCommand(["definitely-not-a-real-command-xyz"], {
      platform: "win32",
      pathEnv: "C:\\nope",
      exists: () => false,
    });
    assert.equal(resolved, undefined);
  });

  it("hops .cmd/.bat through cmd.exe with argv kept as separate elements", () => {
    const resolved = resolveCommand(["pnpm", "run", "test"], {
      platform: "win32",
      pathEnv: "C:\\tools",
      comspec: "cmd.exe",
      exists: (path) => path.toLowerCase().endsWith("pnpm.cmd"),
    });
    assert.ok(resolved);
    assert.equal(resolved?.viaShellHop, true);
    assert.equal(resolved?.file, "cmd.exe");
    assert.deepEqual(resolved?.args.slice(0, 3), ["/d", "/s", "/c"]);
    assert.ok(resolved?.args[3]?.toLowerCase().endsWith("pnpm.cmd"));
    assert.deepEqual(resolved?.args.slice(4), ["run", "test"]);
  });

  it("runs .exe directly without a shell hop", () => {
    const resolved = resolveCommand(["tool"], {
      platform: "win32",
      pathEnv: "C:\\tools",
      exists: (path) => path.toLowerCase().endsWith("tool.exe"),
    });
    assert.ok(resolved);
    assert.equal(resolved?.viaShellHop, false);
    assert.equal(resolved?.args.length, 0);
  });
});

describe("bounded command execution (real processes)", () => {
  it("drops an over-limit stream whole and flags desync", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-teams-exec-"));
    try {
      const command = resolveCommand([
        process.execPath,
        "-e",
        "process.stdout.write('x'.repeat(5000))",
      ]);
      assert.ok(command, "node must resolve");
      const result = await runBoundedCommand({
        command,
        cwd: dir,
        timeoutMs: 30_000,
        maxOutputBytes: 1024,
      });
      assert.equal(result.truncated, true);
      assert.equal(result.desync, true);
      assert.equal(result.stdout, null);
      assert.equal(typeof result.exitCode, "number");
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("marks a killed timeout as timedOut without throwing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-teams-exec-"));
    try {
      const command = resolveCommand([process.execPath, "-e", "setTimeout(() => {}, 5000)"]);
      assert.ok(command);
      const result = await runBoundedCommand({
        command,
        cwd: dir,
        timeoutMs: 300,
        maxOutputBytes: 256 * 1024,
      });
      assert.equal(result.timedOut, true);
      assert.equal(result.truncated, false);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("runs a real .exe directly (win32) and a .cmd through the cmd.exe hop", async () => {
    if (process.platform !== "win32") return;
    const dir = await mkdtemp(join(tmpdir(), "agent-teams-exec-"));
    try {
      const exe = resolveCommand([process.execPath, "-e", "process.stdout.write('direct')"]);
      assert.ok(exe);
      assert.equal(exe?.viaShellHop, false);
      assert.ok(exe?.resolvedPath.toLowerCase().endsWith(".exe"));
      const direct = await runBoundedCommand({
        command: exe!,
        cwd: dir,
        timeoutMs: 30_000,
        maxOutputBytes: 256 * 1024,
      });
      assert.equal(direct.exitCode, 0);
      assert.equal(direct.stdout, "direct");

      const cmdPath = join(dir, "probe.cmd");
      await writeFile(cmdPath, "@echo off\r\necho ran > marker.txt\r\n");
      const script = resolveCommand([cmdPath]);
      assert.ok(script);
      assert.equal(script?.viaShellHop, true);
      const hopped = await runBoundedCommand({
        command: script!,
        cwd: dir,
        timeoutMs: 30_000,
        maxOutputBytes: 256 * 1024,
      });
      assert.equal(hopped.exitCode, 0);
      assert.equal(existsSync(join(dir, "marker.txt")), true);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });
});