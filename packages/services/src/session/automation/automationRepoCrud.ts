import { randomUUID } from "node:crypto";
import {
  AUTOMATION_CREATE_LIMIT,
  resolveWorkspaceKey,
  acodeAutomationBotDeliveryTargetSchema,
  type ACodeAutomation,
  type ACodeAutomationBotDeliveryTarget,
  type ACodeAutomationCreateParams,
  type ACodeAutomationLifecycleStatus,
  type ModelSelection,
  type ACodeAutomationUpdateParams,
} from "@acode/shared";
import { AutomationCreateLimitError } from "#src/session/automation/automationDispatchPolicy.js";
import { AutomationRepoBase } from "#src/session/automation/automationRepoBase.js";
import {
  rowToAutomation,
  readAutomationModelSelection,
  serializeAutomationModelSelection,
  assertValidAutomationMode,
  type AutomationRow,
} from "#src/session/automation/automationRows.js";

/**
 * 管理面 CRUD 分段（2026-10-30 自 automationRepo.ts 拆出）：定义读写、模型选择读取、
 * task 绑定查询与暂停/恢复/重启。仓库只做存储与原子状态迁移；cron 表达式解析 /
 * next_run_at 计算由调用方（scheduler / 管理层）用 cron 库算好后传入，仓库不感知 cron 语义。
 */
export class AutomationRepoCrud extends AutomationRepoBase {
  // ---- 管理 CRUD ----

