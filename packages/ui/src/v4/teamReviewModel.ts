/**
 * 团队验收面（in_review）的受检投影：reviews[] / metrics / wakeHint。
 *
 * 从 v4/teamPanelModel.ts 外迁：主文件已 385 行，投影实现搬到这里，主文件只调用并按契约
 * 存放结果（teamPanelModel.ts 的「宿主不解释插件状态」纪律不变）。所有者不同：
 * - reviews[] / metrics 是**插件**面板投影的消费面（形状冻结在
 *   packages/shared/specs/team-acceptance-review-contract.md 契约 A、批次 0 spec R0.2）；
 * - wakeHint 是**宿主侧派生**（输入 = 插件 wakePending + 队长会话 control.phase，
 *   见 apps/acode-cli/specs/host-team-wake.md R10、附录 C OQ3）。
 *
 * 收窄纪律沿用 teamPanelModel：形状不符即整块缺席（不渲染半张卡）／坏条丢弃；additive
 * 字段缺席退回旧行为、不判形状不符。UI 绝不自行推导 diff 或验收结果。
 */
import { buildTruncatedMarkerLine } from "@/lib/patchDiffPreview.js";

/** diff 文本展示行级上限（与 patchDiffPreview 的 MAX_PLAIN_TEXT_FALLBACK_RENDER_LINES 同族）。 */
export const TEAM_REVIEW_DIFF_MAX_LINES = 800;
/** 验收清单单组默认折叠阈值（与 TeamInlineTaskList 的 GROUP_LIMIT 同族，EI-111）。 */
export const REVIEW_GROUP_INLINE_LIMIT = 5;

export type TeamPanelReviewStatus = "in_review" | "merged" | "rejected";
/** 插件知识里的不可读原因闭集（契约 A）；缺席按 false 处理。 */
export type PluginReviewUnavailableReason =
  | "worktree_disabled"
  | "worktree_cleaned"
  | "commits_unreachable"
  | "unknown";

export interface TeamPanelReviewCheck {
  command: string;
  exitCode: number;
  passed: boolean;
  summary?: string;
  truncated?: true;
  ranAt: string;
}

/** 插件 reviews[] 条目的消费投影（契约 A；批次 1 生产侧目前只产出 in_review / merged）。 */
export interface TeamPanelReview {
  taskId: string;
  member: string;
  status: TeamPanelReviewStatus;
  baseCommit?: string;
  headCommit?: string;
  mergedAt?: string;
  check?: TeamPanelReviewCheck;
  diffAvailable?: boolean;
  unavailableReason?: PluginReviewUnavailableReason;
}

/**
 * 从批次 0 TeamAcceptanceMetrics 收窄的 UI 消费面（形状单一真源在
 * apps/acode-cli/specs/agent-teams-acceptance-loop.md R0.2，本文件不复制口径）。
 * 刻意不投影 byTask（MVP 不展示）；比率保持 `null`（缺数据不冒充 0）。
 */
export interface TeamAcceptanceMetrics {
  generatedAt: string;
  tasks: {
    total: number;
    accepted: number;
    inReview: number;
    open: number;
    failed: number;
    blocked: number;
    cancelled: number;
  };
  acceptance: {
    acceptedTasks: number;
    firstPassTasks: number;
    firstPassRate: number | null;
    totalAttempts: number;
    avgAttemptsPerTask: number | null;
    rejections: number;
  };
  latency: { sampleSize: number; avgAcceptLatencyMs: number | null };
}

export type TeamWakeMessageKind = "report" | "question" | "escalation" | "note";

/** 派生 wakeHint 所需的插件 wakePending 事实（只收窄消费面，不搬运成员原文）。 */
export interface TeamWakeFacts {
  unreadMessages: number;
  unsettledMemberTasks: number;
  kinds: TeamWakeMessageKind[];
  truncated: boolean;
}

/** host-team-wake.md R10 的派生投影（宿主侧，非插件事实）。 */
export interface TeamWakeHint {
  kind: "captain_stopped" | "captain_busy" | "member_stopped";
  unreadMessages: number;
  unsettledMemberTasks: number;
  kinds: TeamWakeMessageKind[];
  sampledTruncated?: true;
}

