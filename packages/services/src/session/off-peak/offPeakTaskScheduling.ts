/* off-peak 调度状态机与终态核销 outbox 的 SQL 实现：single-flight 认领、终态守卫、
   Pause/Continue、启动回收、续跑回队与 settle 回填。原为 OffPeakTaskRepo 的方法体，
   拆分后由本体包装方法委托调用。 */
import type { ACodeOffPeakTask } from "@acode/shared";
import type { DatabaseSyncInstance } from "#src/session/off-peak/offPeakTaskDatabase.js";
import {
  TERMINAL_SQL_LIST,
  readOffPeakModelSelection,
  readOffPeakTaskRow,
  rowToTask,
  type OffPeakTaskRow,
} from "#src/session/off-peak/offPeakTaskRows.js";

/** 认领超时回收：claim_running=1 超过该时长仍未结算，视为持有者已崩溃，允许重新认领。
    独立于 automation 的 CLAIM_STALE_MS（语义相同、常量独立一份，勿互相引用）。 */
export const OFF_PEAK_CLAIM_STALE_MS = 10 * 60_000;

/**
 * single-flight 认领可派发任务：status=queued 且 schedulable=1 且无在途认领，
 * 原子 claim_running 0→1。FIFO 序按 queued_at（权威序由服务端取号顺序保证）。
 * 同时回收认领超时（claimed_at 过期）的僵尸认领。
 */
export function claimDueOffPeakTasks(
  db: DatabaseSyncInstance,
  now: number,
): ACodeOffPeakTask[] {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      `UPDATE off_peak_tasks
      SET claim_running = 0, claimed_at = NULL
      WHERE claim_running = 1 AND claimed_at IS NOT NULL AND claimed_at <= @stale`,
    ).run({ stale: now - OFF_PEAK_CLAIM_STALE_MS });
    const dueRows = db
      .prepare(
        `SELECT * FROM off_peak_tasks
        WHERE status = 'queued' AND schedulable = 1 AND claim_running = 0
        ORDER BY queued_at ASC, created_at ASC`,
      )
      .all() as unknown as OffPeakTaskRow[];
    const claimed: ACodeOffPeakTask[] = [];
    const claim = db.prepare(
      `UPDATE off_peak_tasks
      SET claim_running = 1, claimed_at = @now, updated_at = @now
      WHERE off_peak_task_id = @id AND claim_running = 0`,
    );
    for (const row of dueRows) {
      // 历史行可能没有 Provider 身份；它们必须留在列表等待修复，但不能被
      // scheduler 认领。逐行跳过还能保证一条旧记录不阻塞后续健康任务。
      if (!readOffPeakModelSelection(row)) continue;
      const res = claim.run({ id: row.off_peak_task_id, now });
      if (res.changes === 1) {
        claimed.push(rowToTask({ ...row, claim_running: 1, claimed_at: now }));
      }
    }
    db.exec("COMMIT");
    return claimed;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export interface OffPeakMarkRunningOptions {
  startedAt: number;
  conversationId?: string;
  sessionId?: string;
  serverTicketId?: string;
}

/**
 * 派发成功（网关 admitted）：queued→running，回填首跑产生的 conversation/session 与
 * 本段 ticket，释放认领。守卫：仅 queued 可入 running（终态不可逆出；paused 竞态下
 * 派发结果作废，返回 null 由调用方处理）。续跑段保留首段 started_at（用户视角单任务）。
 */
export function markOffPeakTaskRunning(
  db: DatabaseSyncInstance,
  offPeakTaskId: string,
  options: OffPeakMarkRunningOptions,
): ACodeOffPeakTask | null {
  const res = db
    .prepare(
      `UPDATE off_peak_tasks
      SET status = 'running',
          started_at = COALESCE(started_at, @started_at),
          conversation_id = COALESCE(@conversation_id, conversation_id),
          session_id = COALESCE(@session_id, session_id),
          server_ticket_id = COALESCE(@server_ticket_id, server_ticket_id),
          claim_running = 0, claimed_at = NULL,
          last_error = NULL,
          updated_at = @started_at
      WHERE off_peak_task_id = @id AND status = 'queued'`,
    )
    .run({
      id: offPeakTaskId,
      started_at: options.startedAt,
      conversation_id: options.conversationId ?? null,
      session_id: options.sessionId ?? null,
      server_ticket_id: options.serverTicketId ?? null,
    });
  if (res.changes !== 1) return null;
  return rowToTask(readOffPeakTaskRow(db, offPeakTaskId)!);
}

