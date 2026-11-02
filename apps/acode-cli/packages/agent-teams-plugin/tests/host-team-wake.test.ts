import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { TeamStore } from "../src/state/store.js";
import { createToolContext, type ToolContext } from "../src/tools/registry.js";
import { teamTools } from "../src/tools/team.js";
import { memberTools } from "../src/tools/members.js";
import { taskTools } from "../src/tools/tasks.js";
import { messageTools } from "../src/tools/messages.js";
import { waitForMembersTool, normalizeWaitForMembersTimeoutMs } from "../src/tools/member-wait-captain.js";
import { subagentSessionIdForAgent } from "../src/identity.js";
import {
  buildTeamPanelWakePending,
  collectTeamWakeFacts,
  MAX_WAKE_EVENTS,
  type TeamPanelWakePending,
} from "../src/wake-pending.js";
import { buildTeamPanelState } from "../src/panel-state.js";
import {
  DEFAULT_MAX_REASSIGN_ROUNDS,
  type TaskAttempt,
  type TeamMember,
  type TeamMessage,
  type TeamState,
  type TeamTask,
} from "../src/state/types.js";

/**
 * host-team-wake.md 插件侧（批次 3）：wakePending 生产、wakeSeq 世代号、队长侧阻塞等待。
 *
 * 本文件不导入宿主 core（插件零 core 依赖），因此「与宿主消费形状对齐」以**逐字段名断言**
 * 实现：形状常量锁死在 `collectTeamWakeFacts`/`buildTeamPanelWakePending` 的输出上，任何改
 * 字段名的重构会红。宿主侧解析器（`core/src/runtime/team-wake/owner.ts`
 * `parseTeamWakeIntents`）按同一组字段收窄（teamId 取 TeamPanelState.teamId，wakePending 本身
 * 不含 teamId；messages 空 ∧ settledTasks 空 → 零行为；triggers 空 → 零行为）。
 */

const CLOCK = "2020-01-01T00:00:00.000Z";

// ── 纯投影夹具 ────────────────────────────────────────────────────────────

function attempt(id: string, owner: string, endedAt?: string, outcome?: TaskAttempt["outcome"]): TaskAttempt {
  return { id, seq: 1, owner, startedAt: CLOCK, ...(endedAt ? { endedAt } : {}), ...(outcome ? { outcome } : {}) };
}

function task(overrides: { taskId: string } & Partial<TeamTask>): TeamTask {
  return {
    title: "t",
    objective: "o",
    acceptance: [],
    kind: "build",
    dependencies: [],
    status: "todo",
    attemptSeq: 0,
    attempts: [],
    revisions: [],
    createdAt: CLOCK,
    updatedAt: CLOCK,
    ...overrides,
  };
}

function member(name: string): TeamMember {
  return { name, role: "dev", charter: "c", status: "bound", addedAt: CLOCK };
}

function team(overrides: Partial<TeamState> = {}): TeamState {
  return {
    teamId: "team-wake0001",
    goal: "g",
    status: "active",
    captainSessionId: "session-captain",
    lastCaptainSeenAt: CLOCK,
    workspaceKey: "w",
    workspaceKeyDegraded: false,
    maxMembers: 8,
    createdAt: CLOCK,
    updatedAt: CLOCK,
    seq: 1,
    members: [member("dev-1")],
    ...overrides,
  };
}

function msg(id: string, from: string, kind?: TeamMessage["kind"], deliveredAt = CLOCK): TeamMessage {
  return { id, from, to: "captain", message: "body", deliveredAt, ...(kind ? { kind } : {}) };
}

