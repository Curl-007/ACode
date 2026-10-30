import { randomUUID } from "node:crypto";
import type { ACodeAutomation } from "@acode/shared";
import { CLAIM_STALE_MS } from "#src/session/automation/automationDispatchPolicy.js";
import { AutomationRepoCrud } from "#src/session/automation/automationRepoCrud.js";
import {
  rowToAutomation,
  rowToRun,
  type AutomationRow,
  type ClaimedManualAutomationRun,
} from "#src/session/automation/automationRows.js";

/**
 * single-flight 认领分段（2026-10-30 自 automationRepo.ts 拆出）：到期认领、manual run
 * 入队与认领、僵尸认领回收。认领语义只认 running/claimed_at 两列，不另存第二份状态。
 */
export class AutomationRepoClaiming extends AutomationRepoCrud {
  // ---- 调度状态机 ----

  /**
   * 立即运行：写入由当前 host 直接持有的 manual run，不修改 automation 的 cron 计划/生命周期。
   * 直派路径过去没有占用 automation running 锁，连续点击会并发投递到同一个 target task，
   * 进而让模型配置 revision 互相踩踏。这里复用 scheduler 的 single-flight 锁；host 派发结算后释放。
   * attempts=1 表示已经交给直接派发方；scheduler 只会在认领超时后做崩溃恢复。
   */
  async runNow(
    automationId: string,
    options: { now: number },
    workspaceKey?: string,
  ): Promise<ClaimedManualAutomationRun | null> {
    await this.ensureReady();
    const db = this.getDatabase();
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(
        `UPDATE automations
        SET running = 0, claimed_at = NULL
        WHERE running = 1 AND claimed_at IS NOT NULL AND claimed_at <= @stale`,
      ).run({ stale: options.now - CLAIM_STALE_MS });

      const row = this.getRow(automationId, workspaceKey);
      if (!row) {
        db.exec("COMMIT");
        return null;
      }

      const claimed = db
        .prepare(
          `UPDATE automations
          SET running = 1, claimed_at = @now, updated_at = @now
          WHERE automation_id = @id
            AND running = 0
            AND (@workspace_key IS NULL OR workspace_key = @workspace_key)`,
        )
        .run({
          id: automationId,
          now: options.now,
          workspace_key: workspaceKey ?? null,
        });
      if (claimed.changes !== 1) {
        db.exec("COMMIT");
        return null;
      }

      const runId = `${automationId}:manual:${randomUUID()}`;
      db.prepare(
        `INSERT INTO automation_runs (
          run_id, automation_id, workspace_key, scheduled_at, trigger,
          model_selection, dispatch_status, attempts, created_at, updated_at
        ) VALUES (
          @run_id, @automation_id, @workspace_key, @scheduled_at, 'manual',
          @model_selection, 'claimed', 1, @now, @now
        )`,
      ).run({
        run_id: runId,
        automation_id: automationId,
        workspace_key: row.workspace_key,
        scheduled_at: options.now,
        // 认领尚未经过目标 Host 解析；原意图仍在 automation，run 等首次派发再固定。
        model_selection: null,
        now: options.now,
      });
      db.exec("COMMIT");
      return {
        automation: rowToAutomation({
          ...row,
          running: 1,
          claimed_at: options.now,
          updated_at: options.now,
        }),
        run: rowToRun({
          run_id: runId,
          automation_id: automationId,
          workspace_key: row.workspace_key,
          scheduled_at: options.now,
          trigger: "manual",
          model_selection: null,
          dispatch_status: "claimed",
          outcome: null,
          notify_decision: null,
          session_id: null,
          error: null,
          attempts: 1,
          created_at: options.now,
          updated_at: options.now,
        }),
      };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * single-flight 认领到期项：原子 running=0→1。同时回收认领超时（claimed_at 过期）的僵尸项。
   * due 判定同时看 next_run_at 与 retry_at，任一到期即 due。
   */
  async claimDue(now: number): Promise<ACodeAutomation[]> {
    await this.ensureReady();
    const db = this.getDatabase();
    db.exec("BEGIN IMMEDIATE");
    try {
      // 截止日期是计划边界；过期任务先转终态，避免继续被正常 cron 或 retry 认领。
      db.prepare(
        `UPDATE automations
        SET lifecycle_status = 'completed', enabled = 0, next_run_at = NULL,
            retry_at = NULL, running = 0, claimed_at = NULL, updated_at = @now
        WHERE enabled = 1 AND end_at IS NOT NULL AND end_at < @now`,
      ).run({ now });
      // 先回收僵尸认领（持有者崩溃，running=1 但 claimed_at 过期）。
      db.prepare(
        `UPDATE automations
        SET running = 0, claimed_at = NULL
        WHERE running = 1 AND claimed_at IS NOT NULL AND claimed_at <= @stale`,
      ).run({ stale: now - CLAIM_STALE_MS });
      // 认领条件：enabled 且未在途。
      // - 有 retry_at（transient 退避中）：只按 retry_at 到期认领，忽略 next_run_at——
      //   否则 next_run_at 仍停在过去会让退避被绕过、每 tick 立即重试。next_run_at 保持不变，
      //   保证重试复用同一个 runId（scheduler 以 next_run_at 作 scheduledAt）。
      // - 无 retry_at：按 next_run_at 到期认领。
      const dueRows = db
        .prepare(
          `SELECT * FROM automations
          WHERE enabled = 1 AND running = 0
            AND (
              (retry_at IS NOT NULL AND retry_at <= @now)
              OR (retry_at IS NULL AND next_run_at IS NOT NULL AND next_run_at <= @now)
            )`,
        )
        .all({ now }) as unknown as AutomationRow[];
      const claimed: ACodeAutomation[] = [];
      const claim = db.prepare(
        `UPDATE automations
        SET running = 1, claimed_at = @now, dispatch_status = 'claimed', updated_at = @now
        WHERE automation_id = @id AND running = 0`,
      );
      for (const row of dueRows) {
        const res = claim.run({ id: row.automation_id, now });
        if (res.changes === 1) {
          claimed.push(
            rowToAutomation({
              ...row,
              running: 1,
              claimed_at: now,
              dispatch_status: "claimed",
            }),
          );
        }
      }
      db.exec("COMMIT");
      return claimed;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * 认领 UI「立即运行」产生的 manual run。
   * 立即运行不能改 next_run_at，否则会污染原 cron 节奏；manual run 使用 automation_runs
   * 作队列，短暂占用 automation running 锁来避免和定时触发并发投递同一个 task。
   */
  async claimManualRuns(now: number): Promise<ClaimedManualAutomationRun[]> {
    await this.ensureReady();
    const db = this.getDatabase();
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(
        `UPDATE automations
        SET running = 0, claimed_at = NULL
        WHERE running = 1 AND claimed_at IS NOT NULL AND claimed_at <= @stale`,
      ).run({ stale: now - CLAIM_STALE_MS });

      const rows = db
        .prepare(
          `SELECT
            a.automation_id AS a_automation_id,
            a.title AS a_title,
            a.cron_expr AS a_cron_expr,
            a.prompt AS a_prompt,
            a.model AS a_model,
            a.provider AS a_provider,
            a.model_selection AS a_model_selection,
            a.mode AS a_mode,
            a.thought_level AS a_thought_level,
            a.workspace_key AS a_workspace_key,
            a.workspace_path AS a_workspace_path,
            a.workspace_identity AS a_workspace_identity,
            a.target_task_id AS a_target_task_id,
            a.location_kind AS a_location_kind,
            a.recurring AS a_recurring,
            a.max_runs AS a_max_runs,
            a.end_at AS a_end_at,
            a.schedule_rule AS a_schedule_rule,
            a.schedule_edited_by_user AS a_schedule_edited_by_user,
            a.run_count AS a_run_count,
            a.scheduled_run_count AS a_scheduled_run_count,
            a.enabled AS a_enabled,
            a.lifecycle_status AS a_lifecycle_status,
            a.next_run_at AS a_next_run_at,
            a.last_run_at AS a_last_run_at,
            a.running AS a_running,
            a.claimed_at AS a_claimed_at,
            a.dispatch_status AS a_dispatch_status,
            a.dispatch_attempts AS a_dispatch_attempts,
            a.retry_at AS a_retry_at,
            a.last_error AS a_last_error,
            a.bot_delivery_target AS a_bot_delivery_target,
            a.created_at AS a_created_at,
            a.updated_at AS a_updated_at,
            r.run_id AS r_run_id,
            r.automation_id AS r_automation_id,
            r.workspace_key AS r_workspace_key,
            r.scheduled_at AS r_scheduled_at,
            r.trigger AS r_trigger,
            r.model_selection AS r_model_selection,
            r.dispatch_status AS r_dispatch_status,
            r.outcome AS r_outcome,
            r.session_id AS r_session_id,
            r.error AS r_error,
            r.attempts AS r_attempts,
            r.created_at AS r_created_at,
            r.updated_at AS r_updated_at
          FROM automation_runs r
          JOIN automations a ON a.automation_id = r.automation_id
          WHERE r.trigger = 'manual'
            AND r.dispatch_status = 'claimed'
            AND a.running = 0
            AND (r.attempts = 0 OR r.updated_at <= @stale)
          ORDER BY r.created_at ASC`,
        )
        .all({ stale: now - CLAIM_STALE_MS }) as unknown as Array<Record<string, unknown>>;

      const claimed: ClaimedManualAutomationRun[] = [];
      const claimAutomation = db.prepare(
        `UPDATE automations
        SET running = 1, claimed_at = @now, updated_at = @now
        WHERE automation_id = @id AND running = 0`,
      );
      const claimRun = db.prepare(
        `UPDATE automation_runs
        SET attempts = attempts + 1, updated_at = @now
        WHERE run_id = @run_id AND trigger = 'manual' AND dispatch_status = 'claimed'`,
      );

      for (const row of rows) {
        const automationId = row["a_automation_id"] as string;
        const runId = row["r_run_id"] as string;
        const res = claimAutomation.run({ id: automationId, now });
        if (res.changes !== 1) continue;
        claimRun.run({ run_id: runId, now });
        claimed.push({
          automation: rowToAutomation({
            automation_id: automationId,
            title: row["a_title"] as string,
            cron_expr: row["a_cron_expr"] as string,
            prompt: row["a_prompt"] as string,
            model: (row["a_model"] as string | null) ?? null,
            provider: (row["a_provider"] as string | null) ?? null,
            model_selection: (row["a_model_selection"] as string | null) ?? null,
            mode: (row["a_mode"] as string | null) ?? null,
            thought_level: (row["a_thought_level"] as string | null) ?? null,
            workspace_key: row["a_workspace_key"] as string,
            workspace_path: row["a_workspace_path"] as string,
            workspace_identity: (row["a_workspace_identity"] as string | null) ?? null,
            target_task_id: (row["a_target_task_id"] as string | null) ?? null,
            location_kind: row["a_location_kind"] as string,
            recurring: row["a_recurring"] as number,
            max_runs: (row["a_max_runs"] as number | null) ?? null,
            end_at: (row["a_end_at"] as number | null) ?? null,
            schedule_rule: (row["a_schedule_rule"] as string | null) ?? null,
            schedule_edited_by_user: row["a_schedule_edited_by_user"] as number,
            run_count: row["a_run_count"] as number,
            scheduled_run_count: row["a_scheduled_run_count"] as number,
            enabled: row["a_enabled"] as number,
            lifecycle_status: row["a_lifecycle_status"] as string,
            next_run_at: (row["a_next_run_at"] as number | null) ?? null,
            last_run_at: (row["a_last_run_at"] as number | null) ?? null,
            running: 1,
            claimed_at: now,
            dispatch_status: row["a_dispatch_status"] as string,
            dispatch_attempts: row["a_dispatch_attempts"] as number,
            retry_at: (row["a_retry_at"] as number | null) ?? null,
            last_error: (row["a_last_error"] as string | null) ?? null,
            bot_delivery_target: (row["a_bot_delivery_target"] as string | null) ?? null,
            created_at: row["a_created_at"] as number,
            updated_at: now,
          }),
          run: rowToRun({
            run_id: runId,
            automation_id: row["r_automation_id"] as string,
            workspace_key: row["r_workspace_key"] as string,
            scheduled_at: (row["r_scheduled_at"] as number | null) ?? null,
            trigger: row["r_trigger"] as string,
            model_selection: (row["r_model_selection"] as string | null) ?? null,
            dispatch_status: row["r_dispatch_status"] as string,
            outcome: (row["r_outcome"] as string | null) ?? null,
            // 认领复位语义与 upsertRunClaimed 一致：claimed 且未 settle 的 run 无决策。
            notify_decision: null,
            session_id: (row["r_session_id"] as string | null) ?? null,
            error: (row["r_error"] as string | null) ?? null,
            attempts: (row["r_attempts"] as number) + 1,
            created_at: row["r_created_at"] as number,
            updated_at: now,
          }),
        });
      }
      db.exec("COMMIT");
      return claimed;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}
