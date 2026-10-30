/* off-peak 票据操作叶子：同 task_id 重取号与终态核销 outbox（settle 补报）。
   原为 OffPeakTaskService 的私有方法，拆分后由本体与同步周期叶子经 context 调用。 */
import type { ACodeOffPeakTask } from "@acode/shared";
import type { ServiceLogger } from "#src/logger/serviceLogger.js";
import type { OffPeakTaskRepo } from "#src/session/offPeakTaskRepo.js";
import { OffPeakServerError, type OffPeakServerClient } from "#src/session/offPeakServerClient.js";

/** 票据操作所需的最小上下文（由 OffPeakTaskService 构造期装配）。 */
export interface OffPeakTicketOpsContext {
  repo: OffPeakTaskRepo;
  client: OffPeakServerClient;
  logger: ServiceLogger;
  /** schedulable 翻 1 后立即唤醒 scheduler tick（缺省等 20s 轮询）。 */
  requestSchedulerWake: (() => void) | undefined;
  now: () => number;
}

/** 同 task_id 重新取号（已确认允许多次），失败留给轮询周期重试。 */
export async function retakeOffPeakTicket(
  ctx: OffPeakTicketOpsContext,
  offPeakTaskId: string,
): Promise<void> {
  try {
    const ticket = await ctx.client.takeTicket(offPeakTaskId);
    await ctx.repo.updateSchedulingSnapshot(offPeakTaskId, {
      serverTicketId: ticket.ticketId,
      registeredAt: ticket.registeredAt,
      schedulable: ticket.state === "ready",
      queuePosition: ticket.position ?? null,
      ...(ticket.nextPollAfterMs !== undefined
        ? { nextPollAt: ctx.now() + ticket.nextPollAfterMs }
        : {}),
      now: ctx.now(),
    });
    if (ticket.state === "ready") ctx.requestSchedulerWake?.();
    ctx.logger.info(
      undefined,
      `off-peak re-take ticket task=${offPeakTaskId} ticket=${ticket.ticketId} state=${ticket.state}`,
    );
  } catch (error) {
    // 取号失败（额度/网络）不终态化——任务留在 queued，下个轮询周期发现无有效票再补取。
    ctx.logger.warn(undefined, `off-peak re-take ticket failed task=${offPeakTaskId}:`, error);
  }
}

/** 终态未核销任务补报（幂等，永远失败也无害——服务端静默超时回收兜底）。 */
export async function flushOffPeakSettleOutbox(ctx: OffPeakTicketOpsContext): Promise<void> {
  const unsettled = await ctx.repo.listUnsettledTerminal();
  for (const task of unsettled) {
    await settleOffPeakTask(ctx, task);
  }
}

export async function settleOffPeakTask(
  ctx: OffPeakTicketOpsContext,
  task: ACodeOffPeakTask,
): Promise<void> {
  if (!task.serverTicketId) {
    // 无票（mock 先行/取号从未成功）：无可核销对象，直接标记防止 outbox 永久滞留。
    await ctx.repo.markSettled(task.offPeakTaskId, ctx.now());
    return;
  }
  try {
    await ctx.client.settle(task.serverTicketId);
    await ctx.repo.markSettled(task.offPeakTaskId, ctx.now());
  } catch (error) {
    if (error instanceof OffPeakServerError && error.httpStatus < 500) {
      // 4xx（未知票等）按幂等 ack 处理：服务端已无此票可释放。
      await ctx.repo.markSettled(task.offPeakTaskId, ctx.now());
      return;
    }
    // 网络/5xx：保持未核销，下个周期捎带补报（不新增计时器）。
    ctx.logger.warn(undefined, `off-peak settle failed ticket=${task.serverTicketId}:`, error);
  }
}
