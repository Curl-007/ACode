import type { TaskAttempt, TeamTask } from "./types.js";

/**
 * 「成员当前可审任务」锚定（R1.1 / R1.2 共用，EI-2 单一实现）。
 *
 * 语义：锚点 = 该成员**持有活 attempt 的任务**——`activeAttemptId` 指向一个
 * `owner === member` 的 attempt。attempt 是否已 `endedAt` **不是**判据：
 * 成员汇报 `update_task(done)` 时正会写 `endedAt`，而任务落 `in_review` 后仍需队长验收
 * （锚点必须仍然成立）。真正让锚点失效的是任务状态离开候选集、或 `activeAttemptId`
 * 被清空（reassign）/指向新 attempt（重新认领）——那时旧 attempt 上下文审新交付会报
 * `stale_attempt`（EI-40 磁盘为准）。
 *
 * 状态优先级：`in_review` 优先、否则 `in_progress`。批次 0（无 `in_review` 态）只有
 * `in_progress` 能命中；批次 1 把汇报落到 `in_review` 后，同一常量即让待验收任务优先成锚。
 */
export const ACCEPTANCE_ANCHOR_STATUSES: readonly string[] = ["in_review", "in_progress"];

export interface AcceptanceAnchor {
  readonly task: TeamTask;
  readonly attempt: TaskAttempt;
}

/** 活 attempt：activeAttemptId 指向、owner 匹配（endedAt 不是判据，见上）。 */
function liveAttempt(task: TeamTask, member: string, attemptId?: string): TaskAttempt | undefined {
  const attempt = task.attempts.find((item) => item.id === task.activeAttemptId);
  if (!attempt || attempt.owner !== member) return undefined;
  if (attemptId !== undefined && attempt.id !== attemptId) return undefined;
  return attempt;
}

/**
 * 解析锚点。`attemptId` 显式给出（OQ-2 additive）时只匹配该 attempt 的活任务，用于成员同时
 * 持有多个候选任务（批次 1 的 OQ-9）时消歧；缺省按状态优先级取第一个候选。
 * 无候选 → undefined（上层报 `stale_attempt`）。
 */
export function resolveAcceptanceAnchor(
  tasks: readonly TeamTask[],
  member: string,
  attemptId?: string,
): AcceptanceAnchor | undefined {
  for (const preferred of ACCEPTANCE_ANCHOR_STATUSES) {
    for (const task of tasks) {
      const status: string = task.status;
      if (status !== preferred) continue;
      const attempt = liveAttempt(task, member, attemptId);
      if (attempt) return { task, attempt };
    }
  }
  return undefined;
}