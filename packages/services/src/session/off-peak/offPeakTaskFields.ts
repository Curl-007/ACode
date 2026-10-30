/* off-peak 任务可编辑字段与调度快照写入：Registry 失效降级、窗口期编辑与
   轮询/重新取号写回。原为 OffPeakTaskRepo 的方法体，拆分后由本体包装方法委托调用。 */
import type { ACodeOffPeakTask } from "@acode/shared";
import type { DatabaseSyncInstance } from "#src/session/off-peak/offPeakTaskDatabase.js";
import {
  readOffPeakModelSelection,
  readOffPeakTaskRow,
  rowToTask,
  serializeOffPeakModelSelection,
} from "#src/session/off-peak/offPeakTaskRows.js";

/**
 * Registry 变化使已保存 Selection 失效时，保留原模型与档位供用户修复或后续可靠恢复，
 * 同时清空正式 Selection 并撤销可调度状态，避免旧配置继续被 scheduler 认领。
 */
export function invalidateOffPeakModelSelection(
  db: DatabaseSyncInstance,
  offPeakTaskId: string,
  modelSelection: NonNullable<ACodeOffPeakTask["modelSelection"]>,
  options?: { now?: number },
): ACodeOffPeakTask | null {
  db.exec("BEGIN IMMEDIATE");
  try {
    const current = readOffPeakTaskRow(db, offPeakTaskId);
    if (!current) {
      db.exec("COMMIT");
      return null;
    }
    const currentSelection = readOffPeakModelSelection(current);
    if (
      currentSelection &&
      (currentSelection.providerId !== modelSelection.providerId ||
        currentSelection.modelId !== modelSelection.modelId ||
        currentSelection.options?.reasoningLevel !== modelSelection.options?.reasoningLevel)
    ) {
      // 另一进程已完成用户修复，以更新后的值为准，不能用旧 Registry 观察覆盖它。
      db.exec("COMMIT");
      return rowToTask(current);
    }
    db.prepare(
      `UPDATE off_peak_tasks
       SET model = @model, thought_level = @thought_level,
           model_selection = NULL, schedulable = 0, updated_at = @now
       WHERE off_peak_task_id = @id`,
    ).run({
      id: offPeakTaskId,
      model: modelSelection.modelId,
      thought_level: modelSelection.options?.reasoningLevel ?? null,
      now: options?.now ?? Date.now(),
    });
    const invalidated = readOffPeakTaskRow(db, offPeakTaskId);
    db.exec("COMMIT");
    return invalidated ? rowToTask(invalidated) : null;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export interface OffPeakEditableFieldsPatch {
  title?: string;
  prompt?: string;
  permissionMode?: string;
  modelSelection?: ACodeOffPeakTask["modelSelection"] | null;
}

/**
 * 编辑窗口期字段：仅 queued/paused 可编辑；票只锁队列身份，prompt 派发时才读。
 * modelSelection 只能替换为另一份明确 Selection；undefined = 不改。
 */
export function updateOffPeakEditableFields(
  db: DatabaseSyncInstance,
  offPeakTaskId: string,
  params: OffPeakEditableFieldsPatch,
  options?: { now?: number },
): ACodeOffPeakTask | null {
  const row = readOffPeakTaskRow(db, offPeakTaskId);
  if (!row) return null;
  if (row.status !== "queued" && row.status !== "paused") return null;
  if (params.modelSelection === null) return null;
  const nextModelSelection = params.modelSelection ?? readOffPeakModelSelection(row);
  if (!nextModelSelection) {
    throw new Error(`Off-Peak task 缺少有效 ModelSelection: ${offPeakTaskId}`);
  }
  // 旧列是已发布版本的回滚快照，不能因普通编辑被清空；本更新只改 model_selection，
  // 不反向改写旧身份/档位，也不为新记录伪造旧值。
  db.prepare(
    `UPDATE off_peak_tasks SET
      title = @title, prompt = @prompt, permission_mode = @permission_mode,
      model_selection = @model_selection, updated_at = @now
    WHERE off_peak_task_id = @id`,
  ).run({
    id: offPeakTaskId,
    title: params.title ?? row.title,
    prompt: params.prompt ?? row.prompt,
    permission_mode: params.permissionMode ?? row.permission_mode,
    model_selection: serializeOffPeakModelSelection(nextModelSelection),
    now: options?.now ?? Date.now(),
  });
  return rowToTask(readOffPeakTaskRow(db, offPeakTaskId)!);
}

export interface OffPeakSchedulingSnapshotPatch {
  schedulable?: boolean;
  queuePosition?: number | null;
  nextPollAt?: number | null;
  serverTicketId?: string;
  registeredAt?: number;
  now?: number;
}

/** 轮询/重新取号写回：仅覆盖显式传入的字段。 */
export function updateOffPeakSchedulingSnapshot(
  db: DatabaseSyncInstance,
  offPeakTaskId: string,
  patch: OffPeakSchedulingSnapshotPatch,
): void {
  const row = readOffPeakTaskRow(db, offPeakTaskId);
  if (!row) return;
  db.prepare(
    `UPDATE off_peak_tasks SET
      schedulable = @schedulable,
      queue_position = @queue_position,
      next_poll_at = @next_poll_at,
      server_ticket_id = @server_ticket_id,
      registered_at = @registered_at,
      updated_at = @now
    WHERE off_peak_task_id = @id`,
  ).run({
    id: offPeakTaskId,
    schedulable: patch.schedulable === undefined ? row.schedulable : patch.schedulable ? 1 : 0,
    queue_position: patch.queuePosition === undefined ? row.queue_position : patch.queuePosition,
    next_poll_at: patch.nextPollAt === undefined ? row.next_poll_at : patch.nextPollAt,
    server_ticket_id: patch.serverTicketId ?? row.server_ticket_id,
    registered_at: patch.registeredAt ?? row.registered_at,
    now: patch.now ?? Date.now(),
  });
}
