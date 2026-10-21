/**
 * AgentTeams 团队卡的模型层：pluginStates 快照的受检投影。
 *
 * 从 conversationStatusPanelModel.ts 拆出来单独成文件，理由是这条链已经自成一体——
 * 「通用插件状态通道 → 按 TeamPanelState v1 形状收窄 → 团队卡模型」与状态面板的其余
 * 分区（Git / Goal / Plan / Workflow / Subagent）没有任何共享状态，只是恰好被同一个
 * builder 调用。拆开后两边各自在 400 行约束内，也不必为了塞下团队收窄而压缩别处的注释。
 *
 * 宿主不解释插件状态（通道通用），这里按形状逐字段校验——形状不符返回 null，不渲染
 * 半张卡。状态面板的团队卡与 Side Pane 的团队面板共用本模块的收窄结果：两边必须对
 * 同一份快照给出同一个「有没有团队」结论，各算一遍迟早漂移。
 *
 * 「已结束」判据放这里而不是 teamWorkflowPresentation.ts：`conversationStatusPanelModel`
 * 要用它过滤主区，而 presentation 反过来依赖本模型的类型——判据留在本文件，
 * 依赖方向才是单向的（本文件不 import 任何 UI 模块）。
 */

/** AgentTeams 团队卡的任务行。字段即插件 TeamPanelState.tasks 的投影。 */
export interface ConversationStatusPanelTeamTask {
  taskId: string;
  title: string;
  status: string;
  kind: string;
  dependencies: string[];
  assignee?: string;
}

export interface ConversationStatusPanelTeamMember {
  name: string;
  role: string;
  status: string;
  currentTaskId?: string;
  /** 已绑定成员的子会话 id（插件 0.3 additive）；缺席 = 不可打开成员会话。 */
  childSessionId?: string;
}

export interface ConversationStatusPanelTeamMailbox {
  address: string;
  unread: number;
  read: number;
}

export interface ConversationStatusPanelTeamMessage {
  id: string;
  from: string;
  to: string;
  summary?: string;
  message: string;
  deliveredAt: string;
}

/**
 * 派生字段（readyTaskIds / criticalPathDepth / blockedByFailedQuality / mailboxes /
 * unreadMessages / maxMembers）是插件的 additive 扩展：**缺席即默认值，不参与形状判定**。
 * 这个区别很关键——上面那些字段缺一个就整卡不显示，这几项缺了只是少画一块，旧版插件配
 * 新宿主仍能用。质量门语义（哪些 kind 算质量门）由插件在 blockedByFailedQuality 里算好，
 * 宿主不复制这份知识。
 */
export interface ConversationStatusPanelTeam {
  teamId: string;
  goal: string;
  status: string;
  panelUrl?: string;
  counts: { done: number; inProgress: number; todo: number; failed: number; blocked: number };
  totalCount: number;
  members: ConversationStatusPanelTeamMember[];
  tasks: ConversationStatusPanelTeamTask[];
  readyTaskIds: string[];
  hasTaskDerivations: boolean;
  criticalPathDepth: number;
  blockedByFailedQuality: Array<{ taskId: string; blockedBy: string[] }>;
  mailboxes: ConversationStatusPanelTeamMailbox[];
  unreadMessages: ConversationStatusPanelTeamMessage[];
  /** 名册上限；缺席（旧版插件）即 0，渲染层据此不显示「/8」的分母。 */
  maxMembers: number;
  /**
   * 该团队最近无更新（插件 0.2 additive：>48h 只标注不自动归档）。缺席即 false；
   * 不参与形状判定，与 maxMembers 同属「缺了只是少画一块」。
   */
  stale?: boolean;
  /** team.json 的 updatedAt（插件 0.3 additive）；缺席 = 不显示「最近更新」。 */
  updatedAt?: string;
  /** 结束时间（仅 recentEnded 条目携带）；缺席 = 不显示。 */
  endedAt?: string;
  /** 队长会话 id（插件 additive）；缺席（旧插件）= 无法判定归属，按「所有会话可见」处理。 */
  captainSessionId?: string;
}

