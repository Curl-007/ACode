import type {
  ModelSelection,
  ACodeAutomationRun,
  ACodeAutomationRunDispatchStatus,
  ACodeAutomationRunOutcome,
  ACodeAutomationNotifyDecision,
  ACodeAutomationTrigger,
} from "@acode/shared";
import { AutomationRepoDispatch } from "#src/session/automation/automationRepoDispatch.js";
import {
  rowToRun,
  readSerializedModelSelection,
  serializeAutomationModelSelection,
  type AutomationRunRow,
} from "#src/session/automation/automationRows.js";

/**
 * 运行历史 automation_runs 分段（2026-10-30 自 automationRepo.ts 拆出）：runId 幂等台账、
 * 派发/结果回写与保留策略。run_id 冲突即命中本轮 retry，不新建行。
 */
export class AutomationRepoRuns extends AutomationRepoDispatch {
  // ---- 运行历史 automation_runs ----

  /** 确保 run 历史存在。用于 host outcome 回写兜底，不增加 attempts，避免和 scheduler retry 计数互相污染。 */
  async ensureRunClaimed(params: {
    runId: string;
    automationId: string;
    workspaceKey: string;
    scheduledAt: number | null;
    trigger: ACodeAutomationTrigger;
  }): Promise<void> {
    await this.ensureReady();
    const now = Date.now();
    this.getDatabase()
      .prepare(
        `INSERT INTO automation_runs (
          run_id, automation_id, workspace_key, scheduled_at, trigger,
          dispatch_status, attempts, created_at, updated_at
        ) VALUES (@run_id, @automation_id, @workspace_key, @scheduled_at, @trigger, 'claimed', 0, @now, @now)
        ON CONFLICT(run_id) DO NOTHING`,
      )
      .run({
        run_id: params.runId,
        automation_id: params.automationId,
        workspace_key: params.workspaceKey,
        scheduled_at: params.scheduledAt,
        trigger: params.trigger,
        now,
      });
  }

  /** 认领时 upsert 一行 run（run_id 冲突即命中本轮 retry，不新建）。 */
  async upsertRunClaimed(params: {
    runId: string;
    automationId: string;
    workspaceKey: string;
    scheduledAt: number | null;
    trigger: ACodeAutomationTrigger;
    modelSelection?: ModelSelection;
  }): Promise<void> {
    await this.ensureReady();
    const now = Date.now();
    this.getDatabase()
      .prepare(
        `INSERT INTO automation_runs (
          run_id, automation_id, workspace_key, scheduled_at, trigger,
          model_selection, dispatch_status, attempts, created_at, updated_at
        ) VALUES (@run_id, @automation_id, @workspace_key, @scheduled_at, @trigger, @model_selection, 'claimed', 0, @now, @now)
        ON CONFLICT(run_id) DO UPDATE SET
          dispatch_status = 'claimed',
          model_selection = COALESCE(automation_runs.model_selection, excluded.model_selection),
          outcome = NULL,
          notify_decision = NULL,
          error = NULL,
          attempts = attempts + 1,
          updated_at = excluded.updated_at`,
      )
      .run({
        run_id: params.runId,
        automation_id: params.automationId,
        workspace_key: params.workspaceKey,
        scheduled_at: params.scheduledAt,
        trigger: params.trigger,
        model_selection: serializeAutomationModelSelection(params.modelSelection),
        now,
      });
  }

  /**
   * Select 首次形成 Submission 时原子固定 run Selection；之后调用只能读回原值。
   * 旧派发在每次 transient retry 都重新读取 Host preferred，导致同一 run 换模型。
   */
  async fixRunModelSelection(runId: string, selection: ModelSelection): Promise<ModelSelection> {
    await this.ensureReady();
    const db = this.getDatabase();
    db.prepare(
      `UPDATE automation_runs
       SET model_selection = COALESCE(model_selection, @model_selection), updated_at = @now
       WHERE run_id = @run_id`,
    ).run({
      run_id: runId,
      model_selection: serializeAutomationModelSelection(selection),
      now: Date.now(),
    });
    const row = db
      .prepare(`SELECT model_selection FROM automation_runs WHERE run_id = @run_id`)
      .get({ run_id: runId }) as Pick<AutomationRunRow, "model_selection"> | undefined;
    const fixed = row ? readSerializedModelSelection(row.model_selection) : undefined;
    if (!fixed) throw new Error(`Automation run 不存在或无法固定模型选择: ${runId}`);
    return fixed;
  }

