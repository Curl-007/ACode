import type { TaskStatus } from "./types.js";
import { TeamError } from "./types.js";

/**
 * 任务状态机转移表（唯一事实源）。工具层只允许通过这里的判定改状态；
 * 测试穷举所有 (from, action) 组合。
 *
 * 认领 claim: todo → in_progress
 * 完成 update(done): in_progress → done
 * 失败 update(failed): in_progress → failed
 * 阻塞 update(blocked): in_progress → blocked
 * 重派 reassign: in_progress|todo|failed|blocked → todo（失效当前 attempt）
 * 取消 cancel: todo → cancelled（团队暂停时的显式取消）
 */
const TRANSITIONS: Record<TaskStatus, Partial<Record<TaskAction, TaskStatus>>> = {
  todo: {
    claim: "in_progress",
    reassign: "todo",
    cancel: "cancelled",
  },
  in_progress: {
    update_done: "done",
    update_failed: "failed",
    update_blocked: "blocked",
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
  | "reassign"
  | "cancel";

export function assertTransition(from: TaskStatus, action: TaskAction): void {
  const next = TRANSITIONS[from][action];
  if (!next) {
    throw new TeamError(
      "invalid_input",
      `Task status "${from}" does not accept action "${action}".`,
      { from, action },
    );
  }
}

export function canTransition(from: TaskStatus, action: TaskAction): boolean {
  return TRANSITIONS[from][action] !== undefined;
}

export function isTaskTerminal(status: TaskStatus): boolean {
  return status === "done" || status === "failed" || status === "blocked" || status === "cancelled";
}