/** 团队卡上的验收面 additive 字段集合（形状不符整块缺席）。 */
export interface TeamReviewProjection {
  reviews: TeamPanelReview[];
  reviewsTruncated: boolean;
  metrics?: TeamAcceptanceMetrics;
  wakeHint?: TeamWakeHint;
}

/** wakeHint 派生输入：队长会话 control（phase 权威；stopState 的 stopping 不等于已停止）。 */
export interface TeamWakeInput {
  sessionControl?: { phase?: string | null; stopState?: string | null } | null;
}

const REVIEW_STATUSES = ["in_review", "merged", "rejected"] as const;
const PLUGIN_UNAVAILABLE_REASONS = [
  "worktree_disabled",
  "worktree_cleaned",
  "commits_unreachable",
  "unknown",
] as const;
const WAKE_KINDS = ["report", "question", "escalation", "note"] as const;
/** 队长会话「已停止」的 phase（非常驻）；其余 phase 视为运行/未启动。 */
const STOPPED_PHASES = new Set(["completedSuccess", "completedInterrupted", "error"]);
const METRIC_TASK_KEYS = ["total", "accepted", "inReview", "open", "failed", "blocked", "cancelled"] as const;
const METRIC_ACCEPTANCE_KEYS = ["acceptedTasks", "firstPassTasks", "totalAttempts", "rejections"] as const;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
/** 非负有限数（与 teamPanelModel 的 numeric 同口径）。 */
const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
/** 比率：`null`（缺样本）或非负有限数；其余（字符串/NaN/负数）判非法 → undefined。 */
const ratio = (value: unknown): number | null | undefined => (value === null ? null : num(value));
const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;
/** 闭集收敛：不在集合内即 undefined（坏值不落成半张卡）。 */
const pick = <T extends string>(value: unknown, allowed: readonly T[]): T | undefined =>
  typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
/** 逐键校验非负数；任一缺失/坏值 → null（整块缺席）。 */
function numericFields<K extends string>(
  raw: Record<string, unknown>,
  keys: readonly K[],
): Record<K, number> | null {
  const out = {} as Record<K, number>;
  for (const key of keys) {
    const value = num(raw[key]);
    if (value === undefined) return null;
    out[key] = value;
  }
  return out;
}

/** check 收窄：任一必需字段坏 → 整个 check 缺席（绝不画出半截通过/失败徽章）。 */
function narrowCheck(raw: unknown): TeamPanelReviewCheck | undefined {
  if (!isObject(raw)) return undefined;
  if (typeof raw.command !== "string" || typeof raw.passed !== "boolean") return undefined;
  const exitCode = typeof raw.exitCode === "number" && Number.isFinite(raw.exitCode)
    ? raw.exitCode
    : undefined;
  if (exitCode === undefined) return undefined;
  const summary = str(raw.summary);
  return {
    command: raw.command,
    exitCode,
    passed: raw.passed,
    ranAt: typeof raw.ranAt === "string" ? raw.ranAt : "",
    ...(summary === undefined ? {} : { summary }),
    ...(raw.truncated === true ? { truncated: true as const } : {}),
  };
}

/** 单条 reviews[] 收窄：taskId/member/status 缺一即丢弃该条（其余保留）。 */
function narrowReview(raw: unknown): TeamPanelReview | null {
  if (!isObject(raw)) return null;
  const taskId = str(raw.taskId);
  const member = str(raw.member);
  const status = pick(raw.status, REVIEW_STATUSES);
  if (taskId === undefined || member === undefined || status === undefined) return null;
  const baseCommit = str(raw.baseCommit);
  const headCommit = str(raw.headCommit);
  const mergedAt = str(raw.mergedAt);
  const check = narrowCheck(raw.check);
  const unavailableReason = pick(raw.unavailableReason, PLUGIN_UNAVAILABLE_REASONS);
  return {
    taskId,
    member,
    status,
    ...(baseCommit === undefined ? {} : { baseCommit }),
    ...(headCommit === undefined ? {} : { headCommit }),
    ...(mergedAt === undefined ? {} : { mergedAt }),
    ...(check === undefined ? {} : { check }),
    ...(typeof raw.diffAvailable === "boolean" ? { diffAvailable: raw.diffAvailable } : {}),
    ...(unavailableReason === undefined ? {} : { unavailableReason }),
  };
}