  /** 派发结果回写 run（dispatched 回填 session_id / failed_to_dispatch 记 error）。 */
  async markRunDispatch(params: {
    runId: string;
    dispatchStatus: ACodeAutomationRunDispatchStatus;
    sessionId?: string | null;
    error?: string | null;
  }): Promise<void> {
    await this.ensureReady();
    this.getDatabase()
      .prepare(
        `UPDATE automation_runs
        SET dispatch_status = @dispatch_status,
            session_id = COALESCE(@session_id, session_id),
            error = @error,
            updated_at = @now
        WHERE run_id = @run_id`,
      )
      .run({
        run_id: params.runId,
        dispatch_status: params.dispatchStatus,
        session_id: params.sessionId ?? null,
        error: params.error ?? null,
        now: Date.now(),
      });
  }

  /**
   * manual run 首次派发成功结算：原子更新 run 台账与累计运行次数。
   * 手动运行过去只更新 automation_runs，Card 的 runCount 因而只统计定时触发；
   * 同一个 runId 还可能由 direct host、scheduler 崩溃恢复或迟到回报重复结算，所以必须以
   * dispatch_status 首次进入 dispatched 作为幂等边界。manual 不推进 cron/maxRuns/lifecycle，
   * 也不释放 single-flight claim，claim 仍由真实 turn 终态收口。
   */
  async markManualRunDispatched(params: {
    runId: string;
    sessionId?: string | null;
    dispatchedAt: number;
  }): Promise<boolean> {
    await this.ensureReady();
    const db = this.getDatabase();
    db.exec("BEGIN IMMEDIATE");
    try {
      const run = db
        .prepare(
          `SELECT automation_id, workspace_key, dispatch_status
          FROM automation_runs
          WHERE run_id = @run_id AND trigger = 'manual'`,
        )
        .get({ run_id: params.runId }) as
        | Pick<AutomationRunRow, "automation_id" | "workspace_key" | "dispatch_status">
        | undefined;
      if (!run || run.dispatch_status === "dispatched") {
        db.exec("COMMIT");
        return false;
      }

      db.prepare(
        `UPDATE automation_runs
        SET dispatch_status = 'dispatched',
            session_id = COALESCE(@session_id, session_id),
            error = NULL,
            updated_at = @now
        WHERE run_id = @run_id AND trigger = 'manual' AND dispatch_status <> 'dispatched'`,
      ).run({
        run_id: params.runId,
        session_id: params.sessionId ?? null,
        now: params.dispatchedAt,
      });
      const automationUpdate = db
        .prepare(
          `UPDATE automations
          SET run_count = run_count + 1,
              last_run_at = @dispatched_at,
              updated_at = @now
          WHERE automation_id = @automation_id AND workspace_key = @workspace_key`,
        )
        .run({
          automation_id: run.automation_id,
          workspace_key: run.workspace_key,
          dispatched_at: params.dispatchedAt,
          now: params.dispatchedAt,
        });
      db.exec("COMMIT");
      return automationUpdate.changes > 0;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * session runtime 回写运行结果（running / succeeded / failed / stopped）。
   * notifyDecision 仅 settle 提供（heartbeat 协议 R4）；running 起始写与未提供时
   * 经 COALESCE 保留现值，不会被抹掉。
   */
  async markRunOutcome(
    runId: string,
    outcome: ACodeAutomationRunOutcome,
    error?: string,
    notifyDecision?: ACodeAutomationNotifyDecision,
  ): Promise<void> {
    await this.ensureReady();
    this.getDatabase()
      .prepare(
        `UPDATE automation_runs
        SET outcome = CASE
              WHEN @outcome = 'running' AND outcome IS NOT NULL AND outcome <> 'running' THEN outcome
              ELSE @outcome
            END,
            error = CASE
              WHEN @outcome = 'running' AND outcome IS NOT NULL AND outcome <> 'running' THEN error
              ELSE COALESCE(@error, error)
            END,
            notify_decision = COALESCE(@notify_decision, notify_decision),
            updated_at = @now
        WHERE run_id = @run_id`,
      )
      .run({
        run_id: runId,
        outcome,
        error: error ?? null,
        notify_decision: notifyDecision ?? null,
        now: Date.now(),
      });
  }

  /** 错过触发窗口：落一条 skipped run（session_id=null），不计 run_count。 */
  async recordSkippedRun(params: {
    runId: string;
    automationId: string;
    workspaceKey: string;
    scheduledAt: number | null;
    trigger: ACodeAutomationTrigger;
    reason: string;
  }): Promise<void> {
    await this.ensureReady();
    const now = Date.now();
    this.getDatabase()
      .prepare(
        `INSERT INTO automation_runs (
          run_id, automation_id, workspace_key, scheduled_at, trigger,
          dispatch_status, error, attempts, created_at, updated_at
        ) VALUES (@run_id, @automation_id, @workspace_key, @scheduled_at, @trigger, 'skipped', @reason, 0, @now, @now)
        ON CONFLICT(run_id) DO UPDATE SET
          dispatch_status = 'skipped', error = excluded.error, updated_at = excluded.updated_at`,
      )
      .run({
        run_id: params.runId,
        automation_id: params.automationId,
        workspace_key: params.workspaceKey,
        scheduled_at: params.scheduledAt,
        trigger: params.trigger,
        reason: params.reason,
        now,
      });
  }

  async listRuns(automationId: string, workspaceKey?: string): Promise<ACodeAutomationRun[]> {
    await this.ensureReady();
    const rows = this.getDatabase()
      .prepare(
        `SELECT * FROM automation_runs
        WHERE automation_id = @id
          AND (@workspace_key IS NULL OR workspace_key = @workspace_key)
        ORDER BY created_at DESC`,
      )
      .all({
        id: automationId,
        workspace_key: workspaceKey ?? null,
      }) as unknown as AutomationRunRow[];
    return rows.map(rowToRun);
  }

  async getRun(runId: string): Promise<ACodeAutomationRun | null> {
    await this.ensureReady();
    const row = this.getDatabase()
      .prepare(`SELECT * FROM automation_runs WHERE run_id = @run_id`)
      .get({ run_id: runId }) as AutomationRunRow | undefined;
    return row ? rowToRun(row) : null;
  }

  async deleteRun(runId: string, workspaceKey?: string): Promise<void> {
    await this.ensureReady();
    this.getDatabase()
      .prepare(
        `DELETE FROM automation_runs
        WHERE run_id = @run_id
          AND (@workspace_key IS NULL OR workspace_key = @workspace_key)`,
      )
      .run({ run_id: runId, workspace_key: workspaceKey ?? null });
  }

  /** 保留策略：删除超过 maxAgeMs 的历史 run（防无限增长）。 */
  async pruneRuns(maxAgeMs: number): Promise<number> {
    await this.ensureReady();
    const res = this.getDatabase()
      .prepare(`DELETE FROM automation_runs WHERE created_at < ?`)
      .run(Date.now() - maxAgeMs);
    return Number(res.changes ?? 0);
  }

  /**
   * 保留策略（heartbeat 协议 R5b）：删除耗尽（lifecycle completed）且过保留窗口的
   * automation 定义，释放 AUTOMATION_CREATE_LIMIT 额度（该上限计数含所有生命周期状态，
   * 僵尸 completed 会永久占坑）。failed/active/paused 不删——坏掉的任务用户要能看到。
   * 孤儿 run 行由 pruneRuns 的窗口清扫（automations 无级联外键，R5 已注明）。
   */
  async pruneExhaustedAutomations(maxAgeMs: number): Promise<number> {
    await this.ensureReady();
    const res = this.getDatabase()
      .prepare(`DELETE FROM automations WHERE lifecycle_status = 'completed' AND updated_at < ?`)
      .run(Date.now() - maxAgeMs);
    return Number(res.changes ?? 0);
  }
}