export interface OffPeakMarkTerminalOptions {
  status: "completed" | "failed" | "cancelled";
  endedAt: number;
  failureReason?: string;
  filesChanged?: number;
  /** scheduler 派发阶段的确定性错误；存在时原子累计一次派发尝试并留 last_error。 */
  dispatchError?: string;
}

/**
 * 终态落库（completed/failed/cancelled）。守卫：终态不可逆出——已终态的行拒绝二次迁移，
 * 返回 null（OffPeakRunResult 迟到兜底时调用方据此丢弃）。settled_at 由核销单独回填。
 */
export function markOffPeakTaskTerminal(
  db: DatabaseSyncInstance,
  offPeakTaskId: string,
  options: OffPeakMarkTerminalOptions,
): ACodeOffPeakTask | null {
  const res = db
    .prepare(
      `UPDATE off_peak_tasks
      SET status = @status,
          ended_at = @ended_at,
          failure_reason = @failure_reason,
          files_changed = COALESCE(@files_changed, files_changed),
          attempt_count = attempt_count + @dispatch_attempt_inc,
          last_error = COALESCE(@dispatch_error, last_error),
          schedulable = 0,
          claim_running = 0, claimed_at = NULL,
          updated_at = @ended_at
      WHERE off_peak_task_id = @id AND status NOT IN (${TERMINAL_SQL_LIST})`,
    )
    .run({
      id: offPeakTaskId,
      status: options.status,
      ended_at: options.endedAt,
      failure_reason: options.failureReason ?? null,
      files_changed: options.filesChanged ?? null,
      dispatch_attempt_inc: options.dispatchError ? 1 : 0,
      dispatch_error: options.dispatchError ?? null,
    });
  if (res.changes !== 1) return null;
  return rowToTask(readOffPeakTaskRow(db, offPeakTaskId)!);
}

/**
 * 用户 Pause / Continue：queued ⇄ paused。
 * Pause 只停本地派发（票留服务端队列）；Continue 的票有效性判断与重取号在 service 层。
 * 已被认领派发在途（claim_running=1）的任务不可 Pause，返回 null。
 */
export function setOffPeakTaskPaused(
  db: DatabaseSyncInstance,
  offPeakTaskId: string,
  paused: boolean,
  options?: { now?: number },
): ACodeOffPeakTask | null {
  const res = db
    .prepare(
      `UPDATE off_peak_tasks
      SET status = @to, updated_at = @now
      WHERE off_peak_task_id = @id AND status = @from AND claim_running = 0`,
    )
    .run({
      id: offPeakTaskId,
      to: paused ? "paused" : "queued",
      from: paused ? "queued" : "paused",
      now: options?.now ?? Date.now(),
    });
  if (res.changes !== 1) return null;
  return rowToTask(readOffPeakTaskRow(db, offPeakTaskId)!);
}

/**
 * 释放认领（派发失败/关机退出）：复位 single-flight 锁；带 error 时累计 attempt_count
 * 并记 last_error（供派发退避与诊断）。不改 status——任务留在 queued 等下轮认领（无 skip）。
 */
export function releaseOffPeakClaim(
  db: DatabaseSyncInstance,
  offPeakTaskId: string,
  options?: { error?: string; now?: number },
): void {
  db.prepare(
    `UPDATE off_peak_tasks
    SET claim_running = 0, claimed_at = NULL,
        attempt_count = attempt_count + @attempt_inc,
        last_error = COALESCE(@error, last_error),
        updated_at = @now
    WHERE off_peak_task_id = @id AND claim_running = 1`,
  ).run({
    id: offPeakTaskId,
    attempt_inc: options?.error ? 1 : 0,
    error: options?.error ?? null,
    now: options?.now ?? Date.now(),
  });
}

