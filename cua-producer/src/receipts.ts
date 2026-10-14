/**
 * 变更类收据构造与 native→wire 错误映射（specs/windows-helper-producer.md §10.3/§10.12
 * + §10.12.1 字面量表）。A2 实现批次自 backend-a2.ts 拆出（§5.3「文件划分可微调」；
 * 纯 TS 契约面，独立单测/防漂移锁定更精确）。
 *
 * delivery-state 铁律（§10.12）的形态载体：
 * - 行 1 成功收据：{action_sent:true, dispatch_status:"accepted"}（+方法专属事实键，
 *   §10.12.1——禁空成功，wire spec §3.3）；
 * - 行 2 possibly_sent：派发已启动且结果不可证（NativeAmbiguousError 的唯一出口），
 *   禁止 ok:false（铁律 1）；
 * - 行 3 interrupted/partial：stop 中断与 injection_partial（accepted+action_sent:true）。
 * 全部 message 为 RECEIPT_MESSAGES 固定字面量、零插值（§3.2 红线；契约测试逐字面量锁定）。
 */

// wire-server 的封闭 error 字面量表是本模块映射的唯一 message 来源（§4.6.1）。
import { WIRE_ERROR_MESSAGES } from "./wire-server.js";

/**
 * 收据 message 封闭字面量表（§10.12.1 钉死；新增须先改 spec）。
 */
export const RECEIPT_MESSAGES = Object.freeze({
  /** §10.6 ⑤ stop 自身收据。 */
  stopped: "Computer Use control stopped; held inputs released.",
  /** §10.6 被 stop 中断的在途动作收据。 */
  interruptedByStop: "Computer Use action was interrupted by stop_computer_control.",
  /** §10.12 行 2 possibly_sent 收据。 */
  possiblySent:
    "Computer Use action may have been dispatched; the native outcome could not be verified.",
  /** §10.9 paste：剪贴板已写入但 Ctrl+V 未注入即失败（绝不是 not_sent）。 */
  clipboardModifiedPasteIncomplete:
    "Computer Use clipboard was modified but the paste keystroke was not dispatched.",
  /** §13 行 12 paste 成功（剪贴板遗留 = 登记的产品副作用，§10.9）。 */
  pasteCompletedClipboardModified:
    "Computer Use paste completed; the clipboard now holds the pasted text.",
  /** §13 行 6 drag 完成分支（injected_points 事实在 structuredContent）。 */
  dragCompleted: "Computer Use drag completed; all interpolated points were injected.",
  /** §13 行 7 type 部分注入（injected/total 事实在 structuredContent）。 */
  textPartiallyInjected: "Computer Use text input was partially injected before the sequence stopped.",
  /** 修饰键包裹动作：主体成功但修饰 up 业务段失败，收口走 cleanup 释放（§10.4 规则 5/§18 第 9 条）。 */
  modifierReleaseCleanup:
    "Computer Use action completed; modifier key release required cleanup.",
} as const);

/** native code → wire 码 + 封闭 message 字面量（§10.3 表「wire 结果」列的实现）。 */
export const WIRE_BY_NATIVE_CODE: Readonly<Record<string, { code: string; message: string }>> =
  Object.freeze({
    foreground_lost: {
      code: "foreground_required",
      message: WIRE_ERROR_MESSAGES.foregroundRequired,
    },
    non_interactive_desktop: {
      code: "permission_denied",
      message: WIRE_ERROR_MESSAGES.nonInteractiveDesktop,
    },
    target_changed: { code: "element_unavailable", message: WIRE_ERROR_MESSAGES.captureTarget },
    capture_minimized: { code: "element_unavailable", message: WIRE_ERROR_MESSAGES.captureTarget },
    capture_failed: { code: "element_unavailable", message: WIRE_ERROR_MESSAGES.captureTarget },
    budget_exceeded: { code: "element_unavailable", message: WIRE_ERROR_MESSAGES.captureTarget },
    clipboard_busy: { code: "controller_busy", message: WIRE_ERROR_MESSAGES.clipboardBusy },
    clipboard_denied: { code: "permission_denied", message: WIRE_ERROR_MESSAGES.clipboardDenied },
    stale: { code: "element_unavailable", message: WIRE_ERROR_MESSAGES.staleObservation },
    uia_timeout: { code: "timeout", message: WIRE_ERROR_MESSAGES.operationTimeout },
    canceled: { code: "controller_busy", message: WIRE_ERROR_MESSAGES.controllerBusy },
    injection_rejected: { code: "internal", message: WIRE_ERROR_MESSAGES.internal },
    internal_native: { code: "internal", message: WIRE_ERROR_MESSAGES.internal },
  });

// ── 结果形态构造（§10.12：structuredContent + 单文本块 JSON 同键）──────────────

export interface ToolResultPayload {
  content: Array<{ type: "text"; text: string }>;
  isError?: true;
  structuredContent: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

export function receiptResult(receipt: Record<string, unknown>, isError = false): ToolResultPayload {
  return {
    content: [{ type: "text", text: JSON.stringify(receipt) }],
    ...(isError ? ({ isError: true } as const) : {}),
    structuredContent: receipt,
  };
}

/** §10.12 行 1：变更类成功收据（禁空成功，wire spec §3.3）。 */
export function acceptedReceipt(extra: Record<string, unknown> = {}): ToolResultPayload {
  return receiptResult({ action_sent: true, dispatch_status: "accepted", ...extra });
}

/** §10.12 行 2：派发已启动且结果不可证 → possibly_sent（禁止 ok:false，铁律 1）。 */
export function possiblySentReceipt(
  nativeCode: string,
  reason: "native-dispatch-outcome-unknown" | "native-timeout",
  extra: Record<string, unknown> = {},
): ToolResultPayload {
  const wireCode = WIRE_BY_NATIVE_CODE[nativeCode]?.code ?? "internal";
  return receiptResult(
    {
      dispatch_status: "possibly_sent",
      action_sent: true,
      code: wireCode,
      reason,
      message: RECEIPT_MESSAGES.possiblySent,
      ...extra,
    },
    true,
  );
}

/** §10.12 行 3：中断/部分收据（stop 中断 / injection_partial；code ∈ {controller_busy, internal}）。 */
export function interruptedReceipt(
  code: "controller_busy" | "internal",
  message: string,
  extra: Record<string, unknown> = {},
): ToolResultPayload {
  return receiptResult(
    { dispatch_status: "accepted", action_sent: true, code, message, ...extra },
    true,
  );
}
