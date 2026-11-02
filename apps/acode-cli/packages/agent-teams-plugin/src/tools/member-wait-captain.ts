import { z } from "zod";
import type { ToolContext, ToolDefinition, ToolResult } from "./registry.js";
import { TEAM_ID_PATTERN } from "../state/helpers.js";
import type { TeamMessage, TeamState, TeamTask } from "../state/helpers.js";
import { computeNextActions } from "../scheduler.js";
import { TEAM_TRUST_NOTE, wrapTeamMessageBodies } from "../trust-wrapper.js";
import { collectTeamWakeFacts, type TeamWakeFacts } from "../wake-pending.js";

/**
 * 队长等成员（host-team-wake.md 接口节，队长专属）：队长阻塞等待成员事件，替代「反复调
 * agent_teams_status / 空转轮询」。阻塞期间不占 server 互斥锁（manageOwnLock：锁内探测一次、
 * 锁外睡 2s），等待上限须小于 .mcp.json 的 timeoutMs（600s）；超时**不是错误**，返回
 * timedOut:true 由队长再调一次继续等（同成员侧 wait_for_work 的纪律）。
 *
 * 事件集与面板 wakePending 同源（collectTeamWakeFacts，EI-2）：队长邮箱未读 / 成员名下任务
 * 进终态 / 成员 in_review 汇报。`until:"all"` 定义写死为「无进行中任务且无队长未读消息」，
 * 而非「所有成员已汇报」——没有任务的成员永远不汇报，后者会与阻塞在 wait_for_work 的空闲
 * 成员互等死锁。成员提问/上报（question/escalation）一律**立即返回**，不因 until 取值等待。
 */

const WAIT_FOR_MEMBERS_DEFAULT_MS = 300_000;
const WAIT_FOR_MEMBERS_MIN_MS = 1_000;
const WAIT_FOR_MEMBERS_MAX_MS = 480_000;
const WAIT_FOR_MEMBERS_POLL_INTERVAL_MS = 2_000;

/**
 * timeoutMs clamp（host-team-wake.md R7 / EI-6）：**没配过**（缺席/不可解析）回落默认 5 min；
 * **配了但越界**夹到 [1s, 8min]。两分支分开，任何分支都不会产生「0 即立即超时」的退化调用。
 */
export function normalizeWaitForMembersTimeoutMs(value: unknown): number {
  if (value === undefined || value === null) return WAIT_FOR_MEMBERS_DEFAULT_MS;
  const raw = typeof value === "number" ? value : Number.parseFloat(String(value).trim());
  if (!Number.isFinite(raw)) return WAIT_FOR_MEMBERS_DEFAULT_MS;
  return Math.min(Math.max(Math.trunc(raw), WAIT_FOR_MEMBERS_MIN_MS), WAIT_FOR_MEMBERS_MAX_MS);
}

const waitForMembersSchema = z
  .object({
    teamId: z.string().regex(TEAM_ID_PATTERN).optional(),
    until: z.enum(["any", "all"]).default("any"),
    timeoutMs: z.number().optional(),
  })
  .strict();

type UntilMode = "any" | "all";
type WaitReason =
  | "captain_unread_message"
  | "question"
  | "escalation"
  | "settled_member_task"
  | "member_reported"
  | "member_waiting"
  | "none";

