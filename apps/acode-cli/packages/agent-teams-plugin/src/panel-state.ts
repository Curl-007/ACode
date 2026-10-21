import { subagentSessionIdForAgent } from "./identity.js";
import type { TeamState, TeamTask } from "./state/types.js";
import { STALE_TEAM_AFTER_MS } from "./state/types.js";
import {
  computeReadyTaskIds,
  criticalPathDepth,
  tasksBlockedByFailedQuality,
} from "./state/dag.js";

/**
 * 面板状态快照（TeamPanelState）：宿主状态面板（pluginStates 状态键）与浏览器面板
 * 共用的投影形状。每次写状态后由 server 构造并以 MCP logging 通知
 * （logger: acode-plugin-state:agent-teams）推给宿主；宿主不解释内容，
 * UI 端按 v1 形状渲染团队卡。
 *
 * 派生字段（readyTaskIds / criticalPathDepth / blockedByFailedQuality）由本模块用
 * state/dag.ts 的纯函数算好后随快照下发，而不是让 UI 侧重算：质量门语义
 * （QUALITY_TASK_KINDS）是插件所有，宿主不应复制这份知识；两边各算一遍也迟早漂移。
 */

/** 单条未读消息在快照里的正文上限。快照走 MCP 通知，正文无界会顶爆单帧。 */
const MAX_PANEL_MESSAGE_CHARS = 400;
/** 快照携带的未读消息条数上限（按投递时间取最近的）。 */
export const MAX_PANEL_UNREAD_MESSAGES = 20;

export interface TeamPanelMailbox {
  address: string;
  unread: number;
  read: number;
}

export interface TeamPanelMessage {
  id: string;
  from: string;
  to: string;
  summary?: string;
  /** 已按 MAX_PANEL_MESSAGE_CHARS 截断；完整正文在磁盘 mailbox 里。 */
  message: string;
  deliveredAt: string;
}

export interface TeamPanelState {
  v: 1;
  teamId: string;
  goal: string;
  status: TeamState["status"];
  seq: number;
  /**
   * 队长会话 id（additive）：快照按工作区推送给同项目所有会话，宿主据此只在队长会话里
   * 画团队卡；缺席（旧插件）时宿主退回「不过滤」。
   */
  captainSessionId?: string;
  panelUrl?: string;
  counts: {
    done: number;
    inProgress: number;
    todo: number;
    failed: number;
    blocked: number;
  };
  members: Array<{
    name: string;
    role: string;
    status: string;
    currentTaskId?: string;
    /** 已绑定成员的子会话 id（按 identity.ts 既有构造规则派生）；UI 据此打开成员会话。 */
    childSessionId?: string;
  }>;
  /** 名册上限（team.json 的 maxMembers），面板据此显示「成员 5/8」。 */
  maxMembers: number;
  tasks: Array<{
    taskId: string;
    title: string;
    status: TeamTask["status"];
    kind: string;
    dependencies: string[];
    assignee?: string;
  }>;
  /**
   * 以下四项为 additive 扩展（v 仍为 1）：旧宿主按 v1 收窄时读不到会退回空集/0，
   * 不构成形状不符。新宿主据此画依赖图、就绪集与关键路径。
   */
  /** 就绪 = todo 且全部依赖已放行（computeReadyTaskIds 的结果）。 */
  readyTaskIds: string[];
  /** 最长依赖链深度（任务数），用于面板标注；非调度依据。 */
  criticalPathDepth: number;
  /** 被失败/阻断的质量门任务（kind ∈ review|test）卡住的 todo 任务。 */
  blockedByFailedQuality: Array<{ taskId: string; blockedBy: string[] }>;
  mailboxes: TeamPanelMailbox[];
  /** 未读消息样本（最多 MAX_PANEL_UNREAD_MESSAGES 条，正文已截断）。 */
  unreadMessages: TeamPanelMessage[];
  /**
   * 多团队 additive 扩展（0.2，v 仍为 1）：所有活跃团队各自的快照，primary 之上的
   * 平铺数组。旧宿主按 v1 收窄读不到它 → 仍渲染 primary 单卡；新宿主读 teams[] 渲染
   * 多卡。与 readyTaskIds 等同一 additive 手法：缺席即退回单卡，不构成形状不符。
   */
  teams?: TeamPanelState[];
  /** primary 卡的来源团队最近无更新（>48h）；提示 adopt 或归档，不自动处理。 */
  stale?: boolean;
  /** team.json 的 updatedAt：UI 据此显示「最近更新 X 前」；缺席则不显示时间。 */
  updatedAt?: string;
  /**
   * 最近结束的团队（additive）：按结束时间倒序，最多 MAX_RECENT_ENDED_TEAMS 条，
   * 元素与 teams[] 同形（不带 mailboxes/unreadMessages），另带 endedAt。归档帧之后宿主
   * 不再收到这些团队，UI 的「已结束」桶只能从这里取。
   */
  recentEnded?: Array<TeamPanelState & { endedAt: string }>;
}

