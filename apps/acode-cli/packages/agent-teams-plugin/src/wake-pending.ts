import type { TaskAttempt, TeamMessage, TeamState, TeamTask } from "./state/types.js";

/**
 * 待唤醒窄投影与事实集（apps/acode-cli/specs/host-team-wake.md R1/R3）。
 *
 * 从 panel-state.ts 抽出的独立叶模块（架构 ratchet 400 行上限：panel-state 承载投影组合，
 * 唤醒语义单列）。本模块是**纯派生投影**，无文件 IO，可从邮箱 + 任务事实完全重建（EI-48）；
 * 也是 wakePending（面板）与 agent_teams_wait_for_members（队长阻塞等待）的**唯一事实源**
 * （EI-2）。生产方只承载结构事实 + 有界摘要，成员原文永不内联（原文仍在磁盘 mailbox，
 * 经读边界包装后才进模型上下文）。
 */

/**
 * wakePending 的 messages / settledTasks 数组上限（R7）。与宿主 core `MAX_WAKE_EVENTS=8`
 * 同值——插件零 core 依赖，故自带一份（改值须两处同步）；与 MAX_PANEL_UNREAD_MESSAGES 是
 * 不同层（前者是唤醒触发集，后者是 UI 样本）。
 */
export const MAX_WAKE_EVENTS = 8;

/** 唤醒投影 messages 的结构事实（对齐宿主 core `TeamWakeMessageFact`；不含成员原文）。 */
export interface TeamPanelWakeMessage {
  messageId: string;
  from: string;
  kind: "report" | "question" | "escalation" | "note";
  deliveredAt: string;
}

/** 唤醒投影 settledTasks 的结构事实（对齐宿主 core `TeamWakeSettledTaskFact`）。 */
export interface TeamPanelWakeSettledTask {
  taskId: string;
  owner: string;
  status: "done" | "failed" | "blocked";
  at: string;
}

/** 待唤醒窄投影（R1）。teamId 取 TeamPanelState.teamId，本形状本身不含 teamId（宿主据此读）。 */
export interface TeamPanelWakePending {
  /** = TeamState.wakeSeq（单调，R3）；宿主据此防旧世代覆盖（EI-59）。 */
  generation: number;
  /** 路由目标 = team.captainSessionId。 */
  captainSessionId: string;
  /** 队长邮箱未读 + 成员 in_review 汇报，按投递序升序，≤ MAX_WAKE_EVENTS。 */
  messages: TeamPanelWakeMessage[];
  /** 成员名下已进终态且晚于 lastCaptainSeenAt 的任务，≤ MAX_WAKE_EVENTS。 */
  settledTasks: TeamPanelWakeSettledTask[];
  /** 去重后的原因集（⊆ message|settled_task|question|escalation）；空 = 宿主零行为。 */
  triggers: Array<"message" | "settled_task" | "question" | "escalation">;
  /** messages/settledTasks 被 MAX_WAKE_EVENTS 截断时置位（EI-9 诚实：计数另给）。 */
  truncated?: true;
  counts: { unreadMessages: number; unsettledMemberTasks: number };
}

const WAKE_MESSAGE_KINDS: ReadonlySet<string> = new Set([
  "report",
  "question",
  "escalation",
  "note",
]);

function normalizeWakeKind(kind: string | undefined): TeamPanelWakeMessage["kind"] {
  return kind && WAKE_MESSAGE_KINDS.has(kind) ? (kind as TeamPanelWakeMessage["kind"]) : "note";
}

/** 任务最新一次已收尾 attempt（R1：settledTasks.at = 最新 attempt.endedAt）。 */
function latestEndedAttempt(task: TeamTask): TaskAttempt | undefined {
  let latest: TaskAttempt | undefined;
  for (const attempt of task.attempts) {
    if (!attempt.endedAt) continue;
    if (!latest || (latest.endedAt ?? "").localeCompare(attempt.endedAt) < 0) latest = attempt;
  }
  return latest;
}

/**
 * 唤醒事实集（wakePending 与 wait_for_members 的单一实现，EI-2）。**未截断**——截断在下游
 * （面板投影按 MAX_WAKE_EVENTS，等待工具按需判定）。
 *
 * `isNewSinceAck`：从未被队长读取（ack 基准缺席/NaN）时全部视为新事件；若已读取，则只保留
 * 严格晚于该时刻的事实（读信即 durable ack，跨进程重放不产生第二次派工）。
 */
export interface TeamWakeFacts {
  /** 队长邮箱未读（结构事实，无正文）＋ 成员 in_review 汇报（派生），按投递序升序。 */
  messages: TeamPanelWakeMessage[];
  /** 成员名下已进终态（done|failed|blocked）且晚于 ack 的任务。 */
  settledTasks: TeamPanelWakeSettledTask[];
  unreadMessages: number;
  /** 未结算成员任务 = in_progress + in_review。 */
  unsettledMemberTasks: number;
  inProgressMemberTasks: number;
}