describe("wakePending projection (host-team-wake R1)", () => {
  it("aligns field names one by one with the frozen host consumption shape", () => {
    const state = buildTeamPanelWakePending({
      team: team({ wakeSeq: 5 }),
      tasks: [
        task({
          taskId: "t-1",
          status: "done",
          assignee: "dev-1",
          activeAttemptId: "a9",
          attempts: [attempt("a9", "dev-1", "2020-01-01T00:02:00.000Z", "done")],
        }),
      ],
      captainUnreadMessages: [msg("m-1", "dev-1", "question", "2020-01-01T00:01:00.000Z")],
    })!;
    assert.ok(state, "wakePending must be produced for an active team with facts");
    // 顶层键：generation / captainSessionId / messages / settledTasks / triggers / counts（+ truncated）。
    assert.deepEqual(Object.keys(state).sort(), [
      "captainSessionId",
      "counts",
      "generation",
      "messages",
      "settledTasks",
      "triggers",
    ]);
    assert.equal(state.generation, 5, "generation === team.wakeSeq");
    assert.equal(state.captainSessionId, "session-captain");
    // messages 事实逐字段（对齐 core TeamWakeMessageFact）。
    assert.deepEqual(Object.keys(state.messages[0]!), ["messageId", "from", "kind", "deliveredAt"]);
    assert.equal(state.messages[0]!.messageId, "m-1");
    assert.equal(state.messages[0]!.from, "dev-1");
    assert.equal(state.messages[0]!.kind, "question");
    assert.equal(state.messages[0]!.deliveredAt, "2020-01-01T00:01:00.000Z");
    // settledTasks 事实逐字段（对齐 core TeamWakeSettledTaskFact）。
    assert.deepEqual(Object.keys(state.settledTasks[0]!), ["taskId", "owner", "status", "at"]);
    assert.equal(state.settledTasks[0]!.taskId, "t-1");
    assert.equal(state.settledTasks[0]!.owner, "dev-1");
    assert.equal(state.settledTasks[0]!.status, "done");
    assert.equal(state.settledTasks[0]!.at, "2020-01-01T00:02:00.000Z");
    // triggers ⊆ 宿主枚举且已去重。
    assert.deepEqual([...state.triggers].sort(), ["message", "question", "settled_task"]);
    assert.deepEqual(Object.keys(state.counts), ["unreadMessages", "unsettledMemberTasks"]);
    assert.equal(state.counts.unreadMessages, 1);
    assert.equal(state.truncated, undefined, "under the cap → truncated absent");
  });

  it("is absent (not rendered half a card) when the team is archived", () => {
    assert.equal(buildTeamPanelWakePending({ team: team({ status: "archived" }), tasks: [] }), undefined);
  });

  it("emits an empty-trigger projection (host zero-behaviour) when nothing is pending", () => {
    const state = buildTeamPanelWakePending({
      team: team({ wakeSeq: 0 }),
      tasks: [task({ taskId: "t-1", status: "todo" })],
    })!;
    assert.ok(state);
    assert.deepEqual(state.triggers, []);
    assert.deepEqual(state.messages, []);
    assert.deepEqual(state.settledTasks, []);
    assert.deepEqual(state.counts, { unreadMessages: 0, unsettledMemberTasks: 0 });
  });

  it("surfaces an in_review report as a report message fact, not a settled task", () => {
    const state = buildTeamPanelWakePending({
      team: team(),
      tasks: [
        task({
          taskId: "t-1",
          status: "in_review",
          assignee: "dev-1",
          activeAttemptId: "a1",
          attempts: [attempt("a1", "dev-1", "2020-01-01T00:03:00.000Z", "done")],
        }),
      ],
    })!;
    assert.deepEqual(state.messages, [
      { messageId: "a1", from: "dev-1", kind: "report", deliveredAt: "2020-01-01T00:03:00.000Z" },
    ]);
    assert.deepEqual(state.settledTasks, [], "in_review is NOT settled (batch-1 arbitration)");
    assert.deepEqual(state.triggers, ["message"]);
    assert.equal(state.counts.unsettledMemberTasks, 1, "in_review counts as unsettled");
  });

  it("does not re-project facts older than the captain's durable ack (lastCaptainSeenAt)", () => {
    const facts = collectTeamWakeFacts({
      team: team({ lastCaptainSeenAt: "2020-01-01T00:05:00.000Z" }),
      tasks: [
        task({
          taskId: "t-1",
          status: "done",
          attempts: [attempt("a1", "dev-1", "2020-01-01T00:02:00.000Z", "done")],
        }),
        task({
          taskId: "t-2",
          status: "in_review",
          activeAttemptId: "a2",
          attempts: [attempt("a2", "dev-1", "2020-01-01T00:03:00.000Z", "done")],
        }),
      ],
    });
    assert.deepEqual(facts.settledTasks, []);
    assert.deepEqual(facts.messages, []);
    // 但计数仍如实（未结算任务一直在）。
    assert.equal(facts.unsettledMemberTasks, 1);
  });

  it("truncates messages and settledTasks past MAX_WAKE_EVENTS and keeps honest counts", () => {
    const unread = Array.from({ length: MAX_WAKE_EVENTS + 4 }, (_, index) =>
      msg(`m-${index}`, "dev-1", "note", `2020-01-01T00:0${index % 10}:00.000Z`),
    );
    const settledTasks = Array.from({ length: MAX_WAKE_EVENTS + 1 }, (_, index) =>
      task({
        taskId: `t-${index}`,
        status: "done",
        attempts: [attempt(`a-${index}`, "dev-1", `2020-01-01T00:1${index % 10}:00.000Z`, "done")],
      }),
    );
    const state = buildTeamPanelWakePending({ team: team(), tasks: settledTasks, captainUnreadMessages: unread })!;
    assert.equal(state.messages.length, MAX_WAKE_EVENTS);
    assert.equal(state.settledTasks.length, MAX_WAKE_EVENTS);
    assert.equal(state.truncated, true);
    assert.equal(state.counts.unreadMessages, MAX_WAKE_EVENTS + 4, "counts stay honest, not capped");
  });

  it("is reachable through the panel snapshot and stays additive (v === 1)", () => {
    const snapshot = buildTeamPanelState({
      team: team({ wakeSeq: 3 }),
      tasks: [task({ taskId: "t-1", status: "in_review", activeAttemptId: "a1", attempts: [attempt("a1", "dev-1", "2020-01-01T00:03:00.000Z", "done")] })],
      captainUnreadMessages: [],
    });
    assert.equal(snapshot.v, 1);
    assert.equal(snapshot.wakePending?.generation, 3);
    assert.equal(snapshot.wakePending?.messages[0]?.kind, "report");
  });

  it("keeps a stable messageId (the reporting attemptId) so host ack dedup holds", () => {
    const buildOnce = (): TeamPanelWakePending =>
      buildTeamPanelWakePending({
        team: team({ wakeSeq: 4 }),
        tasks: [
          task({
            taskId: "t-1",
            status: "in_review",
            activeAttemptId: "a-claim-1",
            attempts: [attempt("a-claim-1", "dev-1", "2020-01-01T00:03:00.000Z", "done")],
          }),
        ],
      })!;
    assert.equal(buildOnce().messages[0]!.messageId, buildOnce().messages[0]!.messageId);
    assert.equal(buildOnce().messages[0]!.messageId, "a-claim-1");
  });
});

