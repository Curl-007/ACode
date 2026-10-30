/* off-peak 任务管理编排叶子：创建即取号（成功才落库）、Continue 票活判断/重取号、
   窗口期编辑。原为 OffPeakTaskService 的方法体，拆分后由本体包装方法经 context 委托。 */
import { randomUUID } from "node:crypto";
import {
  resolveWorkspaceKey,
  type OffPeakTaskCreateResult,
  type ACodeOffPeakTask,
  type ACodeOffPeakTaskCreateParams,
} from "@acode/shared";
import type { ModelSelection, ModelSelectionValidation } from "@acode/provider";
import {
  OFF_PEAK_SESSION_BOUND_FAILURE,
  classifyOffPeakCreateFailure,
  isValidCreateParams,
} from "#src/session/off-peak/offPeakCreateValidation.js";
import {
  retakeOffPeakTicket,
  type OffPeakTicketOpsContext,
} from "#src/session/off-peak/offPeakTicketOps.js";
import { isOffPeakBoundSessionConflict } from "#src/session/offPeakTaskRepo.js";
import type { OffPeakUpdateTaskParams } from "#src/session/offPeakTask.js";

/** 管理编排所需上下文：票据操作上下文 + 创建校验/列表刷新/轮询唤醒回调。 */
export interface OffPeakTaskAdminContext extends OffPeakTicketOpsContext {
  /** 只返回安全 hostname；解析失败返回空串，不能影响创建业务结果。 */
  resolveTelemetryProviderName: () => Promise<string>;
  /** 用当前完整 Registry 解析并校验固定 Off-Peak Provider 的选择。 */
  resolveModelSelection: (input: {
    readonly modelId?: string;
    readonly reasoningLevel?: string;
  }) => Promise<
    | { readonly ok: true; readonly selection: ModelSelection }
    | { readonly ok: false; readonly validation: ModelSelectionValidation }
  >;
  /** 列表变化广播钩子（UI 刷新）。 */
  emitChanged: () => void;
  /** 重排一次同步周期（0 = 立即）。 */
  ensureSyncScheduled: (delayMs: number) => void;
}

/** 创建即取号（取号成功才落库）；失败只返回稳定分类，绝不跨 RPC 返回 raw error。 */
export async function createOffPeakTask(
  ctx: OffPeakTaskAdminContext,
  params: ACodeOffPeakTaskCreateParams,
): Promise<OffPeakTaskCreateResult> {
  let providerName = "";
  try {
    providerName = await ctx.resolveTelemetryProviderName();
  } catch {
    // provider_name 只是埋点维度；解析失败不得改变创建、toast 或任务执行。
  }
  if (!isValidCreateParams(params)) {
    return {
      ok: false,
      ...classifyOffPeakCreateFailure(undefined, "client_validation"),
      providerName,
    };
  }
  const selection = await ctx.resolveModelSelection({
    modelId: params.modelSelection.modelId,
    ...(params.modelSelection.options?.reasoningLevel
      ? { reasoningLevel: params.modelSelection.options.reasoningLevel }
      : {}),
  });
  if (!selection.ok) {
    return {
      ok: false,
      ...classifyOffPeakCreateFailure(undefined, "client_validation"),
      providerName,
    };
  }
  const normalizedParams: ACodeOffPeakTaskCreateParams = {
    ...params,
    modelSelection: selection.selection,
  };
  // 绑定会话已有未终态任务即拒，先于取号避免浪费额度；
  // 并发穿过预检的一方由 idx_off_peak_bound_active 在 INSERT 时拒绝（见下方 local_persist 分支）。
  if (
    params.boundSessionId &&
    (await ctx.repo.hasActiveBoundTask(
      resolveWorkspaceKey({
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
      }),
      params.boundSessionId,
    ))
  ) {
    return { ok: false, ...OFF_PEAK_SESSION_BOUND_FAILURE, providerName };
  }
  const offPeakTaskId = `offpeak-${randomUUID()}`;
  let ticket;
  try {
    ticket = await ctx.client.takeTicket(offPeakTaskId);
  } catch (error) {
    return {
      ok: false,
      ...classifyOffPeakCreateFailure(error, "ticket_request"),
      providerName,
    };
  }
  let created: ACodeOffPeakTask;
  try {
    created = await ctx.repo.create(normalizedParams, {
      offPeakTaskId,
      serverTicketId: ticket.ticketId,
      registeredAt: ticket.registeredAt,
      ...(ticket.position !== undefined ? { queuePosition: ticket.position } : {}),
      // 取号即 ready（低峰空闲直接晋级）时随建随派
      schedulable: ticket.state === "ready",
    });
    if (ticket.nextPollAfterMs !== undefined) {
      await ctx.repo.updateSchedulingSnapshot(created.offPeakTaskId, {
        nextPollAt: ctx.now() + ticket.nextPollAfterMs,
      });
    }
  } catch (error) {
    if (isOffPeakBoundSessionConflict(error)) {
      // 已取的票随任务作废，服务端按过期回收；不为此加释放接口。
      return { ok: false, ...OFF_PEAK_SESSION_BOUND_FAILURE, providerName };
    }
    return {
      ok: false,
      ...classifyOffPeakCreateFailure(error, "local_persist"),
      providerName,
    };
  }
  ctx.logger.info(
    undefined,
    `off-peak task created id=${offPeakTaskId} ticket=${ticket.ticketId} state=${ticket.state}`,
  );
  ctx.emitChanged();
  ctx.ensureSyncScheduled(0);
  if (ticket.state === "ready") {
    try {
      ctx.requestSchedulerWake?.();
    } catch (error) {
      ctx.logger.warn(undefined, "off-peak scheduler wake failed after create:", error);
    }
  }
  return {
    ok: true,
    task: created,
    ticketInitialState: ticket.state,
    ...(ticket.position !== undefined ? { queuePosition: ticket.position } : {}),
    providerName,
  };
}