/**
 * 团队卡归属判据：插件快照按工作区推送，同项目的每个会话都会收到全部团队。
 * 修复「A 会话建的团队出现在 B 会话里」：带 captainSessionId 的团队只在队长会话显示；
 * 未传会话（无归属上下文）或旧插件不带 captainSessionId 时不过滤。
 */
function isTeamOwnedBySession(
  team: ConversationStatusPanelTeam,
  ownerSessionId: string | null | undefined,
): boolean {
  if (!ownerSessionId || !team.captainSessionId) return true;
  return team.captainSessionId === ownerSessionId;
}

const AGENT_TEAMS_STATE_KEY_SUFFIX = ":agent-teams";

/**
 * 从 pluginStates 收窄 AgentTeams 团队卡（primary 单卡）。多个 agent-teams 插件身份
 * （不同 marketplace）按 key 字典序取第一个。多团队快照请用
 * buildConversationStatusPanelTeams。
 */
export function buildConversationStatusPanelTeam(
  pluginStates: Record<string, unknown> | null | undefined,
): ConversationStatusPanelTeam | null {
  const snapshot = pickAgentTeamsStateEntry(pluginStates);
  if (!snapshot) return null;
  return projectTeamCard(snapshot);
}

/**
 * 多团队（插件 0.2 additive `teams[]`）：快照携带 teams 数组时收窄为多张卡；
 * 缺席（旧插件）退回单卡（primary）。任一成员卡形状不符**整卡丢弃**（与单卡同一
 * 纪律：不渲染半张卡），全部不符则退回 primary 单卡——宁可少一张也不能把
 * 无效数据画出来。返回数组顺序即快照顺序（插件按 createdAt 排），模型不重排。
 */
export function buildConversationStatusPanelTeams(
  pluginStates: Record<string, unknown> | null | undefined,
  ownerSessionId?: string | null,
): ConversationStatusPanelTeam[] {
  const snapshot = pickAgentTeamsStateEntry(pluginStates);
  if (!snapshot) return [];
  const primary = projectTeamCard(snapshot);
  const rawTeams = snapshot.teams;
  const all = (() => {
    if (!Array.isArray(rawTeams) || rawTeams.length === 0) {
      return primary ? [primary] : [];
    }
    const teams = rawTeams.flatMap((raw): ConversationStatusPanelTeam[] => {
      if (typeof raw !== "object" || raw === null) return [];
      const card = projectTeamCard(raw as Record<string, unknown>);
      return card ? [card] : [];
    });
    return teams.length > 0 ? teams : primary ? [primary] : [];
  })();
  return all.filter((team) => isTeamOwnedBySession(team, ownerSessionId));
}

/**
 * 最近结束的团队（插件 0.3 additive `recentEnded[]`）：归档团队随即从 teams[]/primary
 * 消失，UI 的「已结束」桶只能从这里取。逐条按单卡形状校验，坏的条目丢弃（与 teams[]
 * 同一纪律：不渲染半张卡）；缺席（旧插件）返回空数组。顺序即快照顺序（结束时间倒序）。
 */
export function buildConversationStatusPanelEndedTeams(
  pluginStates: Record<string, unknown> | null | undefined,
  ownerSessionId?: string | null,
): ConversationStatusPanelTeam[] {
  const snapshot = pickAgentTeamsStateEntry(pluginStates);
  if (!snapshot) return [];
  const rawEnded = snapshot.recentEnded;
  if (!Array.isArray(rawEnded)) return [];
  return rawEnded.flatMap((raw): ConversationStatusPanelTeam[] => {
    if (typeof raw !== "object" || raw === null) return [];
    const card = projectTeamCard(raw as Record<string, unknown>);
    if (!card || !isTeamOwnedBySession(card, ownerSessionId)) return [];
    const endedAt = (raw as Record<string, unknown>).endedAt;
    return [typeof endedAt === "string" && endedAt ? { ...card, endedAt } : card];
  });
}

/**
 * 团队「已结束」判据（SPEC-012 §5.4）：已归档；或未归档但至少 1 个任务且全部为
 * done / cancelled。有 failed / blocked 的团队不算结束——它们需要队长或用户处理，
 * 不能收进「已结束」桶里藏起来。
 */
export function isTeamEnded(team: {
  status: string;
  tasks: ReadonlyArray<{ status: string }>;
}): boolean {
  if (team.status === "archived") return true;
  if (team.tasks.length === 0) return false;
  return team.tasks.every((task) => task.status === "done" || task.status === "cancelled");
}