/**
 * 启动回收（app 级启动时调用一次，先于任何派发）：进程死亡时残留的
 * running 置回 queued（保留 queued_at，天然仍在队首附近；保留 session_id 供 resume
 * 续跑），并清理超时认领。返回回收的任务数。
 * ⚠ 调用方必须保证调用时无在跑 off-peak loop（属主应为 app 单例进程，非每个 host）。
 */
export function recoverInterruptedOffPeakTasks(db: DatabaseSyncInstance, now: number): number {
  db.exec("BEGIN IMMEDIATE");
  try {
    const recovered = db
      .prepare(
        `UPDATE off_peak_tasks
        SET status = 'queued', claim_running = 0, claimed_at = NULL, updated_at = @now
        WHERE status = 'running'`,
      )
      .run({ now });
    db.prepare(
      `UPDATE off_peak_tasks
      SET claim_running = 0, claimed_at = NULL, updated_at = @now
      WHERE claim_running = 1 AND claimed_at IS NOT NULL AND claimed_at <= @stale`,
    ).run({ now, stale: now - OFF_PEAK_CLAIM_STALE_MS });
    db.exec("COMMIT");
    return Number(recovered.changes ?? 0);
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/**
 * 3h 时间盒到期 / ready 废票的续跑回队：running → queued，保留
 * session/conversation/started_at 供 resume 接续；清 schedulable 与位次等待重新取号后由轮询刷新。
 * 终态/paused 不可回队，返回 null（如用户已抢先取消）。
 */
export function requeueOffPeakTaskForContinuation(
  db: DatabaseSyncInstance,
  offPeakTaskId: string,
  options?: { now?: number },
): ACodeOffPeakTask | null {
  const res = db
    .prepare(
      `UPDATE off_peak_tasks
      SET status = 'queued', schedulable = 0, queue_position = NULL,
          claim_running = 0, claimed_at = NULL, updated_at = @now
      WHERE off_peak_task_id = @id AND status = 'running'`,
    )
    .run({ id: offPeakTaskId, now: options?.now ?? Date.now() });
  if (res.changes !== 1) return null;
  return rowToTask(readOffPeakTaskRow(db, offPeakTaskId)!);
}

/** 全部非终态任务（offPeakTaskSync 轮询输入：有非终态才轮）。 */
export function listNonTerminalOffPeakTasks(db: DatabaseSyncInstance): ACodeOffPeakTask[] {
  const rows = db
    .prepare(
      `SELECT * FROM off_peak_tasks
      WHERE status NOT IN (${TERMINAL_SQL_LIST})
      ORDER BY queued_at ASC`,
    )
    .all() as unknown as OffPeakTaskRow[];
  return rows.map(rowToTask);
}

/** settle 服务端 ack 后回填；仅终态行可核销（幂等，重复回填覆盖为最新 ack 时间）。 */
export function markOffPeakTaskSettled(
  db: DatabaseSyncInstance,
  offPeakTaskId: string,
  settledAt: number,
): void {
  db.prepare(
    `UPDATE off_peak_tasks
    SET settled_at = @settled_at, updated_at = @settled_at
    WHERE off_peak_task_id = @id AND status IN (${TERMINAL_SQL_LIST})`,
  ).run({ id: offPeakTaskId, settled_at: settledAt });
}

/** 未核销的终态任务：poll 周期捎带补报 + host 启动扫描（不新增计时器）。 */
export function listUnsettledTerminalOffPeakTasks(
  db: DatabaseSyncInstance,
): ACodeOffPeakTask[] {
  const rows = db
    .prepare(
      `SELECT * FROM off_peak_tasks
      WHERE status IN (${TERMINAL_SQL_LIST}) AND settled_at IS NULL
      ORDER BY ended_at ASC`,
    )
    .all() as unknown as OffPeakTaskRow[];
  return rows.map(rowToTask);
}