/** reviews[] 受检收窄：坏条丢弃、其余保留（契约验收场景 3）。 */
export function projectTeamReviews(snapshot: Record<string, unknown>): {
  reviews: TeamPanelReview[];
  truncated: boolean;
} {
  const raw = snapshot.reviews;
  const reviews = Array.isArray(raw)
    ? raw.flatMap((entry): TeamPanelReview[] => {
        const review = narrowReview(entry);
        return review === null ? [] : [review];
      })
    : [];
  return { reviews, truncated: snapshot.reviewsTruncated === true };
}

/** metrics 受检收窄：任一结构字段缺失/坏值 → 整块缺席（不显示半行、不显示 0 冒充）。 */
export function projectTeamMetrics(
  snapshot: Record<string, unknown>,
): TeamAcceptanceMetrics | undefined {
  const raw = snapshot.metrics;
  if (!isObject(raw) || !str(raw.generatedAt)) return undefined;
  const { tasks, acceptance, latency } = raw;
  if (!isObject(tasks) || !isObject(acceptance) || !isObject(latency)) return undefined;
  const counts = numericFields(tasks, METRIC_TASK_KEYS);
  const acceptanceCounts = numericFields(acceptance, METRIC_ACCEPTANCE_KEYS);
  const firstPassRate = ratio(acceptance.firstPassRate);
  const avgAttemptsPerTask = ratio(acceptance.avgAttemptsPerTask);
  const sampleSize = num(latency.sampleSize);
  const avgAcceptLatencyMs = ratio(latency.avgAcceptLatencyMs);
  if (
    !counts ||
    !acceptanceCounts ||
    firstPassRate === undefined ||
    avgAttemptsPerTask === undefined ||
    sampleSize === undefined ||
    avgAcceptLatencyMs === undefined
  ) {
    return undefined;
  }
  return {
    generatedAt: raw.generatedAt as string,
    tasks: counts,
    acceptance: { ...acceptanceCounts, firstPassRate, avgAttemptsPerTask },
    latency: { sampleSize, avgAcceptLatencyMs },
  };
}

/** 插件 wakePending 受检收窄为派生事实；counts/身份缺失即整块缺席（零行为）。 */
export function projectTeamWakeFacts(snapshot: Record<string, unknown>): TeamWakeFacts | null {
  const raw = snapshot.wakePending;
  if (!isObject(raw)) return null;
  const counts = raw.counts;
  if (!isObject(counts) || str(raw.captainSessionId) === undefined) return null;
  const unreadMessages = num(counts.unreadMessages);
  const unsettledMemberTasks = num(counts.unsettledMemberTasks);
  if (unreadMessages === undefined || unsettledMemberTasks === undefined) return null;
  const messages = Array.isArray(raw.messages) ? raw.messages : [];
  const kinds = [
    ...new Set(
      messages.flatMap((entry): TeamWakeMessageKind[] => {
        const kind = isObject(entry) ? pick(entry.kind, WAKE_KINDS) : undefined;
        return kind === undefined ? [] : [kind];
      }),
    ),
  ];
  return { unreadMessages, unsettledMemberTasks, kinds, truncated: raw.truncated === true };
}

/** 队长会话是否「已停止」（非常驻）：只凭 phase 判；缺 phase 即未知 → undefined。 */
export function isCaptainSessionStopped(
  control: TeamWakeInput["sessionControl"],
): boolean | undefined {
  if (!isObject(control) || typeof control.phase !== "string") return undefined;
  return STOPPED_PHASES.has(control.phase);
}

/**
 * wakeHint 派生（R10）：**仅**当队长已停止且确有留箱事实（未读 + 未结算成员任务 > 0）时
 * 产出「需人工介入」。wakePending 缺席 / 无留箱事实 / 队长在跑 → 一律零行为。
 * 「忙但是活的」不在此提示：本批输入只有 phase/stopState，无法可靠区分空闲与忙碌，
 * 宁可不显示也不谎报（EI-1 的显式提示只针对「已停止」这一支）。
 */