// ── wakeSeq 世代号（store-backed，真实工具） ────────────────────────────────

describe("wakeSeq generation counter (host-team-wake R3)", () => {
  let root: string;
  let store: TeamStore;
  let teamId: string;
  let attemptId: string;
  const captain = () => makeContext({ store, role: "captain" });
  const member = (name: string) => makeContext({ store, role: "member", memberName: name });
  const tool = (name: string) => {
    const found = ALL_TOOLS.find((item) => item.name === name);
    assert.ok(found, `tool ${name} must exist`);
    return found;
  };
  const wakeSeq = (): number => store.findTeam(teamId)?.wakeSeq ?? 0;

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "agent-teams-wakeseq-"));
    store = new TeamStore(root);
    teamId = ((await tool("agent_teams_create").handler({ goal: "wakeseq", approval: "automatic" }, captain())) as { teamId: string }).teamId;
    await tool("agent_teams_add_member").handler({ teamId, name: "dev-1", role: "dev", charter: "c" }, captain());
    await tool("agent_teams_bind_member").handler({ teamId, name: "dev-1", agentId: "agent_dev-1" }, captain());
    await tool("agent_teams_create_task").handler({ teamId, title: "build", objective: "o", acceptance: ["a"] }, captain());
    attemptId = ((await tool("agent_teams_claim_task").handler({ teamId, taskId: "t-1" }, member("dev-1"))) as { attempt_id: string }).attempt_id;
  });

  after(() => rmSync(root, { recursive: true, force: true }));

  it("starts at 0 and is a non-negative integer", () => {
    assert.equal(wakeSeq(), 0);
  });

  it("a member mailbox delivery increments the generation", async () => {
    const before = wakeSeq();
    await tool("agent_teams_send_message").handler({ teamId, to: "captain", message: "progress", kind: "report" }, member("dev-1"));
    assert.equal(wakeSeq(), before + 1);
  });

  it("a captain mailbox delivery does NOT increment the generation", async () => {
    const before = wakeSeq();
    await tool("agent_teams_send_message").handler({ teamId, to: "dev-1", message: "keep going" }, captain());
    assert.equal(wakeSeq(), before, "captain-sourced writes are not wake-level");
  });

  it("a member update_task report increments; the captain reading does not", async () => {
    const before = wakeSeq();
    await tool("agent_teams_update_task").handler(
      { teamId, taskId: "t-1", attemptId, status: "done", summary: "done", verify: "$ node -v" },
      member("dev-1"),
    );
    assert.equal(wakeSeq(), before + 1, "member report is wake-level");
    const afterReport = wakeSeq();
    await tool("agent_teams_status").handler({ teamId }, captain());
    assert.equal(wakeSeq(), afterReport, "captain read/ack does not bump the generation");
  });

  it("is monotonic across a sequence of member events", async () => {
    const seen: number[] = [wakeSeq()];
    await tool("agent_teams_send_message").handler({ teamId, to: "captain", message: "anything" }, member("dev-1"));
    seen.push(wakeSeq());
    await tool("agent_teams_send_message").handler({ teamId, to: "captain", message: "question", kind: "question" }, member("dev-1"));
    seen.push(wakeSeq());
    for (let index = 1; index < seen.length; index += 1) {
      assert.ok(seen[index]! > seen[index - 1]!, "wakeSeq must strictly increase on member events");
    }
  });
});

