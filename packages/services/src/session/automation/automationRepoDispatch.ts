import {
  DISPATCH_MAX_ATTEMPTS,
  computeRetryAt,
} from "#src/session/automation/automationDispatchPolicy.js";
import { AutomationRepoClaiming } from "#src/session/automation/automationRepoClaiming.js";

/**
 * 派发结算与跳过分段（2026-10-30 自 automationRepo.ts 拆出）：成功/失败状态机迁移、
 * 认领释放与续租、错过窗口的补偿跳过。状态迁移全部以单行 UPDATE 收口，不引入第二写入路径。
 */
export class AutomationRepoDispatch extends AutomationRepoClaiming {
  /**
   * 派发成功结算：展示总数与定时派发数各 +1、写 last_run_at、清重试态、复位 running；
   * 循环任务回 active（nextRunAt 由调用方按实际派发时间重算传入）；
   * 有限次任务达 max_runs 转 completed（enabled=0、next_run_at=NULL）。
   */
  async markDispatched(
    automationId: string,
    options: { dispatchedAt: number; nextRunAt: number | null },
  ): Promise<void> {
    await this.ensureReady();
    const row = this.getRow(automationId);
    if (!row) return; // 已删除，丢弃回写，避免复活
    const runCount = row.run_count + 1;
    const scheduledRunCount = row.scheduled_run_count + 1;
    // 有限次任务（recurring=0）达上限即 completed。未显式设 max_runs 时按一次性任务处理（默认上限 1），
    // 否则一次性 cron 会一直停在 active 并被 cron 反复触发，永不结束。这里必须使用独立的
    // scheduled_run_count；run_count 还包含 manual run，只能用于 Card 累计展示。
    const reachedMax = row.recurring === 0 && scheduledRunCount >= (row.max_runs ?? 1);
    const reachedEnd = row.end_at !== null && (options.nextRunAt ?? Infinity) > row.end_at;
    this.getDatabase()
      .prepare(
        `UPDATE automations
        SET run_count = @run_count,
            scheduled_run_count = @scheduled_run_count,
            last_run_at = @dispatched_at,
            dispatch_status = 'dispatched',
            dispatch_attempts = 0,
            retry_at = NULL,
            last_error = NULL,
            running = 0,
            claimed_at = NULL,
            lifecycle_status = @lifecycle_status,
            enabled = @enabled,
            next_run_at = @next_run_at,
            updated_at = @now
        WHERE automation_id = @id`,
      )
      .run({
        id: automationId,
        run_count: runCount,
        scheduled_run_count: scheduledRunCount,
        dispatched_at: options.dispatchedAt,
        lifecycle_status: reachedMax || reachedEnd ? "completed" : "active",
        enabled: reachedMax || reachedEnd ? 0 : 1,
        next_run_at: reachedMax || reachedEnd ? null : options.nextRunAt,
        now: options.dispatchedAt,
      });
  }

  /**
   * 派发失败：transient 累加 attempts 并按退避写 retry_at；达上限后循环任务放弃本轮跳下一个
   * next_run_at（调用方传入），有限次任务转 failed。permanent 直接 failed 终态停用。
   */
  async markDispatchFailed(
    automationId: string,
    options: {
      failedAt: number;
      error: string;
      kind: "transient" | "permanent";
      /** transient 达上限后，循环任务的下一个正常 next_run_at（调用方重算）。 */
      nextRunAt?: number | null;
    },
  ): Promise<void> {
    await this.ensureReady();
    const row = this.getRow(automationId);
    if (!row) return;
    const db = this.getDatabase();
    const now = options.failedAt;
    if (options.kind === "permanent") {
      db.prepare(
        `UPDATE automations
        SET dispatch_status = 'failed_to_dispatch', lifecycle_status = 'failed',
            enabled = 0, running = 0, claimed_at = NULL,
            last_error = @error, updated_at = @now
        WHERE automation_id = @id`,
      ).run({ id: automationId, error: options.error, now });
      return;
    }
    const attempts = row.dispatch_attempts + 1;
    if (attempts >= DISPATCH_MAX_ATTEMPTS) {
      if (row.recurring === 1) {
        // 循环任务：放弃本轮，跳下一个正常 next_run_at，清重试态回 idle。
        db.prepare(
          `UPDATE automations
          SET dispatch_status = 'idle', dispatch_attempts = 0, retry_at = NULL,
              running = 0, claimed_at = NULL, next_run_at = @next_run_at,
              last_error = @error, updated_at = @now
          WHERE automation_id = @id`,
        ).run({
          id: automationId,
          next_run_at: options.nextRunAt ?? null,
          error: options.error,
          now,
        });
      } else {
        db.prepare(
          `UPDATE automations
          SET dispatch_status = 'failed_to_dispatch', lifecycle_status = 'failed',
              enabled = 0, running = 0, claimed_at = NULL,
              last_error = @error, updated_at = @now
          WHERE automation_id = @id`,
        ).run({ id: automationId, error: options.error, now });
      }
      return;
    }
    // 未达上限：写退避 retry_at，复位 running 等下轮重认领。
    db.prepare(
      `UPDATE automations
      SET dispatch_status = 'failed_to_dispatch', dispatch_attempts = @attempts,
          retry_at = @retry_at, running = 0, claimed_at = NULL,
          last_error = @error, updated_at = @now
      WHERE automation_id = @id`,
    ).run({
      id: automationId,
      attempts,
      retry_at: computeRetryAt(now, attempts),
      error: options.error,
      now,
    });
  }

