import {
  resolveAutomationManualTriggerAdmission,
  type AutomationManualRunTriggerContext,
  type AutomationManualTriggerRejectReason,
} from "@acode/shared";

// Automation 手动触发（manual run）的用户激活强制点
//（apps/acode-cli/specs/scheduled-manual-trigger-activation.md R1/R2/R5）。
// 语义与闭集词汇的唯一事实源在 @acode/shared 的 automation-manual-trigger 纯模块
//（bot-remote-guard 同款形态）；本文件只做 service 咽喉侧的翻译：拒绝 → typed error。
// 独立成文件而不是住 automationService.ts：该文件贴近 max-lines 上限，且守卫语义
// 未来若被 restart/setEnabled 复用（spec「未做与取舍」登记项）不需要再搬家。

export type { AutomationManualRunTriggerContext } from "@acode/shared";

/**
 * 用户激活守卫拒绝（spec R2）：远程发起的立即执行缺有效用户动作凭据。reason 是
 * 共享纯模块的闭集，禁止调用点自拼字符串；RPC 层把它映射为结构化拒绝结果
 *（接线归 acode-agent 面，见 spec「接口」节）。
 */
export class AutomationManualTriggerRejectedError extends Error {
  readonly reason: AutomationManualTriggerRejectReason;
  readonly automationId: string;

  constructor(reason: AutomationManualTriggerRejectReason, automationId: string) {
    super(`Automation immediate run rejected (${reason}): ${automationId}`);
    this.name = "AutomationManualTriggerRejectedError";
    this.reason = reason;
    this.automationId = automationId;
  }
}

/**
 * runNow 的唯一强制点：在 repo claim **之前**裁决——拒绝不产生 run 行、不占
 * single-flight 锁（spec 验收场景 1）。trigger 缺席 = 接线前既有调用方形状，
 * 兼容窗放行；携带 activation 但校验失败时任何 origin 都拒（垃圾凭据无豁免）。
 */
export function assertAutomationManualTriggerAdmitted(
  trigger: AutomationManualRunTriggerContext | undefined,
  automationId: string,
  now: number,
): void {
  const admission = resolveAutomationManualTriggerAdmission(trigger, now);
  if (!admission.admitted) {
    throw new AutomationManualTriggerRejectedError(admission.reason, automationId);
  }
}
