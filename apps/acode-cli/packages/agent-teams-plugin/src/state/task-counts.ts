import type { TeamTask } from "./types.js";

/**
 * 任务计数（EI-2 单一实现）：面板投影、状态总览与验收度量共用同一分桶，
 * 消除三处各自实现的漂移。`counts.inReview` 因此只有一个来源。
 *
 * `total` 恒等于任务数（含未知状态——未知值由 machine.assertKnownTaskStatus 在
 * 写入/读取边界 fail loudly，这里不静默并入任何桶）。
 */
export interface TaskCounts {
  total: number;
  todo: number;
  inProgress: number;
  inReview: number;
  done: number;
  failed: number;
  blocked: number;
  cancelled: number;
  /** 非已知状态的条目数；正常团队恒为 0（读到即应在边界报错）。 */
  unknown: number;
}

export function countTasksByStatus(tasks: readonly TeamTask[]): TaskCounts {
  const counts: TaskCounts = {
    total: tasks.length,
    todo: 0,
    inProgress: 0,
    inReview: 0,
    done: 0,
    failed: 0,
    blocked: 0,
    cancelled: 0,
    unknown: 0,
  };
  for (const task of tasks) {
    switch (task.status) {
      case "todo":
        counts.todo += 1;
        break;
      case "in_progress":
        counts.inProgress += 1;
        break;
      case "in_review":
        counts.inReview += 1;
        break;
      case "done":
        counts.done += 1;
        break;
      case "failed":
        counts.failed += 1;
        break;
      case "blocked":
        counts.blocked += 1;
        break;
      case "cancelled":
        counts.cancelled += 1;
        break;
      default:
        counts.unknown += 1;
        break;
    }
  }
  return counts;
}