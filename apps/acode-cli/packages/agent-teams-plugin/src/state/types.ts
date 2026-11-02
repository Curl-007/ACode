/** 团队状态的数据模型。全部由 server 进程互斥段内读-改-写，磁盘是唯一真相。 */

export type TeamStatus = "draft" | "active" | "paused" | "archived";
/**
 * 任务状态。`in_review` = 成员已汇报、**待队长验收**（非终态：不放行下游依赖，
 * 也不让成员被视为忙碌）。验收通过的唯一入口是合并耦合（隔离团队）或队长显式验收
 * （OQ-1，非隔离团队）。
 */
export type TaskStatus =
  | "todo"
  | "in_progress"
  | "in_review"
  | "done"
  | "failed"
  | "blocked"
  | "cancelled";
export type TaskKind = "build" | "review" | "test" | "design" | "chore";
export type MemberStatus = "registered" | "bound" | "removed";

/**
 * 成员工作树句柄（SPEC-015）。开启隔离后由 agent_teams_add_member 创建并写入；
 * 合并/清理只更新这里的状态，不维护第二份映射。git 磁盘事实仍是最终判据。
 */
export interface MemberWorktree {
  readonly path: string;
  readonly branch: string;
  /** 建树时的基线分支，也是合并目标。 */
  readonly baseBranch: string;
  /** 建树时的 HEAD；用于识别成员是否产生新提交。 */
  readonly baseCommit: string;
  status: "active" | "merged";
  mergedAt?: string;
  lastMergedCommit?: string;
  /** 最近一次清理的结果（团队结束/成员移除时写入，供归档后审计）。 */
  lastCleanup?: {
    at: string;
    removed: boolean;
    branchRemoved: boolean;
    keptReason?: string;
    error?: string;
  };
}

/** 团队级工作树隔离配置（SPEC-015）；只在建队时写入。 */
export interface TeamWorktreeIsolation {
  readonly enabled: true;
  readonly repoRoot: string;
  /** 建队时所在分支；合并必须回到该分支。 */
  readonly baseBranch: string;
  readonly createdAt: string;
}

