/** 团队状态的数据模型。全部由 server 进程互斥段内读-改-写，磁盘是唯一真相。 */

export type TeamStatus = "draft" | "active" | "paused" | "archived";
export type TaskStatus = "todo" | "in_progress" | "done" | "failed" | "blocked" | "cancelled";
export type TaskKind = "build" | "review" | "test" | "design" | "chore";
export type MemberStatus = "registered" | "bound" | "removed";

export interface TeamMember {
  readonly name: string;
  readonly role: string;
  readonly charter: string;
  /** Agent 工具 spawn 返回的 agentId（bind 之后存在）。 */
  agentId?: string;
  /** bind 时锁定的成员身份线索（子会话续跑会换 session id，仅作审计）。 */
  boundSessionId?: string;
  status: MemberStatus;
  readonly addedAt: string;
  removedAt?: string;
  removedReason?: string;
}

export interface TaskAttempt {
  readonly id: string;
  readonly seq: number;
  /** 成员名或 "captain"。 */
  readonly owner: string;
  readonly startedAt: string;
  endedAt?: string;
  outcome?: "done" | "failed" | "blocked";
}

export interface TaskRevision {
  readonly at: string;
  readonly by: string;
  readonly fields: string[];
}

export interface TeamTask {
  readonly taskId: string;
  title: string;
  objective: string;
  acceptance: string[];
  kind: TaskKind;
  dependencies: string[];
  assignee?: string;
  status: TaskStatus;
  /** 当前有效 attempt 的 id（认领时写入；update/reassign 校验它防陈旧写）。 */
  activeAttemptId?: string;
  attemptSeq: number;
  attempts: TaskAttempt[];
  revisions: TaskRevision[];
  notes?: string;
  summary?: string;
  outputs?: string[];
  verify?: string;
  blockedReason?: string;
  failReason?: string;
  readonly createdAt: string;
  updatedAt: string;
}

export interface TeamState {
  readonly teamId: string;
  goal: string;
  status: TeamStatus;
  /** 创建者会话（队长主会话，主会话不重建，可严格比对）。 */
  captainSessionId: string;
  workspaceKey: string;
  /** workspace_key 缺失降级到 workspace_path 时记录，供面板与诊断展示。 */
  workspaceKeyDegraded: boolean;
  maxMembers: number;
  createdAt: string;
  updatedAt: string;
  /** 单调递增序号：所有写操作递增；面板与冷恢复用它检测进度差量。 */
  seq: number;
  members: TeamMember[];
}

export interface TeamMessage {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  summary?: string;
  readonly message: string;
  readonly deliveredAt: string;
  readAt?: string;
}

export interface MailboxAddress {
  readonly kind: "captain" | "member";
  readonly name: string;
}

export const CAPTAIN_ADDRESS = "captain";

export const MEMBER_NAME_PATTERN = /^[a-z][a-z0-9-]{1,30}$/;

export const TASK_ID_PATTERN = /^t-\d+$/;

export const TEAM_ERROR_CODES = [
  "team_exists",
  "no_active_team",
  "team_not_draft",
  "team_not_paused",
  "forbidden_for_caller",
  "caller_not_member",
  "task_not_found",
  "task_not_ready",
  "already_claimed",
  "stale_attempt",
  "cycle_detected",
  "dependency_not_found",
  "member_exists",
  "member_not_found",
  "member_not_bound",
  "member_limit_exceeded",
  "member_removed",
  "another_process_holds_team_lock",
  "identity_missing",
  "invalid_input",
  "roster_empty",
  "verify_required",
  "acceptance_frozen",
  "reassign_limit_exceeded",
] as const;

export type TeamErrorCode = (typeof TEAM_ERROR_CODES)[number];

export class TeamError extends Error {
  constructor(
    readonly code: TeamErrorCode,
    message: string,
    readonly data?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "TeamError";
  }
}

export const ACTIVE_TEAM_STATUSES: readonly TeamStatus[] = ["draft", "active", "paused"];

export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = ["done", "failed", "blocked", "cancelled"];

/** 质量门任务类型：失败不解锁下游。 */
export const QUALITY_TASK_KINDS: readonly TaskKind[] = ["review", "test"];

/** 同一任务的最大重派轮次默认值（userConfig maxReassignRounds 覆盖）。 */
export const DEFAULT_MAX_REASSIGN_ROUNDS = 3;

/** 最大重派轮次的可调范围；越界夹到边界值。 */
export const MAX_REASSIGN_ROUNDS_LIMITS = { min: 1, max: 10 } as const;

/**
 * 归一化最大重派轮次：**没配置**（老配置文件 / 空串 / 不可解析）退回默认 3，
 * **配了但越界**（< 1 或 > 10）夹到 1~10。
 *
 * 两种情形必须分开：夹取是「用户配错了，帮他收进合法区间」，退回默认是「用户没配过」。
 * 上限一旦消失就是无限重试烧钱，所以任何一条分支都不会产生「无上限」。
 */
export function normalizeMaxReassignRounds(value: unknown): number {
  const raw = typeof value === "number" ? value : Number.parseFloat(String(value ?? "").trim());
  if (!Number.isFinite(raw)) return DEFAULT_MAX_REASSIGN_ROUNDS;
  return Math.min(
    Math.max(Math.trunc(raw), MAX_REASSIGN_ROUNDS_LIMITS.min),
    MAX_REASSIGN_ROUNDS_LIMITS.max,
  );
}

/**
 * 任务的「已重派次数」= 认领次数 - 1。
 *
 * 复用已落盘的 `attempts[]`（认领时 +1）而不是另存计数：新增计数会造成「两处记录同一件事」
 * 的重复状态，而且读既有事实意味着**已存在的旧团队立即受上限约束**（期望行为：它本来就该停）。
 * 队长接管（reassign 到 captain）也算一次认领，同样计入——它消耗的同样是重试预算。
 */
export function reassignCountOf(task: Pick<TeamTask, "attempts">): number {
  return Math.max(0, task.attempts.length - 1);
}

export function nowIso(): string {
  return new Date().toISOString();
}