interface MembersProbe {
  shouldReturn: boolean;
  reasons: WaitReason[];
  unread: TeamMessage[];
  facts: TeamWakeFacts;
  waitingMembers: string[];
  team: TeamState;
  tasks: TeamTask[];
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function messageKind(message: TeamMessage): string {
  return message.kind ?? "note";
}

/** 锁外调用方已持锁外；本函数纯读，不写盘（读信置 read 在返回分支单独做）。 */
function probeMembers(
  context: ToolContext,
  team: TeamState,
  until: UntilMode,
  ackMs: number,
): MembersProbe {
  const unread = context.store.listUnreadMessages(team.teamId, "captain");
  const tasks = context.store.readTasks(team.teamId);
  const facts = collectTeamWakeFacts({ team, tasks, captainUnreadMessages: unread, sinceMs: ackMs });
  const hasQuestion = unread.some((message) => messageKind(message) === "question");
  const hasEscalation = unread.some((message) => messageKind(message) === "escalation");
  const waitingMembers = team.members
    .filter((member) => {
      const waitingUntilMs = member.waitingUntil ? Date.parse(member.waitingUntil) : Number.NaN;
      return Number.isFinite(waitingUntilMs) && waitingUntilMs > Date.now();
    })
    .map((member) => member.name);

  const hasReport = facts.messages.some((message) => message.kind === "report");
  const hasNewFact = facts.unreadMessages > 0 || facts.settledTasks.length > 0 || hasReport;
  const allSettled = facts.inProgressMemberTasks === 0 && facts.unreadMessages === 0;
  // 提问/上报（question/escalation）无论 until 取值一律立即返回：防「提问的成员 ↔ 等待的
  // 队长」互等死锁（成员已阻塞，队长再等成员就是双等）。
  const immediate = hasQuestion || hasEscalation;
  const shouldReturn = immediate || (until === "any" ? hasNewFact : allSettled);

  const reasons: WaitReason[] = [];
  if (facts.unreadMessages > 0) reasons.push("captain_unread_message");
  if (hasQuestion) reasons.push("question");
  if (hasEscalation) reasons.push("escalation");
  if (facts.settledTasks.length > 0) reasons.push("settled_member_task");
  if (hasReport) reasons.push("member_reported");
  if (reasons.length === 0 && waitingMembers.length > 0) reasons.push("member_waiting");
  return { shouldReturn, reasons, unread, facts, waitingMembers, team, tasks };
}

function markCaptainWaiting(context: ToolContext, teamId: string, until: string): void {
  context.store.writeTeam(teamId, (team) => {
    team.captainWaitingUntil = until;
  });
}

function clearCaptainWaiting(context: ToolContext, teamId: string): void {
  context.store.writeTeam(teamId, (team) => {
    delete team.captainWaitingUntil;
  });
}

function buildReturn(
  context: ToolContext,
  probe: MembersProbe,
  until: UntilMode,
  timedOut: boolean,
): ToolResult {
  const { facts } = probe;
  return {
    ok: true,
    teamId: probe.team.teamId,
    until,
    timedOut,
    reasons: timedOut ? ["none"] : probe.reasons,
    // 读边界：mailbox 正文由其他模型撰写，返回前套信任边界（R4/R6）；超时不读信（不消费）。
    unread_messages: timedOut ? [] : wrapTeamMessageBodies(probe.unread),
    settled_tasks: timedOut ? [] : facts.settledTasks,
    waiting_members: probe.waitingMembers,
    counts: {
      unreadMessages: facts.unreadMessages,
      unsettledMemberTasks: facts.unsettledMemberTasks,
      inProgressMemberTasks: facts.inProgressMemberTasks,
    },
    next_actions: computeNextActions({
      team: probe.team,
      tasks: probe.tasks,
      perspective: "captain",
    }),
    trust_note: TEAM_TRUST_NOTE,
    ...(timedOut
      ? {
          notes: [
            "No member event within the wait window; call agent_teams_wait_for_members again to keep waiting (or agent_teams_status to inspect state).",
          ],
        }
      : {}),
    ...context.identityWarning(),
  };
}

export const waitForMembersTool: ToolDefinition = {
  name: "agent_teams_wait_for_members",
  description:
    "Captain only. Block until a member event arrives instead of polling agent_teams_status: returns as soon as a member leaves an unread message, a task under a member reaches a terminal state (done/failed/blocked), or a member reports work awaiting acceptance (in_review). until:'any' (default) returns on the first such event; until:'all' returns only when no member task is in_progress and you have no unread messages. A member question/escalation returns immediately regardless of until (prevents the questioner and the waiting captain from deadlocking). Returns timedOut:true after ~8 minutes with nothing new — not an error; call it again to keep waiting. Reading consumes the mailbox (marks it read).",
  schema: waitForMembersSchema,
  memberAllowed: false,
  manageOwnLock: true,
  async handler(input, context): Promise<ToolResult> {
    const parsed = waitForMembersSchema.parse(input);
    const timeoutMs = normalizeWaitForMembersTimeoutMs(parsed.timeoutMs);
    // 初始锁：解析团队 + 队长鉴权（刷新 lastCaptainSeenAt）+ 捕获**刷新前**的 ack 时刻。
    const init = await context.store.withLock(() => {
      const team = context.resolveTeamContext(parsed.teamId);
      context.requireCaptain(team);
      const ackMs = team.lastCaptainSeenAt ? Date.parse(team.lastCaptainSeenAt) : Number.NaN;
      return {
        teamId: team.teamId,
        until: parsed.until,
        ackMs,
        deadline: Date.now() + timeoutMs,
      };
    });
    let marked = false;
    try {
      for (;;) {
        // 每次探测锁内重解析（团队归档中途 → team_archived 冒泡给队长），但不重复刷新 ack：
        // 用 init.ackMs 判定「新事实」，否则 requireCaptain 刚写入的 now 会把一切都滤掉。
        const probe = await context.store.withLock(() => {
          const team = context.resolveTeamContext(init.teamId);
          const current = probeMembers(context, team, init.until, init.ackMs);
          if (current.shouldReturn) {
            // 读信即置 read（队长 ack）+ 清除「队长在等」标记。
            const ids = current.unread.map((message) => message.id);
            if (ids.length > 0) context.store.markMessagesRead(team.teamId, "captain", ids);
            if (marked) clearCaptainWaiting(context, team.teamId);
          } else if (!marked) {
            markCaptainWaiting(context, team.teamId, new Date(init.deadline).toISOString());
            marked = true;
          }
          return current;
        });
        if (probe.shouldReturn) return buildReturn(context, probe, init.until, false);
        if (Date.now() + WAIT_FOR_MEMBERS_POLL_INTERVAL_MS >= init.deadline) {
          return buildReturn(context, probe, init.until, true);
        }
        await sleep(WAIT_FOR_MEMBERS_POLL_INTERVAL_MS);
      }
    } finally {
      if (marked) {
        // 团队在等待期间被归档（目录搬走）时清理标记会失败：标记随归档失效，忽略。
        await context.store
          .withLock(() => clearCaptainWaiting(context, init.teamId))
          .catch(() => undefined);
      }
    }
  },
};