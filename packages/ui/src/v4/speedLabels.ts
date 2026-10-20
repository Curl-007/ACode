import type { TurnHeaderStats } from "@acode/shared/acode-protocol-v4";

// 消息级回复速度标签（specs/chat-row-facts.md 第 3 节）：复用原生轮次事实面
// turnHeader.stats（core producer 单点计算、投影持久化），零协议扩展、零轮询。
// 只依赖标签计算实际读取的四个字段：逻辑测试可直接构造字面量，
// 组件传入完整 stats 亦天然兼容。
type TurnSpeedFacts = Pick<
  TurnHeaderStats,
  "inputTokens" | "outputTokens" | "timeToFirstTokenMs" | "generationMs"
>;

export interface SpeedLabels {
  /**
   * prefill 吞吐（Σinput ÷ TTFT，思考/首字前的提示词处理段）；stats 缺席、
   * TTFT 缺席或为 0（全缓存直出）时 null——只显示 ↓ 是预期行为。
   */
  prefillLabel: string | null;
  /** decode 吞吐（Σoutput ÷ ΣgenerationMs，与 TurnRateLine 同口径）；缺席或分母 0 时 null。 */
  decodeLabel: string | null;
}

/** 缺席 ≠ 0：任一事实缺席、非有限或 ≤0 → null（对应标签整段隐藏，不显示 0）。 */
function deriveRate(tokens: number | undefined, durationMs: number | undefined): number | null {
  if (
    tokens === undefined ||
    !Number.isFinite(tokens) ||
    tokens <= 0 ||
    durationMs === undefined ||
    !Number.isFinite(durationMs) ||
    durationMs <= 0
  )
    return null;
  const rate = (tokens * 1000) / durationMs;
  return Number.isFinite(rate) ? rate : null;
}

export function formatSpeedLabels(
  stats: TurnSpeedFacts | null | undefined,
  numberFormat: Intl.NumberFormat,
  // 单位后缀走 i18n（键 chat.usageStatusbar.unit.tokensPerSecond，双语同值 "tok/s"）；
  // 缺省保底供非 UI 调用与测试。
  unitSuffix = "tok/s",
): SpeedLabels {
  const prefill = deriveRate(stats?.inputTokens, stats?.timeToFirstTokenMs);
  const decode = deriveRate(stats?.outputTokens, stats?.generationMs);
  return {
    prefillLabel: prefill === null ? null : `${numberFormat.format(prefill)} ${unitSuffix}`,
    decodeLabel: decode === null ? null : `${numberFormat.format(decode)} ${unitSuffix}`,
  };
}