  async create(
    params: ACodeAutomationCreateParams,
    options: { nextRunAt: number | null; lifecycleStatus?: ACodeAutomationLifecycleStatus },
  ): Promise<ACodeAutomation> {
    assertValidAutomationMode(params.mode);
    await this.ensureReady();
    const now = Date.now();
    const automationId = `automation-${randomUUID()}`;
    const workspaceKey = resolveWorkspaceKey({
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity,
    });
    const db = this.getDatabase();
    // 仅在 UI 或事务外先 list 再 create，会让多窗口/CronCreate 并发请求同时通过旧计数。
    // BEGIN IMMEDIATE 串行化“全状态总数检查 + 插入”，确保本地任务索引不会突破 20 条。
    db.exec("BEGIN IMMEDIATE");
    try {
      const countRow = db.prepare("SELECT COUNT(*) AS count FROM automations").get() as {
        count: number | bigint;
      };
      if (Number(countRow.count) >= AUTOMATION_CREATE_LIMIT) {
        throw new AutomationCreateLimitError();
      }
      db.prepare(
        `INSERT INTO automations (
          automation_id, title, cron_expr, prompt, model, provider, model_selection,
          workspace_key, workspace_path, workspace_identity, target_task_id, bot_delivery_target, location_kind,
          recurring, max_runs, end_at, schedule_rule, schedule_edited_by_user,
          run_count, enabled, lifecycle_status,
          next_run_at, last_run_at, running, claimed_at,
          dispatch_status, dispatch_attempts, retry_at, last_error,
          mode, thought_level,
          created_at, updated_at
        ) VALUES (
          @automation_id, @title, @cron_expr, @prompt, @model, @provider, @model_selection,
          @workspace_key, @workspace_path, @workspace_identity, @target_task_id, @bot_delivery_target, 'local',
          @recurring, @max_runs, @end_at, @schedule_rule, 0,
          0, @enabled, @lifecycle_status,
          @next_run_at, NULL, 0, NULL,
          'idle', 0, NULL, NULL,
          @mode, @thought_level,
          @created_at, @updated_at
        )`,
      ).run({
        automation_id: automationId,
        title: params.title,
        cron_expr: params.cronExpr,
        prompt: params.prompt,
        model: null,
        provider: null,
        // 任务配置的显式空值与尚未迁移的 SQL NULL 分开；run 的 SQL NULL 冻结语义不变。
        model_selection: serializeAutomationModelSelection(params.modelSelection) ?? "null",
        mode: params.mode ?? null,
        thought_level: null,
        workspace_key: workspaceKey,
        workspace_path: params.workspacePath,
        workspace_identity: params.workspaceIdentity ?? null,
        target_task_id: params.targetTaskId ?? null,
        bot_delivery_target: params.botDeliveryTarget
          ? JSON.stringify(params.botDeliveryTarget)
          : null,
        recurring: params.recurring ? 1 : 0,
        max_runs: params.maxRuns ?? null,
        end_at: params.endAt ?? null,
        schedule_rule: params.scheduleRule ? JSON.stringify(params.scheduleRule) : null,
        enabled: options.lifecycleStatus === "completed" ? 0 : 1,
        lifecycle_status: options.lifecycleStatus ?? "active",
        next_run_at: options.nextRunAt,
        created_at: now,
        updated_at: now,
      });
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return rowToAutomation(this.getRow(automationId)!);
  }

  async list(scope?: {
    workspacePath?: string;
    workspaceIdentity?: string;
  }): Promise<ACodeAutomation[]> {
    await this.ensureReady();
    const workspaceKey = scope?.workspacePath
      ? resolveWorkspaceKey({
          workspacePath: scope.workspacePath,
          workspaceIdentity: scope.workspaceIdentity,
        })
      : null;
    const rows = this.getDatabase()
      .prepare(
        `SELECT * FROM automations
        WHERE (@workspace_key IS NULL OR workspace_key = @workspace_key)
        ORDER BY created_at DESC`,
      )
      .all({ workspace_key: workspaceKey }) as unknown as AutomationRow[];
    return rows.map(rowToAutomation);
  }

  /** 首次派发专用读取：列表可以展示未绑定任务，但派发不能把损坏值当成跟随默认。 */
  async getModelSelectionForDispatch(
    automationId: string,
    workspaceKey: string,
  ): Promise<ModelSelection | undefined> {
    await this.ensureReady();
    const row = this.getRow(automationId, workspaceKey);
    if (!row) throw new Error("Automation 不存在或不属于当前工作区");
    const selection = readAutomationModelSelection(row);
    if (selection) return selection;
    // 迁移已把旧默认写为 JSON null。SQL NULL 是缺配置，不能借旧列决定执行默认值。
    const followsWorkspace = row.model_selection === "null";
    if (!followsWorkspace) throw new Error("Automation 模型选择不可用，请重新选择模型与思考档位");
    return undefined;
  }

  /**
   * 仅供后台派发读取 Bot 回推目标；该内部来源信息不进入 automation 展示模型。
   */
  async getBotDeliveryTarget(
    automationId: string,
    workspaceKey?: string,
  ): Promise<ACodeAutomationBotDeliveryTarget | undefined> {
    await this.ensureReady();
    const raw = this.getRow(automationId, workspaceKey)?.bot_delivery_target;
    if (!raw) return undefined;
    try {
      const parsed = acodeAutomationBotDeliveryTargetSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : undefined;
    } catch {
      // Bug 原因：历史/外部写入的脏 JSON 不能拖垮任务列表或 scheduler；无效来源按未配置处理。
      return undefined;
    }
  }

  async hasTaskBinding(scope: {
    workspacePath: string;
    workspaceIdentity?: string;
    targetTaskId: string;
  }): Promise<boolean> {
    await this.ensureReady();
    const workspaceKey = resolveWorkspaceKey(scope);
    // CronCreate 过去为判断一个 session 的归属而读取并序列化完整列表，任意无关
    // 展示字段损坏都会让安全查询失败。这里仅查询授权判据本身，并严格限定 workspaceKey。
    const row = this.getDatabase()
      .prepare(
        `SELECT 1 AS bound FROM automations
        WHERE workspace_key = @workspace_key AND target_task_id = @target_task_id
        LIMIT 1`,
      )
      .get({ workspace_key: workspaceKey, target_task_id: scope.targetTaskId }) as
      | { bound: number }
      | undefined;
    return row !== undefined;
  }

  async get(automationId: string, workspaceKey?: string): Promise<ACodeAutomation | null> {
    await this.ensureReady();
    const row = this.getRow(automationId, workspaceKey);
    return row ? rowToAutomation(row) : null;
  }

  /** maxRuns 的生命周期口径只统计定时派发；manual run 仅属于 Card 累计展示。 */
  async getScheduledRunCount(automationId: string, workspaceKey?: string): Promise<number | null> {
    await this.ensureReady();
    const row = this.getRow(automationId, workspaceKey);
    return row?.scheduled_run_count ?? null;
  }

  /**
   * 编辑定义字段。调用方按需传入重算后的 nextRunAt（改 cron_expr 时）与新的 lifecycleStatus
   * （改 recurring/max_runs 时），仓库不感知 cron 语义。改 cron_expr 时清空 retry 态。
   */
  async update(
    automationId: string,
    params: ACodeAutomationUpdateParams,
    options?: {
      nextRunAt?: number | null;
      lifecycleStatus?: ACodeAutomationLifecycleStatus;
      resetRetry?: boolean;
    },
    workspaceKey?: string,
  ): Promise<ACodeAutomation | null> {
    assertValidAutomationMode(params.mode);
    await this.ensureReady();
    const existing = this.getRow(automationId, workspaceKey);
    if (!existing) return null;
    const now = Date.now();
    const next: AutomationRow = {
      ...existing,
      title: params.title ?? existing.title,
      cron_expr: params.cronExpr ?? existing.cron_expr,
      prompt: params.prompt ?? existing.prompt,
      // 旧三列只供回滚保留；标题等编辑不能清除尚未迁入的旧选择，也不能参与新版运行读取。
      model: existing.model,
      provider: existing.provider,
      model_selection:
        params.modelSelection === undefined
          ? existing.model_selection
          : (serializeAutomationModelSelection(params.modelSelection ?? undefined) ?? "null"),
      mode: params.mode === undefined ? existing.mode : params.mode,
      thought_level: existing.thought_level,
      recurring: params.recurring === undefined ? existing.recurring : params.recurring ? 1 : 0,
      max_runs: params.maxRuns === undefined ? existing.max_runs : params.maxRuns,
      end_at: params.endAt === undefined ? existing.end_at : params.endAt,
      schedule_rule:
        params.scheduleRule === undefined
          ? existing.schedule_rule
          : params.scheduleRule
            ? JSON.stringify(params.scheduleRule)
            : null,
      schedule_edited_by_user:
        params.scheduleEditedByUser === undefined
          ? existing.schedule_edited_by_user
          : params.scheduleEditedByUser
            ? 1
            : 0,
      next_run_at: options?.nextRunAt === undefined ? existing.next_run_at : options.nextRunAt,
      lifecycle_status: options?.lifecycleStatus ?? existing.lifecycle_status,
      dispatch_attempts: options?.resetRetry ? 0 : existing.dispatch_attempts,
      retry_at: options?.resetRetry ? null : existing.retry_at,
      dispatch_status: options?.resetRetry ? "idle" : existing.dispatch_status,
      // enabled 完整由 lifecycleStatus 推导：仅当调用方显式改了生命周期时才动它
      // （active→入调度=1；completed/failed/paused→出调度=0），否则保持原值。
      // 修复：原实现在 completed/failed 时错误保留 existing.enabled，可能出现「已完成但仍被 claimDue 认领」。
      enabled: options?.lifecycleStatus
        ? options.lifecycleStatus === "active"
          ? 1
          : 0
        : existing.enabled,
      updated_at: now,
    };
    this.writeRow(next);
    return rowToAutomation(next);
  }

  async delete(automationId: string, workspaceKey?: string): Promise<boolean> {
    await this.ensureReady();
    const result = this.getDatabase()
      .prepare(
        `DELETE FROM automations
        WHERE automation_id = @id
          AND (@workspace_key IS NULL OR workspace_key = @workspace_key)`,
      )
      .run({ id: automationId, workspace_key: workspaceKey ?? null });
    return result.changes > 0;
  }

  /** 暂停 / 恢复。paused ↔ active，保留 next_run_at / run_count。 */
  async setEnabled(automationId: string, enabled: boolean, workspaceKey?: string): Promise<void> {
    await this.ensureReady();
    this.getDatabase()
      .prepare(
        `UPDATE automations
        SET enabled = @enabled,
            lifecycle_status = @lifecycle_status,
            updated_at = @now
        WHERE automation_id = @id
          AND (@workspace_key IS NULL OR workspace_key = @workspace_key)`,
      )
      .run({
        id: automationId,
        enabled: enabled ? 1 : 0,
        lifecycle_status: enabled ? "active" : "paused",
        now: Date.now(),
        workspace_key: workspaceKey ?? null,
      });
  }

  /** 终态任务手动重跑：回 active、清计数与重试态，nextRunAt 由调用方重算传入。 */
  async restart(
    automationId: string,
    options: { nextRunAt: number | null },
    workspaceKey?: string,
  ): Promise<void> {
    await this.ensureReady();
    this.getDatabase()
      .prepare(
        `UPDATE automations
        SET lifecycle_status = 'active',
            enabled = 1,
            run_count = 0,
            scheduled_run_count = 0,
            dispatch_attempts = 0,
            retry_at = NULL,
            dispatch_status = 'idle',
            running = 0,
            claimed_at = NULL,
            next_run_at = @next_run_at,
            last_error = NULL,
            updated_at = @now
        WHERE automation_id = @id
          AND (@workspace_key IS NULL OR workspace_key = @workspace_key)`,
      )
      .run({
        id: automationId,
        next_run_at: options.nextRunAt,
        now: Date.now(),
        workspace_key: workspaceKey ?? null,
      });
  }
}
