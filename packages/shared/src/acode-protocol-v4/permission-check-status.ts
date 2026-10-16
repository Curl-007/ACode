// permission_check_status：权限检查慢时的进度信号（checking → done）。
// spec: apps/acode-cli/specs/protocol-attachment-typed-errors.md R4（含证据出处与阈值依据）。
// 语义：等待超阈值发 checking、结束发 done；每 checking 必有同 toolCallId 的 done 跟随，
// 一次调用可发多对；done 不携带裁决。display-only、best-effort——可丢帧，显示端必须在
// 任何其他帧或回合结束时清除指示。信道与 v4/telemetry/event 同族（live-only，不进
// snapshot/持久事实），发出以 hello 的 `permissionCheckStatus` 位门控。
import { z } from "zod";
import { timestampSchema } from "./core.js";

/** 慢检查阈值；依据（证据「约四秒」+ AUTO_CLASSIFIER_TIMEOUT_MS=15s）见 spec R4 规则 1。 */
export const PERMISSION_CHECK_STATUS_SLOW_THRESHOLD_MS = 4_000 as const;

export const permissionCheckStatusSchema = z
  .object({
    toolCallId: z.string().min(1),
    status: z.enum(["checking", "done"]),
    /** 子代理内发起的检查（与 permission lifecycle 事实的 agentId 同源语义）。 */
    agentId: z.string().min(1).optional(),
    childSessionId: z.string().min(1).optional(),
    occurredAt: timestampSchema,
  })
  .strict();
export type PermissionCheckStatus = z.infer<typeof permissionCheckStatusSchema>;

export interface PermissionCheckStatusDisplayState {
  /** 当前亮着「检查中」指示的 toolCallId 集（只增删，本状态不做超时——见 clearToolCall）。 */
  readonly checking: ReadonlySet<string>;
}

export const initialPermissionCheckStatusDisplay: PermissionCheckStatusDisplayState = {
  checking: new Set<string>(),
};

/**
 * 显示端收敛的唯一读法（纯 reducer）：checking → 亮指示（幂等、多对不串扰）；done → 熄灭
 * （未亮时幂等吸收——丢帧后补到的 done 不得报错）；otherFrame / turnEnded → 无条件熄灭
 * （best-effort 纪律：丢帧时靠旁证收口）。
 */
export function permissionCheckStatusDisplayReducer(
  state: PermissionCheckStatusDisplayState,
  event:
    | { type: "signal"; signal: PermissionCheckStatus }
    | { type: "otherFrame"; toolCallId: string }
    | { type: "turnEnded" },
): PermissionCheckStatusDisplayState {
  if (event.type === "turnEnded") {
    return state.checking.size === 0 ? state : { checking: new Set() };
  }
  const toolCallId = event.type === "signal" ? event.signal.toolCallId : event.toolCallId;
  const shouldCheck = event.type === "signal" && event.signal.status === "checking";
  const isChecking = state.checking.has(toolCallId);
  if (shouldCheck === isChecking) return state;
  const next = new Set(state.checking);
  if (shouldCheck) next.add(toolCallId);
  else next.delete(toolCallId);
  return { checking: next };
}
