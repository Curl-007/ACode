import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { promisify } from "node:util";
import {
  cleanupMemberWorktree,
  createMemberWorktree,
  mergeMemberWorktree,
} from "../src/worktree/manager.js";
import {
  WORKTREES_RELATIVE_DIR,
  isManagedWorktreeBranch,
  isManagedWorktreePath,
  planMemberWorktreeName,
} from "../src/worktree/naming.js";
import { TeamStore } from "../src/state/store.js";
import { createToolContext, type ToolContext } from "../src/tools/registry.js";
import { teamTools } from "../src/tools/team.js";
import { memberTools } from "../src/tools/members.js";
import { taskTools } from "../src/tools/tasks.js";
import { messageTools } from "../src/tools/messages.js";
import { worktreeTools } from "../src/tools/worktree.js";
import { subagentSessionIdForAgent } from "../src/identity.js";
import { DEFAULT_MAX_REASSIGN_ROUNDS } from "../src/state/types.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, windowsHide: true });
  return stdout;
}

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agent-teams-wt-"));
  await git(dir, ["init", "-q", "-b", "main"]);
  await git(dir, ["config", "user.name", "Agent Teams Test"]);
  await git(dir, ["config", "user.email", "teams@example.com"]);
  await git(dir, ["config", "commit.gpgsign", "false"]);
  await writeFile(join(dir, "shared.txt"), "base\n");
  await git(dir, ["add", "."]);
  await git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