/** recentEnded 保留条数上限。 */
export const MAX_RECENT_ENDED_TEAMS = 5;

function truncateMessage(text: string): string {
  if (text.length <= MAX_PANEL_MESSAGE_CHARS) return text;
  return `${text.slice(0, MAX_PANEL_MESSAGE_CHARS - 1)}…`;
}

export function buildTeamPanelState(params: {
  team: TeamState;
  tasks: readonly TeamTask[];
  panelUrl?: string;
  mailboxes?: readonly TeamPanelMailbox[];
  unreadMessages?: readonly TeamPanelMessage[];
}): TeamPanelState {
  const { team, tasks } = params;
  const updatedAtMs = Date.parse(team.updatedAt);
  const stale = Number.isFinite(updatedAtMs) && Date.now() - updatedAtMs > STALE_TEAM_AFTER_MS;
  const counts = { done: 0, inProgress: 0, todo: 0, failed: 0, blocked: 0 };
  for (const task of tasks) {
    if (task.status === "done") counts.done += 1;
    else if (task.status === "in_progress") counts.inProgress += 1;
    else if (task.status === "todo") counts.todo += 1;
    else if (task.status === "failed") counts.failed += 1;
    else if (task.status === "blocked") counts.blocked += 1;
  }
  // 成员现状：进行中任务的 attempt owner 即当前任务；无则空闲。
  const currentTaskByMember = new Map<string, string>();
  for (const task of tasks) {
    if (task.status !== "in_progress") continue;
    const owner = task.attempts.find((attempt) => attempt.id === task.activeAttemptId)?.owner;
    if (owner && owner !== "captain") currentTaskByMember.set(owner, task.taskId);
  }
  const tasksById = new Map(tasks.map((task) => [task.taskId, task]));
  const maxDepth = tasks.reduce(
    (depth, task) => Math.max(depth, criticalPathDepth(task, tasksById)),
    0,
  );
  const unreadMessages = [...(params.unreadMessages ?? [])]
    .sort(
      (left, right) =>
        right.deliveredAt.localeCompare(left.deliveredAt) || right.id.localeCompare(left.id),
    )
    .slice(0, MAX_PANEL_UNREAD_MESSAGES)
    .map((message) => ({
      id: message.id,
      from: message.from,
      to: message.to,
      ...(message.summary ? { summary: message.summary } : {}),
      message: truncateMessage(message.message),
      deliveredAt: message.deliveredAt,
    }));
  return {
    v: 1,
    teamId: team.teamId,
    goal: team.goal,
    status: team.status,
    seq: team.seq,
    ...(team.captainSessionId ? { captainSessionId: team.captainSessionId } : {}),
    ...(params.panelUrl ? { panelUrl: params.panelUrl } : {}),
    ...(stale ? { stale: true } : {}),
    ...(team.updatedAt ? { updatedAt: team.updatedAt } : {}),
    counts,
    members: team.members
      .filter((member) => member.status !== "removed")
      .map((member) => ({
        name: member.name,
        role: member.role,
        status: member.status,
        ...(currentTaskByMember.has(member.name)
          ? { currentTaskId: currentTaskByMember.get(member.name) }
          : {}),
        ...(member.agentId ? { childSessionId: subagentSessionIdForAgent(member.agentId) } : {}),
      })),
    tasks: tasks.map((task) => ({
      taskId: task.taskId,
      title: task.title,
      status: task.status,
      kind: task.kind,
      dependencies: task.dependencies,
      ...(task.assignee ? { assignee: task.assignee } : {}),
    })),
    maxMembers: team.maxMembers,
    readyTaskIds: computeReadyTaskIds(tasks),
    criticalPathDepth: maxDepth,
    blockedByFailedQuality: tasksBlockedByFailedQuality(tasks),
    mailboxes: (params.mailboxes ?? []).map((mailbox) => ({
      address: mailbox.address,
      unread: mailbox.unread,
      read: mailbox.read,
    })),
    unreadMessages,
  };
}
