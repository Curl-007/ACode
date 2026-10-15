import type { TeamTask } from "./types.js";
import { QUALITY_TASK_KINDS, TeamError } from "./types.js";

/**
 * DAG 计算：依赖校验、就绪集、失败质量门的 unlock 阻断。纯函数，无 IO。
 * 所有图操作以 taskId 为节点；依赖方向 task → 依赖（边被依赖方指向依赖方）。
 */

export function assertNoCycle(
  tasks: readonly TeamTask[],
  newTaskId: string,
  dependencies: readonly string[],
): void {
  const byId = new Map(tasks.map((task) => [task.taskId, task]));
  if (dependencies.includes(newTaskId)) {
    throw new TeamError("cycle_detected", `Task ${newTaskId} cannot depend on itself.`);
  }
  // 从新节点沿依赖边走：能回到自身即成环。
  const visiting = new Set<string>();
  const walk = (taskId: string): boolean => {
    if (taskId === newTaskId) return true;
    if (visiting.has(taskId)) return false;
    visiting.add(taskId);
    const task = byId.get(taskId);
    return task ? task.dependencies.some((dep) => walk(dep)) : false;
  };
  if (dependencies.some((dep) => walk(dep))) {
    throw new TeamError(
      "cycle_detected",
      `Adding dependencies [${dependencies.join(", ")}] to ${newTaskId} would create a cycle.`,
    );
  }
}

/** 依赖是否被质量门放行：终态 + 非「失败的质量门任务」。 */
export function dependencySatisfied(task: TeamTask | undefined): boolean {
  if (!task) return false;
  if (task.status === "done") return true;
  // failed/blocked/cancelled 一律不放行；质量门任务失败额外标记（供诊断区分）。
  return false;
}

export function isFailedQualityGate(task: TeamTask): boolean {
  return (
    (task.status === "failed" || task.status === "blocked") &&
    QUALITY_TASK_KINDS.includes(task.kind)
  );
}

/**
 * 就绪 = todo && 所有依赖放行。assignee 过滤由调度器做（就绪集本身与指派无关，
 * 状态语义必须与名册解耦）。
 */
export function isTaskReady(task: TeamTask, tasksById: ReadonlyMap<string, TeamTask>): boolean {
  if (task.status !== "todo") return false;
  return task.dependencies.every((dep) => {
    const dependency = tasksById.get(dep);
    if (!dependency) return false;
    return dependencySatisfied(dependency);
  });
}

export function computeReadyTaskIds(tasks: readonly TeamTask[]): string[] {
  const byId = new Map(tasks.map((task) => [task.taskId, task]));
  return tasks
    .filter((task) => isTaskReady(task, byId))
    .map((task) => task.taskId)
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
}

/** 被失败质量门卡住的任务（面板与 next_actions 诊断用）。 */
export function tasksBlockedByFailedQuality(
  tasks: readonly TeamTask[],
): Array<{ taskId: string; blockedBy: string[] }> {
  const failedGates = new Map(
    tasks.filter((task) => isFailedQualityGate(task)).map((task) => [task.taskId, task]),
  );
  const result: Array<{ taskId: string; blockedBy: string[] }> = [];
  for (const task of tasks) {
    if (task.status !== "todo") continue;
    const blocking = task.dependencies.filter((dep) => failedGates.has(dep));
    if (blocking.length > 0) {
      result.push({ taskId: task.taskId, blockedBy: blocking });
    }
  }
  return result;
}

/** 关键路径：按依赖链的最长深度（任务数）。用于面板标注，非调度依据。 */
export function criticalPathDepth(
  task: TeamTask,
  tasksById: ReadonlyMap<string, TeamTask>,
  seen = new Set<string>(),
): number {
  if (seen.has(task.taskId)) return 0;
  seen.add(task.taskId);
  let depth = 0;
  for (const dep of task.dependencies) {
    const dependency = tasksById.get(dep);
    if (dependency) {
      depth = Math.max(depth, criticalPathDepth(dependency, tasksById, new Set(seen)));
    }
  }
  return depth + 1;
}
