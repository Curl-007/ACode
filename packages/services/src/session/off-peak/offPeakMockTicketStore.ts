/* off-peak mock 网关共享票据状态的唯一所有者：tickets/latestByTask/FIFO 序号、
   配额注入与 availability 阻断计数、E2E 捕获缓冲全部收敛在本工厂闭包内。
   take/status/settle/messages 处理器与 E2E 路由只经本叶子的方法读写，
   不复制状态、不开第二条写入路径（原为 offPeakMockGateway.ts 内联闭包）。 */
import type { OffPeakMockScenarioName } from "#src/session/off-peak/offPeakMockScenario.js";

export interface MockTicket {
  ticketId: string;
  taskId: string;
  state: "queued" | "ready" | "active" | "expired" | "settled";
  takenAt: number;
  readyAt?: number;
  readyDeadline?: number;
  activeDeadline?: number;
  queue429Remaining: number;
  /** FIFO 序号，用于 position 计算。 */
  seq: number;
}

export interface OffPeakMockCapturedRequest {
  hasApiKey: boolean;
  hasAuthorization: boolean;
  hasCodingPlanApiKey: boolean;
  maxTokens?: number;
  model?: string;
  requestJson: unknown;
  stage: string;
  ticketId: string;
  organization?: string;
  project?: string;
}

/** 取默认值与环境变量合并后的完整配置（由本体装配）。 */
export interface OffPeakMockGatewayConfig {
  readyDelayMs: number;
  readyTtlMs: number;
  activeMs: number;
  queue429Count: number;
  quotaExhaustedCount: number;
  availabilityBlockedMs: number;
  retryAfterS: number;
  nextPollS: number;
  scenario?: OffPeakMockScenarioName;
}

/** 取号结果：ok=false 时按 429/3103 应答，nextTakeAt 为服务端建议的下次可取时刻。 */
export type OffPeakMockTakeResult =
  | { ok: true; ticket: MockTicket; position: number | null }
  | { ok: false; nextTakeAt: number };

export type OffPeakMockStatusEntry =
  | { ticket_id: string; state: "not_found" }
  | {
      ticket_id: string;
      task_id: string;
      state: MockTicket["state"];
      position: number | null;
      active_deadline?: number;
    };

/** messages 准入裁决：invalid/queued/throttled 对应 400/3102 与 429/3105 应答。 */
export type OffPeakMockAdmission =
  | { kind: "invalid" }
  | { kind: "queued" }
  | { kind: "throttled" }
  | { kind: "admitted"; ticket: MockTicket; becameActive: boolean };

export interface OffPeakMockTicketStore {
  availability(now: number): { canTake: boolean; nextTakeAt?: number };
  take(taskId: string, now: number): OffPeakMockTakeResult;
  statusEntries(ids: readonly string[], now: number): OffPeakMockStatusEntry[];
  /** 幂等：未知票也视为已核销。 */
  settle(ticketId: string): void;
  admitForMessages(ticketId: string, now: number): OffPeakMockAdmission;
  captureRequest(entry: OffPeakMockCapturedRequest): void;
  capturedRequests(): readonly OffPeakMockCapturedRequest[];
  invalidTicketRequestCount(): number;
}

