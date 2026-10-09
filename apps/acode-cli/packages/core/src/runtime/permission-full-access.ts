import {
  PERMISSION_FULL_ACCESS_ENTRY,
  permissionFullAccessReceiptSchema,
  SessionEventType,
  type SessionEvent,
  type SessionModeChangedPayload,
} from "@acode/contracts";
import type { AgentRuntimeInternal } from "./internal.js";
import { buildExecutionStateEntry, readRuntimeExecutionState } from "./execution-state.js";
import {
  unpublishedPermissionGrants,
  recoverPendingPermissionGrant,
} from "./permission-grant-recovery.js";
import { getRuntimePermissionGrantPort } from "./runtime-permission-grant.js";

const appliedGrants = new WeakMap<AgentRuntimeInternal, Set<string>>();

/** 完全访问只改当前任务；receipt 固定目标集合，发布失败后不能重新抓取后来队列。 */
export async function grantPermissionFullAccess(
  this: AgentRuntimeInternal,
  interactionId: string,
  signal?: AbortSignal,
): Promise<string> {
  if (!this.sessionStore?.commitPermissionFullAccess) throw new Error("Full access is unsupported");
  if (
    this.permissionFullAccessPending ||
    this.pendingInputReservations.size > 0 ||
    this.pendingInputDrains
  ) {
    throw new Error("Queue mutation is busy; retry approval");
  }
  const unpublished = unpublishedPermissionGrants.get(this);
  if (unpublished && unpublished.interactionId !== interactionId)
    await recoverPendingPermissionGrant(this);
  // CLI-05 I7：预约必须在 recover 之后——recover 会以重入方式再跑一次本函数，
  // 若外层先预约会把重入授权按 busy 拒绝，破坏既有的 unpublished grant 恢复语义。
  // tryBegin 把「检查 + 置位」收进 owner 的同一同步片：并发第二个授权在这里得到
  // 与入口检查一致的 busy 拒绝，而不是双方都进入事务。
  const grantPort = getRuntimePermissionGrantPort(this);
  if (!grantPort.tryBeginPermissionFullAccess())
    throw new Error("Queue mutation is busy; retry approval");
  try {
    signal?.throwIfAborted();
    const receiptId = `${this.sessionId}:permission-full-access:${interactionId}`;
    const entries = await this.sessionStore.sessionEntries?.({
      sessionID: this.sessionId,
      type: PERMISSION_FULL_ACCESS_ENTRY,
    });
    const saved = entries?.find((entry) => entry.id === receiptId);
    let event: SessionEvent;
    if (saved) {
      const data = permissionFullAccessReceiptSchema.parse(saved.data);
      if (data.event.sessionId !== this.sessionId || data.interactionId !== interactionId) {
        throw new Error("Permission receipt scope mismatch");
      }
      event = data.event as SessionEvent;
    } else {
      const projection = await this.rebuildProjection();
      const queueItemIds = projection.pendingSteerInputs.map((item) => item.pendingInputId);
      const previous = readRuntimeExecutionState(this);
      const next = { ...previous, mode: "yolo" as const };
      event = this.createEvent(
        SessionEventType.SessionModeChanged,
        {
          ...next,
          previousMode: previous.mode,
          previousPlanEnabled: previous.planEnabled,
          source: "command",
          permissionGrant: { interactionId, queueItemIds },
        },
        this.rootTraceContext,
      );
      signal?.throwIfAborted();
      await this.sessionStore.commitPermissionFullAccess({
        sessionID: this.sessionId,
        queueItemIds,
        signal,
        execution: buildExecutionStateEntry(this.sessionId, next),
        receipt: {
          id: receiptId,
          sessionID: this.sessionId,
          type: PERMISSION_FULL_ACCESS_ENTRY,
          touchSession: false,
          time: { created: Date.now(), updated: Date.now() },
          data: { interactionId, event },
        },
      });
    }
    const payload = event.payload as SessionModeChangedPayload;
    unpublishedPermissionGrants.set(this, {
      interactionId,
      recover: () => grantPermissionFullAccess.call(this, interactionId),
    });
    const ids = new Set(payload.permissionGrant!.queueItemIds);
    // 事务已提交：之后即使传输取消也必须完成内存和投影发布，不能制造半个授权。
    const applied = appliedGrants.get(this) ?? new Set<string>();
    if (!applied.has(interactionId)) {
      // 唯一写方之一（另一处是 permission-grant-resume 的重置/恢复）；replace 语义。
      grantPort.setLastPermissionGrantId(interactionId);
      this.config.mode = payload.mode;
      this.config.planEnabled = payload.planEnabled;
      for (const item of this.activeTurn?.pendingInputs ?? []) {
        if (ids.has(item.id) && item.intent) item.intent = { ...item.intent, mode: "yolo" };
      }
      applied.add(interactionId);
      appliedGrants.set(this, applied);
    }
    const existing = (await this.eventStore.getEvents(this.sessionId)).find(
      (item) => item.id === event.id,
    );
    if (existing) await this.notifyEventSinks(existing, this.rootTraceContext);
    else await this.appendEvent(event, this.rootTraceContext);
    unpublishedPermissionGrants.delete(this);
    return String(event.id);
  } finally {
    // 释放只发生在这里：成功、失败与取消都归还预约，后续授权可以重试。
    grantPort.endPermissionFullAccess();
  }
}
