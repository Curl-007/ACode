/* off-peak 同步周期叶子（offPeakTaskSync）：核销 outbox 捎带补报、批量轮询
   /ticket/status、晋级写回与废票重取号。单次周期主体在此；定时器调度、并发挡板
   与失败退避计数留在 OffPeakTaskService 本体。 */
import type { ACodeOffPeakTask } from "@acode/shared";
import {
  flushOffPeakSettleOutbox,
  retakeOffPeakTicket,
  type OffPeakTicketOpsContext,
} from "#src/session/off-peak/offPeakTicketOps.js";

/** 轮询下限/上限与失败退避（服务端 next_poll_after 优先，钳制防打爆/防饿死）。 */
export const OFF_PEAK_SYNC_MIN_INTERVAL_MS = 5_000;
export const OFF_PEAK_SYNC_MAX_INTERVAL_MS = 5 * 60_000;
export const SYNC_FAILURE_BASE_MS = 10_000;

/** 同步周期上下文：票据操作上下文 + 列表广播与 ModelSelection 诊断投影回调。 */
export interface OffPeakSyncCycleContext extends OffPeakTicketOpsContext {
  /** 列表变化广播钩子（UI 刷新）。 */
  emitChanged: () => void;
  /** 只派生当前配置诊断，不写数据库（本体 projectModelSelectionIssues）。 */
  projectTasks: (tasks: readonly ACodeOffPeakTask[]) => Promise<ACodeOffPeakTask[]>;
}

/**
 * 单次同步周期主体；返回建议的下次延迟（未钳制，由本体统一钳制与重排）。
 * 抛出时由本体累计退避。
 */
export async function runOffPeakSyncCycle(ctx: OffPeakSyncCycleContext): Promise<number> {
  // 1) 核销 outbox 捎带补报（不新增计时器）。
  await flushOffPeakSettleOutbox(ctx);
  // 2) 有非终态任务才轮询。
  const nonTerminal = await ctx.projectTasks(await ctx.repo.listNonTerminal());
  const withTickets = nonTerminal.filter((task) => task.serverTicketId);
  // 无票的 queued 任务（重取号失败残留）：补取号。
  for (const task of nonTerminal) {
    if (!task.serverTicketId && task.status === "queued") {
      await retakeOffPeakTicket(ctx, task.offPeakTaskId);
    }
  }
  if (withTickets.length === 0 && nonTerminal.length === 0) {
    // 无任务：不再自动重排，等下一次 create/continue 触发。
    return OFF_PEAK_SYNC_MAX_INTERVAL_MS;
  }
  if (withTickets.length === 0) {
    return OFF_PEAK_SYNC_MIN_INTERVAL_MS;
  }
  const status = await ctx.client.batchStatus(
    withTickets.map((task) => task.serverTicketId!),
  );
  let anyBecameSchedulable = false;
  for (const task of withTickets) {
    const entry = status.tickets.find((t) => t.ticketId === task.serverTicketId);
    if (!entry) continue;
    anyBecameSchedulable =
      (await applyOffPeakTicketStatus(ctx, task, entry.state, entry.position)) ||
      anyBecameSchedulable;
  }
  if (anyBecameSchedulable) ctx.requestSchedulerWake?.();
  ctx.emitChanged();
  return status.nextPollAfterMs !== undefined
    ? status.nextPollAfterMs
    : OFF_PEAK_SYNC_MIN_INTERVAL_MS;
}

/** 单票状态映射（两轴）：返回是否翻为可派发。 */
export async function applyOffPeakTicketStatus(
  ctx: OffPeakSyncCycleContext,
  task: ACodeOffPeakTask,
  state: string,
  position: number | undefined,
): Promise<boolean> {
  const now = ctx.now();
  switch (state) {
    case "ready": {
      const became = task.schedulable !== true && task.status === "queued";
      await ctx.repo.updateSchedulingSnapshot(task.offPeakTaskId, {
        schedulable: true,
        queuePosition: position ?? null,
        nextPollAt: now + OFF_PEAK_SYNC_MIN_INTERVAL_MS,
        now,
      });
      return became;
    }
    case "queued":
      await ctx.repo.updateSchedulingSnapshot(task.offPeakTaskId, {
        schedulable: false,
        queuePosition: position ?? null,
        now,
      });
      return false;
    case "active":
      // 客户端 loop 在跑（或派发在途）；快照不动状态机，仅清位次展示。
      await ctx.repo.updateSchedulingSnapshot(task.offPeakTaskId, {
        queuePosition: null,
        now,
      });
      return false;
    case "expired": {
      // 任何 expired → 同 task_id 重新取号续排（统一口径）；
      // 例外：paused 停在原地等手动 Continue；running 的 3h 到期
      // 由 messages 400/3102 路径触发，这里只处理排队中的废票。
      if (task.status === "queued") {
        await ctx.repo.updateSchedulingSnapshot(task.offPeakTaskId, {
          schedulable: false,
          queuePosition: null,
          now,
        });
        await retakeOffPeakTicket(ctx, task.offPeakTaskId);
      }
      return false;
    }
    case "settled":
    case "not_found":
    default:
      return false;
  }
}
