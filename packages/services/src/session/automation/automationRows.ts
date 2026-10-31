import {
  modelSelectionSchema,
  acodeTaskModeSchema,
  type ACodeAutomation,
  type ACodeAutomationLifecycleStatus,
  type ACodeAutomationDispatchStatus,
  type ModelSelection,
  type ACodeAutomationRun,
  type ACodeAutomationRunDispatchStatus,
  type ACodeAutomationRunOutcome,
  type ACodeAutomationNotifyDecision,
  type ACodeAutomationTrigger,
} from "@acode/shared";

// automation 仓库的 sqlite 行形状与行→域模型映射（2026-10-30 自 automationRepo.ts 拆出）。
// 纯函数与类型叶子：无 node: 导入，供 Node-only 的仓库分段与 facade 复用。

export interface AutomationRow {
  automation_id: string;
  title: string;
  cron_expr: string;
  prompt: string;
  model: string | null;
  provider: string | null;
  mode: string | null;
  thought_level: string | null;
  model_selection: string | null;
  workspace_key: string;
  workspace_path: string;
  workspace_identity: string | null;
  target_task_id: string | null;
  bot_delivery_target: string | null;
  location_kind: string;
  recurring: number;
  max_runs: number | null;
  end_at: number | null;
  schedule_rule: string | null;
  schedule_edited_by_user: number;
  run_count: number;
  scheduled_run_count: number;
  enabled: number;
  lifecycle_status: string;
  next_run_at: number | null;
  last_run_at: number | null;
  running: number;
  claimed_at: number | null;
  dispatch_status: string;
  dispatch_attempts: number;
  retry_at: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

export interface AutomationRunRow {
  run_id: string;
  automation_id: string;
  workspace_key: string;
  scheduled_at: number | null;
  trigger: string;
  model_selection: string | null;
  dispatch_status: string;
  outcome: string | null;
  notify_decision: string | null;
  session_id: string | null;
  error: string | null;
  attempts: number;
  created_at: number;
  updated_at: number;
}

export interface ClaimedManualAutomationRun {
  automation: ACodeAutomation;
  run: ACodeAutomationRun;
}

export function rowToAutomation(row: AutomationRow): ACodeAutomation {
  const modelSelection = readAutomationModelSelection(row);
  return {
    automationId: row.automation_id,
    title: row.title,
    cronExpr: row.cron_expr,
    prompt: row.prompt,
    ...(modelSelection ? { modelSelection } : {}),
    // 历史版本曾把空字符串写进 mode，旧读取逻辑又直接强转为枚举，导致
    // automation/list 在协议层校验整个数组时被单条脏数据拖垮。历史非法值按未设置兼容。
    mode: normalizeAutomationMode(row.mode),
    workspaceKey: row.workspace_key,
    workspacePath: row.workspace_path,
    workspaceIdentity: row.workspace_identity ?? undefined,
    targetTaskId: row.target_task_id ?? undefined,
    locationKind: row.location_kind === "remote" ? "remote" : "local",
    recurring: row.recurring === 1,
    maxRuns: row.max_runs ?? undefined,
    endAt: row.end_at ?? undefined,
    scheduleRule: row.schedule_rule
      ? (JSON.parse(row.schedule_rule) as ACodeAutomation["scheduleRule"])
      : undefined,
    ...(row.schedule_edited_by_user === 1 ? { scheduleEditedByUser: true } : {}),
    runCount: row.run_count,
    enabled: row.enabled === 1,
    lifecycleStatus: row.lifecycle_status as ACodeAutomationLifecycleStatus,
    nextRunAt: row.next_run_at ?? undefined,
    lastRunAt: row.last_run_at ?? undefined,
    dispatchStatus: row.dispatch_status as ACodeAutomationDispatchStatus,
    dispatchAttempts: row.dispatch_attempts,
    retryAt: row.retry_at ?? undefined,
    lastError: row.last_error ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function readAutomationModelSelection(
  row: AutomationRow,
): ACodeAutomation["modelSelection"] {
  // 旧字段只能经过独立 importer；新字段损坏或明确清空时不能复活旧选择。
  return readSerializedModelSelection(row.model_selection);
}

export function serializeAutomationModelSelection(
  selection: ACodeAutomation["modelSelection"],
): string | null {
  if (!selection) return null;
  const options = selection.options;
  const parsed = modelSelectionSchema.parse({
    providerId: selection.providerId,
    modelId: selection.modelId,
    ...(options && Object.keys(options).length > 0 ? { options } : {}),
  });
  return JSON.stringify(parsed);
}

function normalizeAutomationMode(mode: string | null): ACodeAutomation["mode"] | undefined {
  const parsed = acodeTaskModeSchema.safeParse(mode);
  return parsed.success ? parsed.data : undefined;
}

export function assertValidAutomationMode(mode: unknown): void {
  if (mode === undefined || mode === null) return;
  if (!acodeTaskModeSchema.safeParse(mode).success) {
    // 读取兼容历史脏数据不代表允许继续写脏数据；Repo 是绕过 RPC 时的最终持久化边界。
    throw new Error(`Invalid automation mode: ${String(mode)}`);
  }
}

export function rowToRun(row: AutomationRunRow): ACodeAutomationRun {
  const modelSelection = readSerializedModelSelection(row.model_selection);
  return {
    runId: row.run_id,
    automationId: row.automation_id,
    workspaceKey: row.workspace_key,
    scheduledAt: row.scheduled_at ?? undefined,
    trigger: row.trigger as ACodeAutomationTrigger,
    ...(modelSelection ? { modelSelection } : {}),
    dispatchStatus: row.dispatch_status as ACodeAutomationRunDispatchStatus,
    outcome: (row.outcome as ACodeAutomationRunOutcome | null) ?? undefined,
    notifyDecision: (row.notify_decision as ACodeAutomationNotifyDecision | null) ?? undefined,
    sessionId: row.session_id ?? undefined,
    error: row.error ?? undefined,
    attempts: row.attempts,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function readSerializedModelSelection(value: string | null): ModelSelection | undefined {
  if (!value) return undefined;
  try {
    const parsed = modelSelectionSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