  /** 关机/退出时释放认领：清 running、保留 next_run_at，不记失败不推进。 */
  async releaseClaim(automationId: string): Promise<void> {
    await this.ensureReady();
    this.getDatabase()
      .prepare(
        `UPDATE automations
        SET running = 0, claimed_at = NULL, dispatch_status = 'idle', updated_at = @now
        WHERE automation_id = @id AND running = 1`,
      )
      .run({ id: automationId, now: Date.now() });
  }

  /** manual run 结束后只释放 single-flight 锁，不修改 automation 的调度状态。 */
  async releaseManualClaim(automationId: string, workspaceKey: string): Promise<void> {
    await this.ensureReady();
    this.getDatabase()
      .prepare(
        `UPDATE automations
        SET running = 0, claimed_at = NULL, updated_at = @now
        WHERE automation_id = @id
          AND workspace_key = @workspace_key
          AND running = 1`,
      )
      .run({ id: automationId, workspace_key: workspaceKey, now: Date.now() });
  }

  /** host 仍持有 queued/running manual run 时续租，避免长任务被 scheduler 当作僵尸认领回收。 */
  async touchManualClaim(automationId: string, workspaceKey: string): Promise<void> {
    await this.ensureReady();
    this.getDatabase()
      .prepare(
        `UPDATE automations
        SET claimed_at = @now, updated_at = @now
        WHERE automation_id = @id
          AND workspace_key = @workspace_key
          AND running = 1`,
      )
      .run({ id: automationId, workspace_key: workspaceKey, now: Date.now() });
  }

  /**
   * 错过触发窗口：原子地记一条 skipped run + 把 next_run_at 前推到下一个未来触发点 + 复位认领。
   * 不计 run_count。用于 scheduler 启动/恢复后发现 next_run_at 已远早于 now 的补偿跳过。
   * finalize=true 用于纯一次性任务：目标时刻已错过即终态（completed + 停用 + 清空调度），
   * 不得再从兼容性 scheduleRule 推导出后续周期继续执行。
   */
  async skipAndReschedule(params: {
    automationId: string;
    runId: string;
    workspaceKey: string;
    scheduledAt: number | null;
    reason: string;
    nextRunAt: number | null;
    finalize?: boolean;
  }): Promise<void> {
    await this.ensureReady();
    const db = this.getDatabase();
    const now = Date.now();
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(
        `INSERT INTO automation_runs (
          run_id, automation_id, workspace_key, scheduled_at, trigger,
          dispatch_status, error, attempts, created_at, updated_at
        ) VALUES (@run_id, @automation_id, @workspace_key, @scheduled_at, 'schedule', 'skipped', @reason, 0, @now, @now)
        ON CONFLICT(run_id) DO UPDATE SET
          dispatch_status = 'skipped', error = excluded.error, updated_at = excluded.updated_at`,
      ).run({
        run_id: params.runId,
        automation_id: params.automationId,
        workspace_key: params.workspaceKey,
        scheduled_at: params.scheduledAt,
        reason: params.reason,
        now,
      });
      if (params.finalize) {
        db.prepare(
          `UPDATE automations
          SET lifecycle_status = 'completed', enabled = 0, next_run_at = NULL,
              running = 0, claimed_at = NULL,
              dispatch_status = 'idle', dispatch_attempts = 0, retry_at = NULL,
              updated_at = @now
          WHERE automation_id = @id`,
        ).run({ id: params.automationId, now });
      } else {
        db.prepare(
          `UPDATE automations
          SET next_run_at = @next_run_at, running = 0, claimed_at = NULL,
              dispatch_status = 'idle', dispatch_attempts = 0, retry_at = NULL,
              updated_at = @now
          WHERE automation_id = @id`,
        ).run({ id: params.automationId, next_run_at: params.nextRunAt, now });
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}
