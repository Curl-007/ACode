import type { TaskAttempt, TaskStatus, TeamState, TeamTask } from "./state/types.js";
import { nowIso, reassignCountOf } from "./state/types.js";
import { countTasksByStatus } from "./state/task-counts.js";

/**
 * 验收度量基线（R0）：纯函数、无 IO、无持久化、不上报（no-telemetry）。全部当场从权威
 * 状态 JSON 的 `attempts` / `revisions` / `worktree.mergedAt` 派生，**不落第二份台账**（EI-48）。
 *
 * 口径按「任务」（每个 dispatch 一行），与用量页对齐，便于横向比较。缺数据一律 `null` +
 * `sampleSize`，**不用 0 冒充「无数据」**（EI-9：能力声明必须诚实）。
 *
 * 单一实现同时供面板投影、状态工具与（批次 4）桌面展示复用（EI-2），故落独立文件而非
 * 直接扩 panel-state.ts（该文件与 store.ts 已贴 400 行上限）。
 */

/** 每个任务的一行审计（byTask）。 */
export interface TaskAcceptanceRow {
  taskId: string;
  status: TaskStatus;
  /** 认领次数（attempts.length）。 */
  attempts: number;
  /** amend 次数（revisions.length），第二个审计维度。 */
  revisions: number;
  /** 打回次数 = max(0, attempts.length - 1)。 */
  rejections: number;
  /** 权威 attempt 起点 → 该成员 worktree.mergedAt；不可得则 null（不计入平均）。 */
  acceptLatencyMs: number | null;
}

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
    /** status === "done"。 */
    acceptedTasks: number;
    /** done && attempts.length <= 1。 */
    firstPassTasks: number;
    /** firstPassTasks / acceptedTasks；分母 0 → null。 */
    firstPassRate: number | null;
    /** Σ attempts.length（仅曾认领的任务）。 */
    totalAttempts: number;
    /** totalAttempts / 曾认领任务数；分母 0 → null。 */
    avgAttemptsPerTask: number | null;
    /** Σ max(0, attempts.length - 1)（复用 reassignCountOf，与上限判据同源）。 */
    rejections: number;
  };
  latency: {
    /** 有可判读验收耗时的任务数（分母）。 */
    sampleSize: number;
    avgAcceptLatencyMs: number | null;
  };
  byTask: TaskAcceptanceRow[];
}

/** 权威 attempt：outcome === "done" 的那次，否则最新一次（无 attempt 时 undefined）。 */
function authoritativeAttempt(task: TeamTask): TaskAttempt | undefined {
  const done = task.attempts.find((attempt) => attempt.outcome === "done");
  return done ?? task.attempts[task.attempts.length - 1];
}

/**
 * 验收耗时 = 权威 attempt 的 startedAt → 该 attempt owner 成员 worktree.mergedAt。
 * 不可得（未开隔离 / 未合并 / 时间不可解析 / mergedAt < startedAt）→ null，不计入平均。
 */
function acceptLatencyMs(team: TeamState, task: TeamTask): number | null {
  const attempt = authoritativeAttempt(task);
  if (!attempt) return null;
  const owner = team.members.find((member) => member.name === attempt.owner);
  const mergedAt = owner?.worktree?.mergedAt;
  if (!mergedAt) return null;
  const started = Date.parse(attempt.startedAt);
  const merged = Date.parse(mergedAt);
  if (!Number.isFinite(started) || !Number.isFinite(merged) || merged < started) return null;
  return merged - started;
}

/**
 * 从权威团队状态与任务列表现算度量。`generatedAt` 可注入以便测试用固定时钟（EI-121）。
 */
export function buildTeamAcceptanceMetrics(
  team: TeamState,
  tasks: readonly TeamTask[],
  generatedAt: string = nowIso(),
): TeamAcceptanceMetrics {
  // R2.7：分桶复用唯一实现 countTasksByStatus（EI-2），与面板/状态总览同源。
  const bucket = countTasksByStatus(tasks);
  const counts = {
    total: tasks.length,
    accepted: bucket.done,
    inReview: bucket.inReview,
    open: bucket.todo + bucket.inProgress,
    failed: bucket.failed,
    blocked: bucket.blocked,
    cancelled: bucket.cancelled,
  };
  const byTask: TaskAcceptanceRow[] = [];
  let firstPassTasks = 0;
  let totalAttempts = 0;
  let claimedTasks = 0;
  let rejections = 0;
  let latencySum = 0;
  let latencySampleSize = 0;

  for (const task of tasks) {
    if (task.status === "done" && task.attempts.length <= 1) firstPassTasks += 1;
    if (task.attempts.length > 0) {
      claimedTasks += 1;
      totalAttempts += task.attempts.length;
    }
    const taskRejections = reassignCountOf(task);
    rejections += taskRejections;
    const latency = acceptLatencyMs(team, task);
    if (latency !== null) {
      latencySampleSize += 1;
      latencySum += latency;
    }
    byTask.push({
      taskId: task.taskId,
      status: task.status,
      attempts: task.attempts.length,
      revisions: task.revisions.length,
      rejections: taskRejections,
      acceptLatencyMs: latency,
    });
  }

  return {
    generatedAt,
    tasks: counts,
    acceptance: {
      acceptedTasks: counts.accepted,
      firstPassTasks,
      firstPassRate: counts.accepted === 0 ? null : firstPassTasks / counts.accepted,
      totalAttempts,
      avgAttemptsPerTask: claimedTasks === 0 ? null : totalAttempts / claimedTasks,
      rejections,
    },
    latency: {
      sampleSize: latencySampleSize,
      avgAcceptLatencyMs: latencySampleSize === 0 ? null : latencySum / latencySampleSize,
    },
    byTask,
  };
}