export function createOffPeakMockTicketStore(
  config: OffPeakMockGatewayConfig,
): OffPeakMockTicketStore {
  const tickets = new Map<string, MockTicket>();
  let quotaInjectionsRemaining = config.quotaExhaustedCount;
  const availabilityBlockedUntil = Date.now() + config.availabilityBlockedMs;
  /** taskId → 最新一张票（同 task_id 重新取号后旧票作废）。 */
  const latestByTask = new Map<string, string>();
  const capturedRequests: OffPeakMockCapturedRequest[] = [];
  let invalidTicketRequests = 0;
  let seqCounter = 0;

  /** 懒惰推进时间驱动的状态（轮询/messages 时评估，无后台计时器）。 */
  function advance(ticket: MockTicket, now: number): void {
    if (ticket.state === "queued" && now - ticket.takenAt >= config.readyDelayMs) {
      ticket.state = "ready";
      ticket.readyAt = now;
      ticket.readyDeadline = now + config.readyTtlMs;
    }
    if (
      ticket.state === "ready" &&
      ticket.readyDeadline !== undefined &&
      now > ticket.readyDeadline
    ) {
      ticket.state = "expired";
    }
    if (
      ticket.state === "active" &&
      ticket.activeDeadline !== undefined &&
      now > ticket.activeDeadline
    ) {
      ticket.state = "expired";
    }
  }

  /** 排队位次 = 前面还有多少张未晋级的活票。 */
  function positionOf(ticket: MockTicket): number {
    let ahead = 0;
    for (const other of tickets.values()) {
      if (other.state === "queued" && other.seq < ticket.seq) ahead += 1;
    }
    return ahead + 1;
  }

  return {
    availability(now) {
      return {
        canTake: now >= availabilityBlockedUntil,
        ...(now < availabilityBlockedUntil ? { nextTakeAt: availabilityBlockedUntil } : {}),
      };
    },

    take(taskId, now) {
      if (now < availabilityBlockedUntil) {
        return { ok: false, nextTakeAt: availabilityBlockedUntil };
      }
      if (quotaInjectionsRemaining > 0) {
        quotaInjectionsRemaining -= 1;
        return { ok: false, nextTakeAt: now + 60_000 };
      }
      // 同 task_id 重新取号：旧票直接作废（真实服务端旧票已自然终态）。
      const previous = latestByTask.get(taskId);
      if (previous) {
        const old = tickets.get(previous);
        if (old && (old.state === "queued" || old.state === "ready" || old.state === "active")) {
          old.state = "expired";
        }
      }
      seqCounter += 1;
      const ticket: MockTicket = {
        ticketId: `mock-ticket-${seqCounter}`,
        taskId,
        state: "queued",
        takenAt: now,
        queue429Remaining: config.queue429Count,
        seq: seqCounter,
      };
      // readyDelayMs=0 时取号即 ready（低峰空闲直接晋级的形态）。
      advance(ticket, now);
      tickets.set(ticket.ticketId, ticket);
      latestByTask.set(taskId, ticket.ticketId);
      return { ok: true, ticket, position: ticket.state === "queued" ? positionOf(ticket) : null };
    },

    statusEntries(ids, now) {
      return ids.map((id) => {
        const ticket = tickets.get(id);
        if (!ticket) return { ticket_id: id, state: "not_found" as const };
        advance(ticket, now);
        return {
          ticket_id: ticket.ticketId,
          task_id: ticket.taskId,
          state: ticket.state,
          position: ticket.state === "queued" ? positionOf(ticket) : null,
          ...(ticket.activeDeadline ? { active_deadline: ticket.activeDeadline } : {}),
        };
      });
    },

    settle(ticketId) {
      const ticket = tickets.get(ticketId);
      if (ticket) ticket.state = "settled";
    },

    admitForMessages(ticketId, now) {
      const ticket = tickets.get(ticketId);
      if (ticket) advance(ticket, now);
      if (!ticket || ticket.state === "expired" || ticket.state === "settled") {
        return { kind: "invalid" };
      }
      if (config.scenario === "invalid-ticket") {
        // 让 E2E 走真实的 3102 终态路径：客户端必须重取票/保留原任务身份，
        // 且不能把失败的闲时请求偷偷改发到普通 Chat provider。
        invalidTicketRequests += 1;
        return { kind: "invalid" };
      }
      if (ticket.state === "queued") {
        return { kind: "queued" };
      }
      if (ticket.queue429Remaining > 0) {
        ticket.queue429Remaining -= 1;
        return { kind: "throttled" };
      }
      if (ticket.state === "ready") {
        // ready 5min 内首个 message 即准入 active，进入 3h 窗口。
        ticket.state = "active";
        ticket.activeDeadline = now + config.activeMs;
        return { kind: "admitted", ticket, becameActive: true };
      }
      return { kind: "admitted", ticket, becameActive: false };
    },

    captureRequest(entry) {
      capturedRequests.push(entry);
    },

    capturedRequests() {
      return capturedRequests;
    },

    invalidTicketRequestCount() {
      return invalidTicketRequests;
    },
  };
}
