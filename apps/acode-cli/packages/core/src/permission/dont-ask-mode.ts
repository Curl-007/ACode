// ============================================================
// dontAsk 裁决姿态（specs/permission-adjudication-batch2.md R1）
// ============================================================
// 无人可问 → 不弹卡、不挂起、直接拒：PermissionService 的 ask() 单一漏斗在
// mode === "dontAsk" 时把一切会弹审批窗的决策收敛为 deny。本文件是纯层：
// 词汇、类型与拒绝文案（自撰英文 = 模型面文本，prompt-language-policy R3），
// 零 IO、零对其它 permission 模块的依赖。
//
// 与既有档位的关系：dontAsk 不放宽任何东西——allow 白名单（只读直通、项目/
// 会话/TTL 规则、allowedTools、预批面）照常放行，deny 照常 deny，唯一的变化
// 是 ask 终局化为 deny（deny 严于 ask，「地板只收紧」不变量在时序上成立）。

import type { CollaborationMode } from "@acode/contracts";

/** dontAsk 模式值（CollaborationMode 之外的权限层扩展档）。 */
export const DONT_ASK_MODE = "dontAsk";

/** dontAsk 拒绝的 ruleId（闭集词汇；对应「决策原因 = 模式本身」的语义）。 */
export const DONT_ASK_RULE_ID = "mode.dontAsk";

/**
 * 权限层裁决模式闭集：CollaborationMode 五档 + dontAsk。
 * contracts 层联合类型（session-shared.ts）的扩展是接线项（spec「接线需求」1）；
 * 权限面先以本扩展类型消费——既有调用方传 CollaborationMode 值照常编译。
 */
export type PermissionAdjudicationMode = CollaborationMode | typeof DONT_ASK_MODE;

/** 模式词汇全集（闭集常量；接线后的校验面/UI 面从这里取值，不另抄一份）。 */
export const PERMISSION_ADJUDICATION_MODES: readonly PermissionAdjudicationMode[] =
  Object.freeze([
    "plan",
    "build",
    "edit",
    "yolo",
    "auto",
    DONT_ASK_MODE,
  ] as const satisfies readonly PermissionAdjudicationMode[]);

export function isDontAskMode(mode: unknown): boolean {
  return mode === DONT_ASK_MODE;
}

/**
 * deny 投影的缺省截断界是 500 字符（非 preserveReasonFormatting 通道）；文案
 * 全文控制在界内，行为指令（未执行/不重试/报告用户）不因截断丢失。
 */
const DONT_ASK_REASON_MAX_CHARS = 480;
/** 归因段里原 ask reason 的截断（自由文本只做诊断，ruleId 才是归因主键）。 */
const DONT_ASK_ATTRIBUTION_REASON_MAX_CHARS = 60;

export interface DontAskDenialAttribution {
  /** 本来会弹卡的那条规则的 ruleId（归因主键）。 */
  underlyingRuleId: string;
  /** 本来会弹卡的 reason（截断进文案）。 */
  underlyingReason?: string;
  /** 工具的 requiresUserInteraction 能力位（文案变体选择）。 */
  requiresUserInteraction?: boolean;
}

const DONT_ASK_COMMON_TAIL =
  " The action was NOT performed. Do not claim it succeeded and do not retry it" +
  " in this session; tell the user what was blocked and why you needed it, or" +
  " continue with the parts of the task that require no approval.";

/**
 * 按工具的 dontAsk 拒绝文案（自撰）：两变体——requiresUserInteraction 工具
 * （需要交互批准而本会话没有批准面）与通用工具（未被规则放行的一律拒绝且
 * 不弹卡）。归因段携带原 ruleId（+ 截断 reason），审计与模型面都能看到
 * 「本来会因为什么弹卡」。
 */
export function buildDontAskDenialReason(
  toolName: string,
  attribution: DontAskDenialAttribution,
): string {
  const attributionText = buildAttributionText(attribution);
  const head = attribution.requiresUserInteraction
    ? `Tool ${toolName} was denied without a prompt: it requires interactive approval and this session has no approval surface - nobody can answer a prompt here, so it was denied automatically${attributionText}.`
    : `Permission to use ${toolName} was denied without a prompt: this session runs in don't-ask mode, where anything not already allowed by rules is refused and no approval card is ever shown${attributionText}.`;
  const reason = `${head}${DONT_ASK_COMMON_TAIL}`;
  return reason.length > DONT_ASK_REASON_MAX_CHARS
    ? `${reason.slice(0, DONT_ASK_REASON_MAX_CHARS - 1)}…`
    : reason;
}

function buildAttributionText(attribution: DontAskDenialAttribution): string {
  const detail =
    typeof attribution.underlyingReason === "string" && attribution.underlyingReason.length > 0
      ? `: ${truncateText(attribution.underlyingReason, DONT_ASK_ATTRIBUTION_REASON_MAX_CHARS)}`
      : "";
  return ` (would have asked under rule "${attribution.underlyingRuleId}"${detail})`;
}

function truncateText(text: string, maxChars: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > maxChars ? `${oneLine.slice(0, maxChars - 1)}…` : oneLine;
}