async function branchExists(repo: string, branch: string): Promise<boolean> {
  try {
    await git(repo, ["rev-parse", "--verify", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

describe("worktree naming and ownership", () => {
  it("builds <teamId>-<member>-<8hex> names and acode/wt branches", () => {
    const name = planMemberWorktreeName("team-abcd1234", "dev-1", "deadbeef");
    assert.equal(name, "team-abcd1234-dev-1-deadbeef");
  });

  it("sanitizes path-unsafe segments", () => {
    assert.equal(
      planMemberWorktreeName("team a/b", "dev.1", "cafebabe"),
      "team-a-b-dev-1-cafebabe",
    );
  });

  it("recognizes only the acode/wt namespace as ours", () => {
    assert.equal(isManagedWorktreeBranch("acode/wt/team-a-dev-1-deadbeef"), true);
    assert.equal(isManagedWorktreeBranch("acode/session/x"), false);
    assert.equal(isManagedWorktreeBranch("feature/x"), false);
  });

  it("recognizes only paths under .acode/worktrees as ours", () => {
    const repo = join(tmpdir(), "repo-root");
    assert.equal(isManagedWorktreePath(repo, join(repo, WORKTREES_RELATIVE_DIR, "x")), true);
    assert.equal(isManagedWorktreePath(repo, join(repo, "src", "x")), false);
    assert.equal(isManagedWorktreePath(repo, join(tmpdir(), "elsewhere", "x")), false);
  });
});

describe("member worktree lifecycle (real git)", () => {
  let repo: string;

  before(async () => {
    repo = await makeRepo();
  });

  after(async () => {
    await rm(repo, { force: true, recursive: true });
  });

  it("creates independent trees, branches and an idempotent exclude entry", async () => {
    const first = await createMemberWorktree({
      repoRoot: repo,
      baseBranch: "main",
      teamId: "team-aaaa0001",
      memberName: "dev-1",
    });
    const second = await createMemberWorktree({
      repoRoot: repo,
      baseBranch: "main",
      teamId: "team-aaaa0001",
      memberName: "dev-2",
    });
    assert.notEqual(first.path, second.path);
    assert.match(first.branch, /^acode\/wt\/team-aaaa0001-dev-1-[0-9a-f]{8}$/);
    assert.equal(
      (await git(first.path, ["rev-parse", "--abbrev-ref", "HEAD"])).trim(),
      first.branch,
    );
    const exclude = await readFile(join(repo, ".git", "info", "exclude"), "utf8");
    assert.equal(exclude.split(/\r?\n/).filter((line) => line === "/.acode/worktrees/").length, 1);
    assert.equal((await git(repo, ["status", "--porcelain"])).trim(), "");
  });

  it("snapshots uncommitted work on merge and is idempotent on repeat", async () => {
    const handle = await createMemberWorktree({
      repoRoot: repo,
      baseBranch: "main",
      teamId: "team-aaaa0002",
      memberName: "dev-1",
    });
    await writeFile(join(handle.path, "feature.txt"), "feature\n");
    const merged = await mergeMemberWorktree({
      repoRoot: repo,
      baseBranch: "main",
      handle,
      method: "merge",
    });
    assert.equal(merged.alreadyMerged, false);
    assert.equal(merged.noChanges, false);
    // Windows 下 core.autocrlf 可能把检出内容转成 CRLF；只比较语义内容。
    assert.equal(
      (await readFile(join(repo, "feature.txt"), "utf8")).replace(/\r\n/gu, "\n"),
      "feature\n",
    );
    assert.ok(existsSync(handle.path), "default merge keeps the member tree");

    const again = await mergeMemberWorktree({
      repoRoot: repo,
      baseBranch: "main",
      handle,
      method: "merge",
    });
    assert.equal(again.alreadyMerged, true);
    assert.equal(again.noChanges, true);
  });

  it("reports conflicts without touching the main workspace", async () => {
    const handle = await createMemberWorktree({
      repoRoot: repo,
      baseBranch: "main",
      teamId: "team-aaaa0003",
      memberName: "dev-1",
    });
    await writeFile(join(handle.path, "shared.txt"), "member\n");
    await git(handle.path, ["add", "."]);
    await git(handle.path, ["commit", "-q", "-m", "member change"]);
    await writeFile(join(repo, "shared.txt"), "captain\n");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-q", "-m", "captain change"]);
    const before = await readFile(join(repo, "shared.txt"), "utf8");

    await assert.rejects(
      mergeMemberWorktree({ repoRoot: repo, baseBranch: "main", handle, method: "merge" }),
      (error: unknown) => {
        const typed = error as { code?: string; data?: { conflicts?: string[] } };
        assert.equal(typed.code, "worktree_conflict");
        assert.ok(typed.data?.conflicts?.includes("shared.txt"));
        return true;
      },
    );
    assert.equal(await readFile(join(repo, "shared.txt"), "utf8"), before);
    assert.equal(existsSync(join(repo, ".git", "MERGE_HEAD")), false);
    assert.ok(existsSync(handle.path));
  });

  it("refuses to merge into a dirty main workspace", async () => {
    const handle = await createMemberWorktree({
      repoRoot: repo,
      baseBranch: "main",
      teamId: "team-aaaa0004",
      memberName: "dev-1",
    });
    await writeFile(join(handle.path, "dirty-merge.txt"), "x\n");
    await writeFile(join(repo, "shared.txt"), "uncommitted\n");
    await assert.rejects(
      mergeMemberWorktree({ repoRoot: repo, baseBranch: "main", handle, method: "merge" }),
      (error: unknown) => (error as { code?: string }).code === "worktree_dirty_workspace",
    );
    await git(repo, ["checkout", "--", "shared.txt"]);
  });

  it("refuses to merge when the main workspace is on another branch", async () => {
    const handle = await createMemberWorktree({
      repoRoot: repo,
      baseBranch: "main",
      teamId: "team-aaaa0005",
      memberName: "dev-1",
    });
    await writeFile(join(handle.path, "branch-guard.txt"), "x\n");
    await git(repo, ["checkout", "-q", "-b", "other"]);
    try {
      await assert.rejects(
        mergeMemberWorktree({ repoRoot: repo, baseBranch: "main", handle, method: "merge" }),
        (error: unknown) => (error as { code?: string }).code === "worktree_not_on_base_branch",
      );
    } finally {
      await git(repo, ["checkout", "-q", "main"]);
    }
  });

  it("keeps unmerged and dirty trees; removes clean merged ones", async () => {
    const unmerged = await createMemberWorktree({
      repoRoot: repo,
      baseBranch: "main",
      teamId: "team-aaaa0006",
      memberName: "dev-1",
    });
    await writeFile(join(unmerged.path, "unmerged.txt"), "x\n");
    await git(unmerged.path, ["add", "."]);
    await git(unmerged.path, ["commit", "-q", "-m", "unmerged work"]);
    const keptUnmerged = await cleanupMemberWorktree({
      repoRoot: repo,
      baseBranch: "main",
      handle: unmerged,
    });
    assert.equal(keptUnmerged.removed, false);
    assert.equal(keptUnmerged.keptReason, "unmerged");
    assert.ok(existsSync(unmerged.path));
    assert.ok(await branchExists(repo, unmerged.branch));

    const dirty = await createMemberWorktree({
      repoRoot: repo,
      baseBranch: "main",
      teamId: "team-aaaa0006",
      memberName: "dev-2",
    });
    await writeFile(join(dirty.path, "dirty.txt"), "x\n");
    await git(dirty.path, ["add", "."]);
    await git(dirty.path, ["commit", "-q", "-m", "dirty work"]);
    await writeFile(join(dirty.path, "dirty.txt"), "changed\n");
    const keptDirty = await cleanupMemberWorktree({
      repoRoot: repo,
      baseBranch: "main",
      handle: dirty,
    });
    assert.equal(keptDirty.keptReason, "dirty");
    assert.ok(existsSync(dirty.path));

    const merged = await createMemberWorktree({
      repoRoot: repo,
      baseBranch: "main",
      teamId: "team-aaaa0006",
      memberName: "dev-3",
    });
    await writeFile(join(merged.path, "merged.txt"), "x\n");
    await mergeMemberWorktree({
      repoRoot: repo,
      baseBranch: "main",
      handle: merged,
      method: "merge",
    });
    const cleaned = await cleanupMemberWorktree({
      repoRoot: repo,
      baseBranch: "main",
      handle: merged,
    });
    assert.equal(cleaned.removed, true);
    assert.equal(cleaned.branchRemoved, true);
    assert.equal(existsSync(merged.path), false);
    assert.equal(await branchExists(repo, merged.branch), false);
  });

  it("squash merge keeps the member branch (conservative cleanup)", async () => {
    const handle = await createMemberWorktree({
      repoRoot: repo,
      baseBranch: "main",
      teamId: "team-aaaa0007",
      memberName: "dev-1",
    });
    await writeFile(join(handle.path, "squash.txt"), "x\n");
    const merged = await mergeMemberWorktree({
      repoRoot: repo,
      baseBranch: "main",
      handle,
      method: "squash",
      cleanup: true,
    });
    assert.equal(merged.noChanges, false);
    assert.equal(merged.cleanup?.branchRemoved, false);
    assert.equal(merged.cleanup?.keptReason, "unmerged");
    assert.equal(merged.cleanup?.removed, false);
    assert.equal(await branchExists(repo, handle.branch), true);
    assert.ok(existsSync(handle.path), "unmerged squash keeps the tree too");
    assert.equal((await readFile(join(repo, "squash.txt"), "utf8")).replace(/\r\n/gu, "\n"), "x\n");
  });
});

const ALL_TOOLS = [...teamTools, ...memberTools, ...taskTools, ...messageTools, ...worktreeTools];
const tool = (name: string) => {
  const found = ALL_TOOLS.find((item) => item.name === name);
  assert.ok(found, `tool ${name} must exist`);
  return found;
};

function agentIdFor(name: string): string {
  return `agent_${name}`;
}

describe("AgentTeams integration (SPEC-015)", () => {
  let root: string;
  let repo: string;
  let store: TeamStore;

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
      maxActiveTeams: 4,
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
      maxActiveTeams: 4,
      panelUrl: undefined,
    });

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "agent-teams-wt-state-"));
    repo = await makeRepo();
    store = new TeamStore(root);
  });

  after(async () => {
    await rm(root, { force: true, recursive: true });
    await rm(repo, { force: true, recursive: true });
  });

  it("keeps isolation off by default and works outside git", async () => {
    const plain = await mkdtemp(join(tmpdir(), "agent-teams-plain-"));
    try {
      const context = createToolContext({
        store,
        identity: {
          sessionId: "session-captain",
          runtimeScope: "main",
          workspaceKey: "ws-key",
          degraded: false,
        },
        workspaceKey: "ws-key",
        workingDirectory: plain,
        maxMembers: 8,
        maxReassignRounds: DEFAULT_MAX_REASSIGN_ROUNDS,
        maxActiveTeams: 4,
        panelUrl: undefined,
      });
      const created = (await tool("agent_teams_create").handler(
        { goal: "no isolation" },
        context,
      )) as { teamId: string };
      await tool("agent_teams_add_member").handler(
        { name: "dev-1", role: "dev", charter: "c" },
        context,
      );
      const team = store.findTeam(created.teamId);
      assert.equal(team?.worktreeIsolation, undefined);
      assert.equal(team?.members[0]?.worktree, undefined);
      await tool("agent_teams_delete").handler({ teamId: created.teamId, archive: false }, context);
    } finally {
      await rm(plain, { force: true, recursive: true });
    }
  });

  it("rejects enabling isolation outside a git repository", async () => {
    const plain = await mkdtemp(join(tmpdir(), "agent-teams-plain-"));
    try {
      const context = createToolContext({
        store,
        identity: {
          sessionId: "session-captain",
          runtimeScope: "main",
          workspaceKey: "ws-key",
          degraded: false,
        },
        workspaceKey: "ws-key",
        workingDirectory: plain,
        maxMembers: 8,
        maxReassignRounds: DEFAULT_MAX_REASSIGN_ROUNDS,
        maxActiveTeams: 4,
        panelUrl: undefined,
      });
      await assert.rejects(
        tool("agent_teams_create").handler({ goal: "x", worktreeIsolation: true }, context),
        (error: unknown) => (error as { code?: string }).code === "worktree_unavailable",
      );
    } finally {
      await rm(plain, { force: true, recursive: true });
    }
  });

  it("creates a tree per member, carries the path in prompts/wake, merges and cleans up", async () => {
    const created = (await tool("agent_teams_create").handler(
      { goal: "isolated feature", worktreeIsolation: true },
      captain(),
    )) as { teamId: string; worktree_isolation: { enabled: boolean; baseBranch: string } };
    assert.equal(created.worktree_isolation.enabled, true);
    assert.equal(created.worktree_isolation.baseBranch, "main");

    const added = (await tool("agent_teams_add_member").handler(
      { name: "dev-1", role: "dev", charter: "implements" },
      captain(),
    )) as { spawn_instruction: { prompt: string } };
    const team = store.findTeam(created.teamId);
    const handle = team?.members[0]?.worktree;
    assert.ok(handle, "member worktree must be recorded");
    assert.ok(added.spawn_instruction.prompt.includes(handle.path));
    assert.ok(added.spawn_instruction.prompt.includes(handle.branch));

    await tool("agent_teams_bind_member").handler(
      { name: "dev-1", agentId: agentIdFor("dev-1") },
      captain(),
    );
    const task = (await tool("agent_teams_create_task").handler(
      { title: "build", objective: "write feature", acceptance: ["feature exists"] },
      captain(),
    )) as { taskId: string };
    const approved = (await tool("agent_teams_approve_plan").handler(
      { confirmation: "go" },
      captain(),
    )) as { next_actions: { wake: Array<{ message: string }> } };
    assert.ok(approved.next_actions.wake[0]?.message.includes(handle.path));

    const status = (await tool("agent_teams_status").handler({}, member("dev-1"))) as {
      worktree: { path: string } | null;
    };
    assert.equal(status.worktree?.path, handle.path);

    await writeFile(join(handle.path, "feature.txt"), "done\n");
    const claim = (await tool("agent_teams_claim_task").handler(
      { taskId: task.taskId },
      member("dev-1"),
    )) as { attempt_id: string };
    await tool("agent_teams_update_task").handler(
      {
        taskId: task.taskId,
        attemptId: claim.attempt_id,
        status: "done",
        summary: "implemented",
        verify: "file exists",
      },
      member("dev-1"),
    );

    const merged = (await tool("agent_teams_merge_member_worktree").handler(
      { member: "dev-1", method: "merge" },
      captain(),
    )) as { ok: boolean; commit: string; no_changes: boolean };
    assert.equal(merged.ok, true);
    assert.equal(merged.no_changes, false);
    assert.equal(
      (await readFile(join(repo, "feature.txt"), "utf8")).replace(/\r\n/gu, "\n"),
      "done\n",
    );
    assert.equal(store.findTeam(created.teamId)?.members[0]?.worktree?.status, "merged");

    const deleted = (await tool("agent_teams_delete").handler(
      { teamId: created.teamId, archive: true },
      captain(),
    )) as { worktrees: { removed: Array<{ member: string }>; retained: unknown[] } };
    assert.deepEqual(
      deleted.worktrees.removed.map((entry) => entry.member),
      ["dev-1"],
    );
    assert.equal(deleted.worktrees.retained.length, 0);
    assert.equal(existsSync(handle.path), false);
    assert.equal(await branchExists(repo, handle.branch), false);
  });

  it("rejects the merge tool for a team without isolation", async () => {
    const created = (await tool("agent_teams_create").handler(
      { goal: "plain team" },
      captain(),
    )) as { teamId: string };
    await assert.rejects(
      tool("agent_teams_merge_member_worktree").handler(
        { teamId: created.teamId, member: "dev-1" },
        captain(),
      ),
      (error: unknown) => (error as { code?: string }).code === "worktree_disabled",
    );
    await tool("agent_teams_delete").handler({ teamId: created.teamId, archive: false }, captain());
  });
});