export function deriveTeamWakeHint(
  facts: TeamWakeFacts | null,
  captainStopped: boolean | undefined,
): TeamWakeHint | undefined {
  if (!facts || captainStopped !== true) return undefined;
  if (facts.unreadMessages + facts.unsettledMemberTasks <= 0) return undefined;
  return {
    kind: "captain_stopped",
    unreadMessages: facts.unreadMessages,
    unsettledMemberTasks: facts.unsettledMemberTasks,
    kinds: facts.kinds,
    ...(facts.truncated ? { sampledTruncated: true as const } : {}),
  };
}

/** 一次收窄出团队卡的全部验收面字段（teamPanelModel 单点调用）。 */
export function projectTeamReviewProjection(
  snapshot: Record<string, unknown>,
  wakeInput?: TeamWakeInput | undefined,
): TeamReviewProjection {
  const { reviews, truncated } = projectTeamReviews(snapshot);
  const metrics = projectTeamMetrics(snapshot);
  const wakeHint = deriveTeamWakeHint(
    projectTeamWakeFacts(snapshot),
    isCaptainSessionStopped(wakeInput?.sessionControl),
  );
  return {
    reviews,
    reviewsTruncated: truncated,
    ...(metrics === undefined ? {} : { metrics }),
    ...(wakeHint === undefined ? {} : { wakeHint }),
  };
}

export type TeamReviewGroupKey = TeamPanelReviewStatus;

export interface TeamReviewGroup {
  key: TeamReviewGroupKey;
  reviews: TeamPanelReview[];
}

/** 验收清单分组（R6）：待验收 → 已验收 → 已打回；空组不返回，组序即行动优先级。 */
export function groupTeamReviews(reviews: readonly TeamPanelReview[]): TeamReviewGroup[] {
  const buckets: Record<TeamReviewGroupKey, TeamPanelReview[]> = {
    in_review: [],
    merged: [],
    rejected: [],
  };
  for (const review of reviews) buckets[review.status].push(review);
  return REVIEW_STATUSES.map((key) => ({ key, reviews: buckets[key] })).filter(
    (group) => group.reviews.length > 0,
  );
}

/**
 * UI 侧不可读原因闭集：git 契约 B 的 reason 闭集 + 两种 UI 前置态
 * （pinnedMissing = 快照缺 base/head；disconnected = 工作区未连接）。
 */
export type TeamReviewUnavailableReason =
  | "pinnedMissing"
  | "disconnected"
  | PluginReviewUnavailableReason
  | "ref_unresolved"
  | "not_a_repository"
  | "git_unavailable"
  | "timeout"
  | "output_too_large";

/** reason → 文案键（逐码映射，**不**匹配 summary 字符串：那是最易碎的耦合）。 */
export function teamReviewUnavailableMessageId(reason: TeamReviewUnavailableReason): string {
  const suffix =
    reason === "pinnedMissing"
      ? "pinnedMissing"
      : reason === "ref_unresolved"
        ? "refUnresolved"
        : reason === "output_too_large"
          ? "tooLarge"
          : reason;
  return `teamPanel.review.diffUnavailable.${suffix}`;
}

/** 该不可用态是否给出「重试」出路（R3 出路列）。 */
export function teamReviewUnavailableRetryable(reason: TeamReviewUnavailableReason): boolean {
  return reason !== "pinnedMissing" && reason !== "worktree_disabled";
}

/** patch 文本 → 展示行（超上限按整行截断 + 追加既有截断标记行，R3）。 */
export function buildTeamReviewDiffLines(patch: string): string[] {
  const lines = patch.split(/\r?\n/);
  if (lines.length <= TEAM_REVIEW_DIFF_MAX_LINES) return lines;
  const keepCount = TEAM_REVIEW_DIFF_MAX_LINES - 1;
  return [...lines.slice(0, keepCount), buildTruncatedMarkerLine(lines.length - keepCount)];
}