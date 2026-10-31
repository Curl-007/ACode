import { AUTOMATION_CREATE_LIMIT, AUTOMATION_CREATE_LIMIT_ERROR_CODE } from "@acode/shared";

// automation 派发退避策略与创建上限错误（2026-10-30 自 automationRepo.ts 拆出）。
// 纯常量/纯函数叶子：无状态、无 IO，facade 逐名再导出保持原导出面。

/** 派发失败退避常量。 */
export const DISPATCH_RETRY_BASE_MS = 30_000;
export const DISPATCH_RETRY_CAP_MS = 15 * 60_000;
export const DISPATCH_MAX_ATTEMPTS = 5;
/** 认领超时回收：running=1 超过该时长仍未结算，视为持有者已崩溃，允许重新认领。 */
export const CLAIM_STALE_MS = 10 * 60_000;

/** 创建总数超过产品上限；错误码会跨 RPC 保留在 message 中供 UI 识别。 */
export class AutomationCreateLimitError extends Error {
  readonly code = AUTOMATION_CREATE_LIMIT_ERROR_CODE;

  constructor() {
    super(
      `[${AUTOMATION_CREATE_LIMIT_ERROR_CODE}] At most ${AUTOMATION_CREATE_LIMIT} automations may be retained. Delete an existing automation before creating another.`,
    );
    this.name = "AutomationCreateLimitError";
  }
}

/** 退避重试时间：now + min(BASE * 2^(attempts-1), CAP)。 */
export function computeRetryAt(now: number, attempts: number): number {
  const backoff = Math.min(
    DISPATCH_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1),
    DISPATCH_RETRY_CAP_MS,
  );
  return now + backoff;
}