export interface TeamMember {
  readonly name: string;
  readonly role: string;
  readonly charter: string;
  /**
   * 角色能力包引用（批次 5，additive）：成员 spawn 时使用的宿主 AgentProfile 名
   * （即原生 `Agent` 工具的 `subagent_type` 取值，插件命名空间形如 `agent-teams:member`）。
   *
   * **不透明标识**：插件只存不解释、不校验 profile 是否存在（零 core 依赖，看不到宿主
   * profile 注册表）；解析责任在宿主派发边界（`core/src/subagent/runner.ts` 的
   * `resolveAgentProfileByType`，未命中抛 UNKNOWN_AGENT_TYPE 并列出可用类型）。缺席 =
   * 未指定，spawn 回退插件默认成员 profile `agent-teams:member`（`agents/member.md`）。
   * 定义与边界见 `apps/acode-cli/specs/agent-teams-role-packs.md` R1/R2/R4。
   */
  readonly roleRef?: string;
  /** Agent 工具 spawn 返回的 agentId（bind 之后存在）。 */
  agentId?: string;
  /** bind 时锁定的成员身份线索（子会话续跑会换 session id，仅作审计）。 */
  boundSessionId?: string;
  status: MemberStatus;
  readonly addedAt: string;
  removedAt?: string;
  removedReason?: string;
  /** 成员工作树（SPEC-015）；团队未开启隔离或成员未创建时缺席。 */
  worktree?: MemberWorktree;
  /**
   * 成员正阻塞在 agent_teams_wait_for_work 里等活的截止时刻（ISO）。在期内调度器不再
   * 让队长 SendMessage 唤醒它——新任务/邮件会让等待自己返回；过期即视为不在等（进程
   * 已结束或 maxTurns 耗尽），退回 SendMessage 唤醒。
   */
  waitingUntil?: string;
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

/**
 * run_checks 最近一次检查结果（R1.2，additive）。
 *
 * 形状对齐 `packages/shared/specs/team-acceptance-review-contract.md` 的 `reviews[].check`
 * （command / exitCode / passed / summary / truncated / ranAt），另带 attemptId 以便批次 1
 * 把结果锚回「审的是哪次交付」。批次 4 的坊主没有独立存储面，这里是其生产者基础。
 */
export interface TaskCheckResult {
  readonly attemptId: string;
  readonly command: string;
  readonly exitCode: number;
  readonly passed: boolean;
  readonly truncated?: boolean;
  readonly summary?: string;
  readonly ranAt: string;
}

/**
 * review_member_diff 最近一次钉住的提交对（additive）。
 *
 * 面板 `reviews[]` 的 `baseCommit`/`headCommit` 坐标靠它落盘——panel-state 是纯投影
 * （无 git IO），无法在快照生成时现算成员分支 HEAD，只能复用 review 时已解析的绝对 SHA。
 * 缺席 = 尚未 review 过（坐标回退到 `member.worktree.baseCommit`，headCommit 缺席）。
 */
export interface TaskReviewCoordinates {
  readonly baseCommit: string;
  readonly headCommit: string;
  readonly branchHeadCommit?: string;
  readonly reviewedAt: string;
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
  /** run_checks 最近一次检查结果（additive；缺席 = 未执行过检查）。 */
  lastCheck?: TaskCheckResult;
  /** review_member_diff 最近一次钉住的提交对（additive；面板 reviews[] 的坐标来源）。 */
  lastReview?: TaskReviewCoordinates;
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
  /**
   * 队长鉴权通过时刷新（0.2 接管冷静期的判据）：距今 < 10 分钟时 adopt_team
   * 拒绝未带 force 的接管，防两个活队长互抢。
   */
  lastCaptainSeenAt?: string;
  /** 队长变更台账（0.2）：创建时记首任，adopt_team 追加。 */
  captainHistory?: Array<{ sessionId: string; at: string }>;
  workspaceKey: string;
  /** workspace_key 缺失降级到 workspace_path 时记录，供面板与诊断展示。 */
  workspaceKeyDegraded: boolean;
  maxMembers: number;
  /** 成员工作树隔离（SPEC-015）；缺席 = 未开启（默认）。 */
  worktreeIsolation?: TeamWorktreeIsolation;
  createdAt: string;
  updatedAt: string;
  /** 单调递增序号：所有写操作递增；面板与冷恢复用它检测进度差量。 */
  seq: number;
  members: TeamMember[];
  /**
   * run_checks 调用计数（R1.5，additive）。本地磁盘事实，**不上报**（no-telemetry）；
   * 为后续「run_checks 迁宿主 core handler」的取舍留数据。历史团队无该字段即视为 0。
   */
  checkRuns?: TeamCheckRuns;
  /**
   * 唤醒世代号（host-team-wake.md R3，additive）。**仅成员来源的唤醒级写入**递增：
   * 成员邮箱投递（from 非 captain）与成员 update_task 落终态/汇报（done|failed|blocked）；
   * 队长自身的读/写（读信、鉴权刷新 lastCaptainSeenAt）不递增。历史团队无该字段即视为 0。
   * 宿主据它防旧世代覆盖（EI-59），面板 `wakePending.generation` 直接投影本值。
   */
  wakeSeq?: number;
  /**
   * 队长正阻塞在 agent_teams_wait_for_members 里等成员的截止时刻（ISO，additive）。
   * 镜像成员侧 `waitingUntil`；供宿主判断「队长正在有意的阻塞等待」。缺席 = 未在等待。
   */
  captainWaitingUntil?: string;
}

/**
 * 邮箱消息的语义类别（host-team-wake.md R2，additive，缺省 `note`）。
 * 成员阻塞提问用 `question`、上报需用户决策/权限的风险用 `escalation`、常规完成汇报用
 * `report`。形状与宿主 core `TeamWakeMessageKind` 严格对齐（宿主据此收窄，见
 * `apps/acode-cli/specs/host-team-wake.md` R1 与 `core/src/runtime/team-wake/types.ts`）。
 */
export type TeamMessageKind = "report" | "question" | "escalation" | "note";

/** run_checks 调用计数（R1.5，additive）。 */
export interface TeamCheckRuns {
  total: number;
  byMember: Record<string, number>;
  lastAt?: string;
  lastExitCode?: number;
}

export interface TeamMessage {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  summary?: string;
  readonly message: string;
  readonly deliveredAt: string;
  /** 语义类别（R2，additive）；缺席按 `note` 解释。 */
  readonly kind?: TeamMessageKind;
  readAt?: string;
}

export interface MailboxAddress {
  readonly kind: "captain" | "member";
  readonly name: string;
}

export const CAPTAIN_ADDRESS = "captain";

export const MEMBER_NAME_PATTERN = /^[a-z][a-z0-9-]{1,30}$/;

/**
 * 角色引用（`roleRef`）的形状约束（批次 5）。
 *
 * 取值是宿主 AgentProfile 名 / `subagent_type`，宿主解析用的是 NFKC + 小写 + 去
 * 空白/破折号/下划线的**宽松归一**，所以这里放行常见分隔符（`.` `_` `:` `-`）与大小写；
 * 但**拒绝空白/换行/控制字符**——它既要作为 JSON 字段透传，也是宿主类型名，非法字符
 * 应在插件层「明确拒绝」（EI-11：明确未执行可安全重试），而不是拖到宿主 spawn 才炸。
 * 1–64 字符上界（EI-6 一切资源有界）。存在性校验不在插件层（零 core 依赖，做不到，
 * 见 specs/agent-teams-role-packs.md R1/R4）。
 */
export const ROLE_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

export const TASK_ID_PATTERN = /^t-\d+$/;

/** teamId 形状（randomTeamId 产出 `team-<8 hex>`；历史/手工目录名同域）。 */
export const TEAM_ID_PATTERN = /^team-[a-z0-9-]+$/u;

export const TEAM_ERROR_CODES = [
  "team_exists",
  // 调用方身份绑定的团队已归档：与 no_active_team 区分，成员据此立即收工、不再重试。
  "team_archived",
  "no_active_team",
  "team_not_found",
  "team_ambiguous",
  "team_limit_exceeded",
  "team_not_draft",
  "team_not_paused",
  "team_not_active",
  "adoption_conflict",
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
  "worktree_disabled",
  "worktree_unavailable",
  "worktree_create_failed",
  "worktree_not_found",
  "worktree_conflict",
  "worktree_dirty_workspace",
  "worktree_not_on_base_branch",
  "worktree_merge_failed",
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

export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = [
  "done",
  "failed",
  "blocked",
  "cancelled",
];

/** 质量门任务类型：失败不解锁下游。 */
export const QUALITY_TASK_KINDS: readonly TaskKind[] = ["review", "test"];

/** 同一任务的最大重派轮次默认值（userConfig maxReassignRounds 覆盖）。 */
export const DEFAULT_MAX_REASSIGN_ROUNDS = 3;

/** 最大重派轮次的可调范围；越界夹到边界值。 */
export const MAX_REASSIGN_ROUNDS_LIMITS = { min: 1, max: 10 } as const;

/** 同时活跃团队数上限默认值（userConfig maxActiveTeams 覆盖；配 1 复刻旧行为）。 */
export const DEFAULT_MAX_ACTIVE_TEAMS = 4;

/** 活跃团队数上限的可调范围；越界夹到边界值。 */
export const MAX_ACTIVE_TEAMS_LIMITS = { min: 1, max: 8 } as const;

/**
 * 归一化同时活跃团队数上限：**没配置**（老配置文件 / 空串 / 不可解析）退回默认 4，
 * **配了但越界**（< 1 或 > 8）夹到 1~8。与 normalizeMaxReassignRounds 同一纪律：
 * 夹取是「配错帮收」，退默认是「没配过」，任何分支都不会产生无上限。
 */
export function normalizeMaxActiveTeams(value: unknown): number {
  const raw = typeof value === "number" ? value : Number.parseFloat(String(value ?? "").trim());
  if (!Number.isFinite(raw)) return DEFAULT_MAX_ACTIVE_TEAMS;
  return Math.min(
    Math.max(Math.trunc(raw), MAX_ACTIVE_TEAMS_LIMITS.min),
    MAX_ACTIVE_TEAMS_LIMITS.max,
  );
}

/** adopt_team 接管冷静期：原队长 10 分钟内活跃时，未带 force 的接管被拒。 */
export const ADOPTION_COOLDOWN_MS = 10 * 60 * 1000;

/** status 总览把 updatedAt 超过 48h 的活跃团队标注 stale（只标注，不自动归档）。 */
export const STALE_TEAM_AFTER_MS = 48 * 60 * 60 * 1000;

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
