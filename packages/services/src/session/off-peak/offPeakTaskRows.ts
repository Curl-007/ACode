/* off-peak 任务行映射：off_peak_tasks 行类型、行→领域模型投影、ModelSelection 读写
   与单行读取助手。原为 offPeakTaskRepo.ts 内部实现，拆分后供各仓库叶子共用。 */
import {
  OFF_PEAK_TERMINAL_STATUSES,
  modelSelectionSchema,
  type ACodeOffPeakTask,
  type ACodeOffPeakTaskStatus,
  type ACodeTaskMode,
} from "@acode/shared";
import type { DatabaseSyncInstance } from "#src/session/off-peak/offPeakTaskDatabase.js";

/** 终态 SQL IN 片段；OFF_PEAK_TERMINAL_STATUSES 的单一来源投影。 */
export const TERMINAL_SQL_LIST = OFF_PEAK_TERMINAL_STATUSES.map((s) => `'${s}'`).join(", ");

export interface OffPeakTaskRow {
  off_peak_task_id: string;
  server_ticket_id: string | null;
  title: string;
  conversation_id: string | null;
  session_id: string | null;
  /** list() 联查 tasks-index 得到的绑定会话标题；单行读取不带该列。 */
  session_title?: string | null;
  prompt: string;
  permission_mode: string;
  model: string | null;
  thought_level: string | null;
  model_selection: string | null;
  workspace_key: string;
  workspace_path: string;
  workspace_identity: string | null;
  status: string;
  queued_at: number;
  started_at: number | null;
  ended_at: number | null;
  failure_reason: string | null;
  files_changed: number | null;
  settled_at: number | null;
  history_deleted_at: number | null;
  registered_at: number | null;
  schedulable: number;
  queue_position: number | null;
  next_poll_at: number | null;
  claim_running: number;
  claimed_at: number | null;
  attempt_count: number;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

export function rowToTask(row: OffPeakTaskRow): ACodeOffPeakTask {
  const modelSelection = readOffPeakModelSelection(row);
  return {
    offPeakTaskId: row.off_peak_task_id,
    serverTicketId: row.server_ticket_id ?? undefined,
    title: row.title,
    conversationId: row.conversation_id ?? undefined,
    sessionId: row.session_id ?? undefined,
    ...(row.session_title ? { sessionTitle: row.session_title } : {}),
    prompt: row.prompt,
    permissionMode: row.permission_mode as ACodeTaskMode,
    ...(modelSelection ? { modelSelection } : {}),
    ...(!modelSelection
      ? {
          modelSelectionIssue: {
            code: "repair-required" as const,
          },
        }
      : {}),
    workspaceKey: row.workspace_key,
    workspacePath: row.workspace_path,
    workspaceIdentity: row.workspace_identity ?? undefined,
    status: row.status as ACodeOffPeakTaskStatus,
    queuedAt: row.queued_at,
    startedAt: row.started_at ?? undefined,
    endedAt: row.ended_at ?? undefined,
    failureReason: row.failure_reason ?? undefined,
    filesChanged: row.files_changed ?? undefined,
    settledAt: row.settled_at ?? undefined,
    historyDeletedAt: row.history_deleted_at ?? undefined,
    registeredAt: row.registered_at ?? undefined,
    schedulable: row.schedulable === 1,
    queuePosition: row.queue_position ?? undefined,
    nextPollAt: row.next_poll_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function readOffPeakModelSelection(
  row: OffPeakTaskRow,
): ACodeOffPeakTask["modelSelection"] | null {
  if (row.model_selection) {
    try {
      const parsed = modelSelectionSchema.safeParse(JSON.parse(row.model_selection));
      if (parsed.success) return parsed.data;
    } catch {
      // 继续尝试已发布旧列的单向导入。
    }
  }
  // 旧单列没有 Provider Family，不能安全迁移到任一新 Off-Peak Provider。
  return null;
}

export function serializeOffPeakModelSelection(
  selection: NonNullable<ACodeOffPeakTask["modelSelection"]>,
): string {
  const options = selection.options;
  return JSON.stringify(
    modelSelectionSchema.parse({
      providerId: selection.providerId,
      modelId: selection.modelId,
      ...(options && Object.keys(options).length > 0 ? { options } : {}),
    }),
  );
}

/** 单行读取（原 Repo.getRow）；找不到返回 null。 */
export function readOffPeakTaskRow(
  db: DatabaseSyncInstance,
  offPeakTaskId: string,
): OffPeakTaskRow | null {
  const row = db
    .prepare(`SELECT * FROM off_peak_tasks WHERE off_peak_task_id = ?`)
    .get(offPeakTaskId) as OffPeakTaskRow | undefined;
  return row ?? null;
}

/** INSERT 撞上 idx_off_peak_bound_active（并发双创建的失败方）。 */
export function isOffPeakBoundSessionConflict(error: unknown): boolean {
  return (
    error instanceof Error &&
    /UNIQUE constraint failed: off_peak_tasks\.workspace_key, off_peak_tasks\.session_id/.test(
      error.message,
    )
  );
}
