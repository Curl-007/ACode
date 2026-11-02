import type { TaskStatus } from "./types.js";
import { TeamError } from "./types.js";

/**
 * 任务状态机转移表（唯一事实源）。工具层只允许通过这里的判定改状态；
 * 测试穷举所有 (from, action) 组合。
 *
 * 认领 claim: todo → in_progress
 * 汇报 update(done): in_progress → in_review（汇报 ≠ 验收）
 * 验收 accept: in_review → done（唯一触发者：合并工具耦合，或 OQ-1 非隔离团队的队长显式验收）
 * 失败 update(failed): in_progress|in_review → failed
 * 阻塞 update(blocked): in_progress → blocked
 * 重派 reassign: todo|in_progress|in_review|failed|blocked → todo（失效当前 attempt）
 * 取消 cancel: todo → cancelled（团队暂停时的显式取消）
 *
 * `in_review` 是**非终态**：它既不放行下游依赖（dag.dependencySatisfied 只认 done），
 * 也不让成员被认为忙碌（调度器/computeNextActions 只看 in_progress）。
 */
const TRANSITIONS: Record<TaskStatus, Partial<Record<TaskAction, TaskStatus>>> = {
  todo: {
    claim: "in_progress",
    reassign: "todo",
    cancel: "cancelled",
  },
  in_progress: {
    update_done: "in_review",
    update_failed: "failed",
    update_blocked: "blocked",
    reassign: "todo",
  },
  in_review: {
    accept: "done",
    update_failed: "failed",
    reassign: "todo",
  },
  done: {},
  failed: {
    reassign: "todo",
  },
  blocked: {
    reassign: "todo",
  },
  cancelled: {},
};

export type TaskAction =
  | "claim"
  | "update_done"
  | "update_failed"
  | "update_blocked"
  | "accept"
  | "reassign"
  | "cancel";

/**
 * 已知任务状态判据：直接以 TRANSITIONS 的键为唯一事实源（EI-2），不另存一份列表。
 * 读到未知值（外来 / 未来版本写入）即 fail loudly（R2.5），绝不静默当成 todo/in_progress。
 */
export function isKnownTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(TRANSITIONS, value);
}

/** 读到未知任务状态时抛结构化错误（fail loudly，R2.5）。 */
export function assertKnownTaskStatus(value: unknown, label = "task"): asserts value is TaskStatus {
  if (!isKnownTaskStatus(value)) {
    throw new TeamError(
      "invalid_input",
      `Unknown task status ${value === undefined ? "<missing>" : `"${String(value)}"`} on ${label}; this plugin refuses to guess a status it does not recognize.`,
      { status: value === undefined ? null : String(value), label },
    );
  }
}

/** 批量校验任务列表的状态（读取边界 fail loudly，R2.5）。 */
export function assertKnownTaskStatuses(
  tasks: readonly { taskId: string; status: unknown }[],
): void {
  for (const task of tasks) assertKnownTaskStatus(task.status, `task ${task.taskId}`);
}

export function assertTransition(from: TaskStatus, action: TaskAction): void {
  // 未知 from（外来 / 未来版本写入的值）：显式结构化错误，而不是 TypeError（R2.1/R2.5）。
  const row: Partial<Record<TaskAction, TaskStatus>> | undefined = TRANSITIONS[from];
  if (!row) {
    throw new TeamError(
      "invalid_input",
      `Task status "${String(from)}" is not recognized; refusing to apply action "${action}".`,
      { from: String(from), action },
    );
  }
  const next = row[action];
  if (!next) {
    throw new TeamError(
      "invalid_input",
      `Task status "${from}" does not accept action "${action}".`,
      { from, action },
    );
  }
}

export function canTransition(from: TaskStatus, action: TaskAction): boolean {
  const row: Partial<Record<TaskAction, TaskStatus>> | undefined = TRANSITIONS[from];
  return row?.[action] !== undefined;
}

export function isTaskTerminal(status: TaskStatus): boolean {
  return status === "done" || status === "failed" || status === "blocked" || status === "cancelled";
}