export function collectTeamWakeFacts(params: {
  team: TeamState;
  tasks: readonly TeamTask[];
  captainUnreadMessages?: readonly TeamMessage[];
  /**
   * 「已读」判定基准（ms epoch，可选）。缺省从 team.lastCaptainSeenAt 现算；显式传入用于
   * 调用方**在刷新 lastCaptainSeenAt 之前**捕获的 ack 时刻（wait_for_members，否则鉴权刷新
   * 写入的 now 会把一切新事实滤掉）。NaN（非空值）= 视为从未读取（全部视为新事件）。
   */
  sinceMs?: number;
}): TeamWakeFacts {
  const { team, tasks } = params;
  const ackMs =
    params.sinceMs ?? (team.lastCaptainSeenAt ? Date.parse(team.lastCaptainSeenAt) : Number.NaN);
  const isNewSinceAck = (iso: string | undefined): boolean => {
    if (!Number.isFinite(ackMs)) return true;
    const at = iso ? Date.parse(iso) : Number.NaN;
    return Number.isFinite(at) ? at > ackMs : false;
  };
  const unread = params.captainUnreadMessages ?? [];
  const mailboxFacts: TeamPanelWakeMessage[] = unread.map((message) => ({
    messageId: message.id,
    from: message.from,
    kind: normalizeWakeKind(message.kind),
    deliveredAt: message.deliveredAt,
  }));
  // in_review 汇报：OQ4 不双写邮箱，由任务事实派生（messageId = 汇报 attemptId，稳定唯一）。
  const reportFacts: TeamPanelWakeMessage[] = tasks
    .filter((task) => task.status === "in_review")
    .flatMap((task) => {
      const attempt = task.attempts.find((item) => item.id === task.activeAttemptId);
      if (!attempt?.endedAt || attempt.owner === "captain" || !isNewSinceAck(attempt.endedAt)) {
        return [];
      }
      return [
        {
          messageId: attempt.id,
          from: attempt.owner,
          kind: "report" as const,
          deliveredAt: attempt.endedAt,
        },
      ];
    });
  const messages = [...mailboxFacts, ...reportFacts].sort(
    (a, b) => a.deliveredAt.localeCompare(b.deliveredAt) || a.messageId.localeCompare(b.messageId),
  );
  const settledTasks: TeamPanelWakeSettledTask[] = tasks
    .filter(
      (task) => task.status === "done" || task.status === "failed" || task.status === "blocked",
    )
    .flatMap((task) => {
      const attempt = latestEndedAttempt(task);
      if (!attempt?.endedAt || attempt.owner === "captain" || !isNewSinceAck(attempt.endedAt)) {
        return [];
      }
      return [
        {
          taskId: task.taskId,
          owner: attempt.owner,
          status: task.status as TeamPanelWakeSettledTask["status"],
          at: attempt.endedAt,
        },
      ];
    });
  return {
    messages,
    settledTasks,
    unreadMessages: unread.length,
    unsettledMemberTasks: tasks.filter(
      (task) => task.status === "in_progress" || task.status === "in_review",
    ).length,
    inProgressMemberTasks: tasks.filter((task) => task.status === "in_progress").length,
  };
}

/**
 * 派生有界待唤醒投影（host-team-wake.md R1）。超 MAX_WAKE_EVENTS 截断并置 truncated；
 * counts 如实计数；archived 团队不产出（已结束不再唤醒，否则终态任务会派发对已结束团队的
 * 唤醒）。triggers 空 = 宿主零行为（emptiness guard）。
 */
export function buildTeamPanelWakePending(params: {
  team: TeamState;
  tasks: readonly TeamTask[];
  captainUnreadMessages?: readonly TeamMessage[];
}): TeamPanelWakePending | undefined {
  const { team, tasks } = params;
  if (team.status === "archived") return undefined;
  const facts = collectTeamWakeFacts({
    team,
    tasks,
    ...(params.captainUnreadMessages ? { captainUnreadMessages: params.captainUnreadMessages } : {}),
  });
  const messages = facts.messages.slice(0, MAX_WAKE_EVENTS);
  const settledTasks = facts.settledTasks.slice(0, MAX_WAKE_EVENTS);
  const triggers = new Set<TeamPanelWakePending["triggers"][number]>();
  if (messages.length > 0) triggers.add("message");
  for (const message of messages) {
    if (message.kind === "question") triggers.add("question");
    if (message.kind === "escalation") triggers.add("escalation");
  }
  if (settledTasks.length > 0) triggers.add("settled_task");
  const truncated =
    facts.messages.length > MAX_WAKE_EVENTS || facts.settledTasks.length > MAX_WAKE_EVENTS;
  return {
    generation: team.wakeSeq ?? 0,
    captainSessionId: team.captainSessionId,
    messages,
    settledTasks,
    triggers: [...triggers],
    ...(truncated ? { truncated: true as const } : {}),
    counts: {
      unreadMessages: facts.unreadMessages,
      unsettledMemberTasks: facts.unsettledMemberTasks,
    },
  };
}