import {
  PERMISSION_FULL_ACCESS_ENTRY,
  permissionFullAccessReceiptSchema,
  traceContextToLogContext,
  type TraceContext,
} from "@acode/contracts";
import type { AgentRuntimeInternal } from "../internal.js";
import { getRuntimePermissionGrantPort } from "../runtime-permission-grant.js";

/** 授权 receipt 在恢复时仅提供辅助标记；格式损坏不能阻断历史及执行状态恢复。 */
export async function restorePermissionGrantMarker(
  runtime: AgentRuntimeInternal,
  traceContext: TraceContext,
): Promise<void> {
  // CLI-05 I7：receipt 标记归 RuntimePermissionGrantOwner；恢复路径是仅有的两个
  // 写方之一，只能整体 replace/clear，不能读-改-写。
  const grantPort = getRuntimePermissionGrantPort(runtime);
  grantPort.setLastPermissionGrantId(undefined);
  const entries = await runtime.sessionStore?.sessionEntries?.({
    sessionID: runtime.sessionId,
    type: PERMISSION_FULL_ACCESS_ENTRY,
  });
  const lastGrant = entries?.at(-1);
  if (!lastGrant) return;
  const receipt = permissionFullAccessReceiptSchema.safeParse(lastGrant.data);
  if (!receipt.success || receipt.data.event.sessionId !== runtime.sessionId) {
    runtime.logger?.warn("Ignoring invalid permission grant marker during session resume", {
      ...traceContextToLogContext(traceContext),
      event: "session.resume.permission_grant_invalid",
      module: "core.runtime",
      entryId: lastGrant.id,
      reason: receipt.success ? "session_mismatch" : "invalid_receipt",
    });
    return;
  }
  grantPort.setLastPermissionGrantId(receipt.data.interactionId);
}