/**
 * Continue：票活着 = 恢复派发（零成本）；票已废（expired/not_found/无票）= 此刻手动
 * 重取号回队尾（额度消耗必须由用户显式动作触发）。
 */
export async function continueOffPeakTask(
  ctx: OffPeakTaskAdminContext,
  offPeakTaskId: string,
): Promise<ACodeOffPeakTask | null> {
  const resumed = await ctx.repo.setPaused(offPeakTaskId, false, {
    now: ctx.now(),
  });
  if (!resumed) return null;
  let ticketAlive = false;
  if (resumed.serverTicketId) {
    try {
      const status = await ctx.client.batchStatus([resumed.serverTicketId]);
      // 必须按 ticketId 匹配，不能取 tickets[0]——批量应答顺序/内容不保证与请求一致。
      const entry = status.tickets.find((t) => t.ticketId === resumed.serverTicketId);
      ticketAlive =
        entry !== undefined && entry.state !== "expired" && entry.state !== "not_found";
      if (entry && ticketAlive) {
        await ctx.repo.updateSchedulingSnapshot(offPeakTaskId, {
          schedulable: entry.state === "ready",
          queuePosition: entry.position ?? null,
          now: ctx.now(),
        });
      }
    } catch (error) {
      // 状态查询失败按票活处理，交给轮询兜底；不在 Continue 上白耗一次取号额度。
      ctx.logger.warn(
        undefined,
        `off-peak continue status check failed task=${offPeakTaskId}:`,
        error,
      );
      ticketAlive = true;
    }
  }
  if (!ticketAlive) {
    await retakeOffPeakTicket(ctx, offPeakTaskId);
  }
  ctx.emitChanged();
  ctx.ensureSyncScheduled(0);
  return ctx.repo.get(offPeakTaskId);
}

/** 编辑（queued/paused 全字段可编辑；票只锁队列身份，prompt 派发时才读）。 */
export async function updateOffPeakTask(
  ctx: OffPeakTaskAdminContext,
  offPeakTaskId: string,
  params: OffPeakUpdateTaskParams,
): Promise<ACodeOffPeakTask | null> {
  const existing = await ctx.repo.get(offPeakTaskId);
  if (!existing) return null;
  if (existing.status !== "queued" && existing.status !== "paused") {
    // running 起锁定编辑（仅取消），终态只读。
    return null;
  }
  // 闲时任务必须保存一个可由当前 Registry 解析的明确模型；清空模型不能退化成
  // “稍后取第一个”，否则编辑时看到的选择和真正派发的模型会发生漂移。
  if (params.modelSelection === null) return null;
  const candidate = params.modelSelection ?? existing.modelSelection;
  if (!candidate) return null;
  const selection = await ctx.resolveModelSelection({
    modelId: candidate.modelId,
    ...(candidate.options?.reasoningLevel
      ? { reasoningLevel: candidate.options.reasoningLevel }
      : {}),
  });
  if (!selection.ok) return null;
  const normalizedParams: OffPeakUpdateTaskParams = {
    ...params,
    modelSelection: selection.selection,
  };
  const updated = await ctx.repo.updateEditableFields(offPeakTaskId, normalizedParams, {
    now: ctx.now(),
  });
  if (updated) ctx.emitChanged();
  return updated;
}
