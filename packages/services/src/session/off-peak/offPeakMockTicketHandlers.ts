/* off-peak mock 网关的 ticket 族 HTTP 处理器：availability/take/status/settle。
   处理器只做请求↔应答翻译；票据状态读写全部委托 offPeakMockTicketStore 叶子。 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ServiceLogger } from "#src/logger/serviceLogger.js";
import { json, readBody } from "#src/session/off-peak/offPeakMockHttp.js";
import type {
  OffPeakMockGatewayConfig,
  OffPeakMockTicketStore,
} from "#src/session/off-peak/offPeakMockTicketStore.js";

export interface OffPeakMockTicketHandlerContext {
  store: OffPeakMockTicketStore;
  config: OffPeakMockGatewayConfig;
  logger: ServiceLogger;
}

export async function handleMockTake(
  ctx: OffPeakMockTicketHandlerContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = (await readBody(req)) as { task_id?: string };
  const taskId = body.task_id;
  if (!taskId) {
    json(res, 400, { code: 3000, msg: "task_id required" });
    return;
  }
  const now = Date.now();
  const result = ctx.store.take(taskId, now);
  if (!result.ok) {
    json(res, 429, {
      code: 3103,
      msg: "free tier limit reached",
      data: { next_take_at: result.nextTakeAt },
    });
    return;
  }
  const { ticket } = result;
  ctx.logger.info(
    undefined,
    `mock gateway take task=${taskId} ticket=${ticket.ticketId} state=${ticket.state}`,
  );
  json(res, 200, {
    ticket_id: ticket.ticketId,
    task_id: taskId,
    state: ticket.state,
    accepted: true,
    position: result.position,
    next_poll_after: ctx.config.nextPollS,
    queued_at: now,
    ...(ticket.readyDeadline ? { ready_deadline: ticket.readyDeadline } : {}),
  });
}

export function handleMockAvailability(
  ctx: OffPeakMockTicketHandlerContext,
  res: ServerResponse,
): void {
  const result = ctx.store.availability(Date.now());
  json(res, 200, {
    can_take_number: result.canTake,
    ...(result.nextTakeAt !== undefined ? { next_take_at: result.nextTakeAt } : {}),
  });
}

export async function handleMockStatus(
  ctx: OffPeakMockTicketHandlerContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = (await readBody(req)) as { ticket_ids?: string[] };
  const ids = Array.isArray(body.ticket_ids) ? body.ticket_ids.slice(0, 100) : [];
  const entries = ctx.store.statusEntries(ids, Date.now());
  json(res, 200, { next_poll_after: ctx.config.nextPollS, tickets: entries });
}

export function handleMockSettle(
  ctx: OffPeakMockTicketHandlerContext,
  res: ServerResponse,
  ticketId: string,
): void {
  ctx.store.settle(ticketId);
  // 幂等：未知票也 200。
  json(res, 200, {
    ticket_id: ticketId,
    state: "settled",
    settled_at: Date.now(),
  });
}
