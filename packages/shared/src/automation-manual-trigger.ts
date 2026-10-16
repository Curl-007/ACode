/**
 * Automation 手动触发（manual run）的用户激活守卫原语
 *（apps/acode-cli/specs/scheduled-manual-trigger-activation.md R1-R5）。
 *
 * 背景：`runAutomationNow` 经 RemoteServiceAccess 暴露为远程 channel 代理，任何能说
 * 该协议的代码都能程序化唤起一次无人值守高档执行。本模块把「远程发起的立即执行必须
 * 携带明确的用户动作凭据」收敛为单一裁决点：闭集 reason、新鲜窗、origin 语义全部住
 * 这里，调用点（services 咽喉 / 未来的 RPC 接线）只消费裁决，不各自拼字符串。
 *
 * 仅含纯函数与常量、无任何 import：可被 node --test 直接加载做不变量守护测试，
 * 浏览器/渲染进程可安全引用（bot-remote-guard.ts 同款形态）。
 *
 * 诚实边界（spec R6）：v1 凭据是声明式的（attested）——本模块裁决形状与新鲜度，
 * 不裁决真伪；origin 必须由装配层按传输事实声明（spec R3），不得做成 wire 入参
 * 让远程调用方自报免检。
 */

/** 手动触发的调用来源：装配层按传输事实声明（desktop 本地 IPC vs 远程 channel）。 */
export const AUTOMATION_MANUAL_TRIGGER_ORIGINS = ["local_ui", "remote"] as const;

export type AutomationManualTriggerOrigin = (typeof AUTOMATION_MANUAL_TRIGGER_ORIGINS)[number];

/** 用户动作凭据的来源闭集。v1 只有 UI 按钮点击；扩展必须先改 spec。 */
export const AUTOMATION_MANUAL_TRIGGER_ACTIVATION_SOURCES = ["ui_button"] as const;

export type AutomationManualTriggerActivationSource =
  (typeof AUTOMATION_MANUAL_TRIGGER_ACTIVATION_SOURCES)[number];

/** 拒绝 reason 闭集（spec R2 表）。 */
export const AUTOMATION_MANUAL_TRIGGER_REJECT_REASONS = [
  "activation_required",
  "activation_expired",
  "activation_source_unknown",
  "activation_malformed",
] as const;

export type AutomationManualTriggerRejectReason =
  (typeof AUTOMATION_MANUAL_TRIGGER_REJECT_REASONS)[number];

/** 用户动作凭据（v1 声明式，spec R1）。 */
export interface AutomationManualRunActivation {
  source: AutomationManualTriggerActivationSource;
  /** 用户动作发生时刻（epoch ms），由发起端时钟填写。 */
  activatedAt: number;
  /** 关联交互 id（幂等/审计关联键），可选。 */
  interactionId?: string;
}

/** 手动触发上下文：origin 是传输事实，activation 是用户动作事实。 */
export interface AutomationManualRunTriggerContext {
  origin?: AutomationManualTriggerOrigin;
  /** 未校验的凭据（wire 形状未知）；校验归 resolveAutomationManualTriggerAdmission。 */
  activation?: unknown;
}

/** 凭据新鲜窗：点击到 RPC 落地的裕量（spec R4）。 */
export const AUTOMATION_MANUAL_TRIGGER_ACTIVATION_TTL_MS = 5 * 60_000;

/** 时钟偏差容忍：activatedAt 超前 now + skew 按 expired 拒（未来时间戳是伪造特征）。 */
export const AUTOMATION_MANUAL_TRIGGER_CLOCK_SKEW_MS = 60_000;

export type AutomationManualTriggerAdmission =
  | {
      admitted: true;
      /** 归一化事实，供调用点审计日志消费。compat = origin 缺席的兼容窗放行（R5）。 */
      origin: AutomationManualTriggerOrigin | "compat_untagged";
      activation?: AutomationManualRunActivation;
    }
  | { admitted: false; reason: AutomationManualTriggerRejectReason };

/**
 * 形状校验（R2 `activation_malformed` / `activation_source_unknown`）。
 * unknown 入参：wire 形状不可信，逐字段收窄。
 */
function parseActivation(
  value: unknown,
): AutomationManualRunActivation | AutomationManualTriggerRejectReason {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "activation_malformed";
  }
  const candidate = value as { source?: unknown; activatedAt?: unknown; interactionId?: unknown };
  if (typeof candidate.source !== "string") return "activation_malformed";
  if (
    !(AUTOMATION_MANUAL_TRIGGER_ACTIVATION_SOURCES as readonly string[]).includes(candidate.source)
  ) {
    return "activation_source_unknown";
  }
  const activatedAt = candidate.activatedAt;
  if (typeof activatedAt !== "number" || !Number.isFinite(activatedAt)) {
    return "activation_malformed";
  }
  if (candidate.interactionId !== undefined && typeof candidate.interactionId !== "string") {
    return "activation_malformed";
  }
  return {
    source: candidate.source as AutomationManualTriggerActivationSource,
    activatedAt,
    ...(typeof candidate.interactionId === "string"
      ? { interactionId: candidate.interactionId }
      : {}),
  };
}

/**
 * 唯一裁决点（spec R1/R2/R5）：
 * - activation 缺席：origin=remote → `activation_required` 拒；local_ui / 兼容窗放行。
 * - activation 在场：任何 origin 下都校验（垃圾凭据无兼容豁免，R5）——形状/来源/
 *   新鲜度任一不过即按对应闭集 reason 拒。
 */
export function resolveAutomationManualTriggerAdmission(
  trigger: AutomationManualRunTriggerContext | undefined,
  now: number,
): AutomationManualTriggerAdmission {
  const origin = trigger?.origin;
  const rawActivation = trigger?.activation;

  if (rawActivation === undefined) {
    if (origin === "remote") return { admitted: false, reason: "activation_required" };
    // local_ui：本地 UI 面即用户动作面；兼容窗（origin 缺席）：接线前的既有调用方形状。
    return origin === "local_ui"
      ? { admitted: true, origin }
      : { admitted: true, origin: "compat_untagged" };
  }

  const parsed = parseActivation(rawActivation);
  if (typeof parsed === "string") return { admitted: false, reason: parsed };

  const age = now - parsed.activatedAt;
  if (
    age > AUTOMATION_MANUAL_TRIGGER_ACTIVATION_TTL_MS ||
    age < -AUTOMATION_MANUAL_TRIGGER_CLOCK_SKEW_MS
  ) {
    return { admitted: false, reason: "activation_expired" };
  }

  return origin === "remote" || origin === "local_ui"
    ? { admitted: true, origin, activation: parsed }
    : { admitted: true, origin: "compat_untagged", activation: parsed };
}