/** 状态面板团队分区的三组事实：primary 卡、活跃卡、已结束桶。 */
export interface ConversationStatusPanelTeamSections {
  team: ConversationStatusPanelTeam | null;
  teams: ConversationStatusPanelTeam[];
  endedTeams: ConversationStatusPanelTeam[];
}

/** 团队分区的输入面：pluginStates 快照与当前会话归属。 */
export interface ConversationStatusPanelTeamSectionsInput {
  pluginStates?: Record<string, unknown> | null;
  sessionId?: string | null;
}

/**
 * 快照 → 两个桶（主区只放未结束的；recentEnded 与「未归档但全部结算」合并去重后进
 * 只读桶）。主区与侧栏都必须走这一处：两处各算一遍，迟早对同一份快照给出不同结论。
 */
export function buildConversationStatusPanelTeamSections(
  pluginStates: Record<string, unknown> | null | undefined,
  sessionId?: string | null,
): ConversationStatusPanelTeamSections {
  const endedFromSnapshot = buildConversationStatusPanelEndedTeams(pluginStates, sessionId);
  const all = buildConversationStatusPanelTeams(pluginStates, sessionId);
  const teams = all.filter((candidate) => !isTeamEnded(candidate));
  const endedInline = all.filter((candidate) => isTeamEnded(candidate));
  const endedIds = new Set(endedInline.map((candidate) => candidate.teamId));
  return {
    team: teams[0] ?? null,
    teams,
    endedTeams: [
      ...endedInline,
      ...endedFromSnapshot.filter((candidate) => !endedIds.has(candidate.teamId)),
    ],
  };
}

/** pluginStates 里按 key 过滤出 agent-teams 状态条目（多个身份取字典序第一个）。 */
function pickAgentTeamsStateEntry(
  pluginStates: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!pluginStates) return null;
  const entry = Object.entries(pluginStates)
    .filter(([key]) => key.startsWith("agent-teams@") && key.endsWith(AGENT_TEAMS_STATE_KEY_SUFFIX))
    .sort(([left], [right]) => left.localeCompare(right))[0];
  if (!entry) return null;
  const state = entry[1];
  if (typeof state !== "object" || state === null) return null;
  return state as Record<string, unknown>;
}