// ── agent_teams_wait_for_members（队长侧阻塞等待） ─────────────────────────

describe("agent_teams_wait_for_members (captain-side blocking wait)", () => {
  let root: string;
  let store: TeamStore;
  let teamId: string;
  const captain = () => makeContext({ store, role: "captain" });
  const member = (name: string) => makeContext({ store, role: "member", memberName: name });
  const tool = (name: string) => {
    const found = ALL_TOOLS.find((item) => item.name === name);
    assert.ok(found, `tool ${name} must exist`);
    return found;
  };
  const wait = (input: { until?: "any" | "all"; timeoutMs?: number }, context = captain()) =>
    tool("agent_teams_wait_for_members").handler({ teamId, ...input }, context) as Promise<{
      ok: boolean;
      until: string;
      timedOut: boolean;
      reasons: string[];
      unread_messages: Array<{ message: string }>;
      settled_tasks: Array<{ taskId: string; owner: string; status: string; at: string }>;
      counts: { unreadMessages: number; unsettledMemberTasks: number; inProgressMemberTasks: number };
    }>;

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "agent-teams-waitmem-"));
    store = new TeamStore(root);
    teamId = ((await tool("agent_teams_create").handler({ goal: "waitmem", approval: "automatic" }, captain())) as { teamId: string }).teamId;
    await tool("agent_teams_add_member").handler({ teamId, name: "dev-1", role: "dev", charter: "c" }, captain());
    await tool("agent_teams_bind_member").handler({ teamId, name: "dev-1", agentId: "agent_dev-1" }, captain());
  });

  after(() => rmSync(root, { recursive: true, force: true }));

  it("is captain-only (memberAllowed: false) and normalizes the timeout (clamp)", () => {
    assert.equal(tool("agent_teams_wait_for_members").memberAllowed, false);
    assert.equal(normalizeWaitForMembersTimeoutMs(undefined), 300_000);
    assert.equal(normalizeWaitForMembersTimeoutMs(null), 300_000);
    assert.equal(normalizeWaitForMembersTimeoutMs("nope"), 300_000);
    assert.equal(normalizeWaitForMembersTimeoutMs(-5), 1_000);
    assert.equal(normalizeWaitForMembersTimeoutMs(0), 1_000);
    assert.equal(normalizeWaitForMembersTimeoutMs(5_000), 5_000);
    assert.equal(normalizeWaitForMembersTimeoutMs(10_000_000), 480_000);
  });

  it("rejects a non-captain main session (forbidden_for_caller)", async () => {
    const stranger = makeContext({ store, role: "captain", sessionId: "session-other" });
    await assert.rejects(wait({}, stranger), (error: unknown) => (error as { code?: string }).code === "forbidden_for_caller");
  });

  it("until:all returns right away when no member task is in progress and no unread exists", async () => {
    const result = await wait({ until: "all" });
    assert.equal(result.ok, true);
    assert.equal(result.timedOut, false);
    assert.deepEqual(result.reasons, []);
    assert.equal(result.counts.inProgressMemberTasks, 0);
  });

  it("a member question returns immediately even under until:all and consumes the mailbox", async () => {
    await tool("agent_teams_send_message").handler(
      { teamId, to: "captain", message: "blocked: which branch?", kind: "question" },
      member("dev-1"),
    );
    const result = await wait({ until: "all" });
    assert.equal(result.timedOut, false, "question must return immediately, not wait");
    assert.ok(result.reasons.includes("question"));
    assert.equal(result.unread_messages.length, 1);
    assert.match(result.unread_messages[0]!.message, /Teammate message/, "read boundary is applied");
    assert.equal(store.listUnreadMessages(teamId, "captain").length, 0, "returning consumes the mailbox");
  });

  it("until:any returns on a member terminal task and reports it as settled", async () => {
    // 先建任务再走一条“失败”终态路径（无未读）。
    await tool("agent_teams_create_task").handler({ teamId, title: "build", objective: "o", acceptance: ["a"] }, captain());
    const attemptId = ((await tool("agent_teams_claim_task").handler({ teamId, taskId: "t-1" }, member("dev-1"))) as { attempt_id: string }).attempt_id;
    await tool("agent_teams_update_task").handler(
      { teamId, taskId: "t-1", attemptId, status: "failed", summary: "nope", failReason: "cannot" },
      member("dev-1"),
    );
    const result = await wait({ until: "any" });
    assert.equal(result.timedOut, false);
    assert.ok(result.reasons.includes("settled_member_task"));
    assert.equal(result.settled_tasks[0]?.taskId, "t-1");
    assert.equal(result.settled_tasks[0]?.status, "failed");
  });

  it("until:any times out when nothing new arrives (timedOut is not an error)", async () => {
    // t-1 已 failed 且已被上一条消费（lastCaptainSeenAt 已越过）→ 无新事实。
    const result = await wait({ until: "any", timeoutMs: 1 });
    assert.equal(result.ok, true);
    assert.equal(result.timedOut, true);
    assert.deepEqual(result.reasons, ["none"]);
  });

  it("until:all times out while a member task is in progress and does not consume unread", async () => {
    // 重新认领 → in_progress（until:all 不满足），并投一条 note（不触发立即返回）。
    await tool("agent_teams_create_task").handler({ teamId, title: "build2", objective: "o", acceptance: ["a"] }, captain());
    await tool("agent_teams_claim_task").handler({ teamId, taskId: "t-2" }, member("dev-1"));
    await tool("agent_teams_send_message").handler({ teamId, to: "captain", message: "note", kind: "note" }, member("dev-1"));
    const result = await wait({ until: "all", timeoutMs: 1 });
    assert.equal(result.timedOut, true);
    assert.deepEqual(result.reasons, ["none"]);
    assert.equal(result.counts.inProgressMemberTasks, 1);
    assert.equal(store.listUnreadMessages(teamId, "captain").length, 1, "timeout must not consume the mailbox");
    assert.equal(store.findTeam(teamId)?.captainWaitingUntil, undefined, "waiting flag cleared on return");
  });
});

// ── 工具上下文夹具（与 tools.test.ts 同纪律：只走真实 bind 身份推导） ─────────

const ALL_TOOLS = [
  ...teamTools,
  ...memberTools,
  ...taskTools,
  ...messageTools,
  waitForMembersTool,
];

function makeContext(params: {
  store: TeamStore;
  role: "captain" | "member";
  memberName?: string;
  sessionId?: string;
}): ToolContext {
  const sessionId =
    params.sessionId ??
    (params.role === "captain"
      ? "session-captain"
      : subagentSessionIdForAgent(`agent_${params.memberName ?? ""}`));
  return createToolContext({
    store: params.store,
    identity: {
      sessionId,
      runtimeScope: params.role === "captain" ? "main" : "subagent",
      workspaceKey: "ws-key",
      degraded: false,
    },
    memberNameHint: params.memberName,
    workspaceKey: "ws-key",
    workingDirectory: process.cwd(),
    maxMembers: 8,
    maxReassignRounds: DEFAULT_MAX_REASSIGN_ROUNDS,
    maxActiveTeams: 4,
    panelUrl: "http://127.0.0.1:0/",
  });
}