/** 单个团队快照 → 团队卡（形状不符返回 null，不渲染半张卡）。 */
function projectTeamCard(snapshot: Record<string, unknown>): ConversationStatusPanelTeam | null {
  if (snapshot.v !== 1) return null;
  if (typeof snapshot.teamId !== "string" || !snapshot.teamId) return null;
  if (typeof snapshot.goal !== "string") return null;
  if (typeof snapshot.status !== "string") return null;
  const countsSource = snapshot.counts;
  if (typeof countsSource !== "object" || countsSource === null) return null;
  const counts = countsSource as Record<string, unknown>;
  const numeric = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
  const projectedCounts = {
    done: numeric(counts.done) ?? 0,
    inProgress: numeric(counts.inProgress) ?? 0,
    todo: numeric(counts.todo) ?? 0,
    failed: numeric(counts.failed) ?? 0,
    blocked: numeric(counts.blocked) ?? 0,
  };
  const tasks = Array.isArray(snapshot.tasks)
    ? snapshot.tasks.flatMap((raw): ConversationStatusPanelTeamTask[] => {
        if (typeof raw !== "object" || raw === null) return [];
        const task = raw as Record<string, unknown>;
        if (typeof task.taskId !== "string" || !task.taskId) return [];
        return [
          {
            taskId: task.taskId,
            title: typeof task.title === "string" ? task.title : task.taskId,
            status: typeof task.status === "string" ? task.status : "todo",
            kind: typeof task.kind === "string" ? task.kind : "build",
            dependencies: Array.isArray(task.dependencies)
              ? task.dependencies.filter((dep): dep is string => typeof dep === "string")
              : [],
            ...(typeof task.assignee === "string" ? { assignee: task.assignee } : {}),
          },
        ];
      })
    : [];
  const members = Array.isArray(snapshot.members)
    ? snapshot.members.flatMap((raw): ConversationStatusPanelTeamMember[] => {
        if (typeof raw !== "object" || raw === null) return [];
        const member = raw as Record<string, unknown>;
        if (typeof member.name !== "string" || !member.name) return [];
        return [
          {
            name: member.name,
            role: typeof member.role === "string" ? member.role : "",
            status: typeof member.status === "string" ? member.status : "registered",
            ...(typeof member.currentTaskId === "string"
              ? { currentTaskId: member.currentTaskId }
              : {}),
            ...(typeof member.childSessionId === "string" && member.childSessionId
              ? { childSessionId: member.childSessionId }
              : {}),
          },
        ];
      })
    : [];
  const readyTaskIds = Array.isArray(snapshot.readyTaskIds)
    ? snapshot.readyTaskIds.filter((id): id is string => typeof id === "string" && id.length > 0)
    : [];
  const criticalPathDepth = numeric(snapshot.criticalPathDepth) ?? 0;
  const blockedByFailedQuality = Array.isArray(snapshot.blockedByFailedQuality)
    ? snapshot.blockedByFailedQuality.flatMap(
        (raw): Array<{ taskId: string; blockedBy: string[] }> => {
          if (typeof raw !== "object" || raw === null) return [];
          const item = raw as Record<string, unknown>;
          if (typeof item.taskId !== "string" || !item.taskId) return [];
          const blockedBy = Array.isArray(item.blockedBy)
            ? item.blockedBy.filter(
                (dep): dep is string => typeof dep === "string" && dep.length > 0,
              )
            : [];
          return blockedBy.length > 0 ? [{ taskId: item.taskId, blockedBy }] : [];
        },
      )
    : [];
  const mailboxes = Array.isArray(snapshot.mailboxes)
    ? snapshot.mailboxes.flatMap((raw): ConversationStatusPanelTeamMailbox[] => {
        if (typeof raw !== "object" || raw === null) return [];
        const mailbox = raw as Record<string, unknown>;
        if (typeof mailbox.address !== "string" || !mailbox.address) return [];
        return [
          {
            address: mailbox.address,
            unread: numeric(mailbox.unread) ?? 0,
            read: numeric(mailbox.read) ?? 0,
          },
        ];
      })
    : [];
  const unreadMessages = Array.isArray(snapshot.unreadMessages)
    ? snapshot.unreadMessages.flatMap((raw): ConversationStatusPanelTeamMessage[] => {
        if (typeof raw !== "object" || raw === null) return [];
        const message = raw as Record<string, unknown>;
        if (typeof message.id !== "string" || !message.id) return [];
        if (typeof message.from !== "string" || typeof message.to !== "string") return [];
        if (typeof message.message !== "string") return [];
        return [
          {
            id: message.id,
            from: message.from,
            to: message.to,
            ...(typeof message.summary === "string" && message.summary
              ? { summary: message.summary }
              : {}),
            message: message.message,
            deliveredAt: typeof message.deliveredAt === "string" ? message.deliveredAt : "",
          },
        ];
      })
    : [];
  return {
    teamId: snapshot.teamId,
    goal: snapshot.goal,
    status: snapshot.status,
    ...(typeof snapshot.panelUrl === "string" &&
    /^http:\/\/127\.0\.0\.1:\d+\//u.test(snapshot.panelUrl)
      ? { panelUrl: snapshot.panelUrl }
      : {}),
    ...(snapshot.stale === true ? { stale: true } : {}),
    ...(typeof snapshot.updatedAt === "string" && snapshot.updatedAt
      ? { updatedAt: snapshot.updatedAt }
      : {}),
    ...(typeof snapshot.captainSessionId === "string" && snapshot.captainSessionId
      ? { captainSessionId: snapshot.captainSessionId }
      : {}),
    counts: projectedCounts,
    totalCount:
      projectedCounts.done +
      projectedCounts.inProgress +
      projectedCounts.todo +
      projectedCounts.failed +
      projectedCounts.blocked,
    members,
    tasks,
    readyTaskIds,
    hasTaskDerivations: Array.isArray(snapshot.readyTaskIds),
    criticalPathDepth,
    blockedByFailedQuality,
    mailboxes,
    unreadMessages,
    maxMembers: numeric(snapshot.maxMembers) ?? 0,
  };
}
