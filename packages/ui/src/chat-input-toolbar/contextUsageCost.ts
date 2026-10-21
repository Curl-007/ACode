import { getUsage } from "tokenlens";
import type { SessionUsageState } from "@acode/shared/acode-protocol-v4";
import { logger } from "../logger.js";

type SessionCumulative = SessionUsageState["cumulative"];

/**
 * 会话累计预估费用（USD）（apps/acode-cli/specs/usage-statusbar-port.md 会话段明细节）。
 *
 * 口径：`cumulative.inputTokens` 已包含缓存读取，`cacheReadTokens`/`cacheWriteTokens`
 * 不参与二次相加，与 tokenlens 期望的「输入侧总量」一致。代价是不体现缓存折扣、
 * 金额偏保守（偏高），由 UI 的「预估」标记承担。
 *
 * 返回 `null` 表示「不显示」（模型未收录、入参缺失或计算失败）；`null` 与 `0` 必须严格区分：
 * `0` 是「确实花了不到 1 美分」，照常显示 `$0.00`。
 */
export function resolveContextUsageCostUSD(input: {
  modelId: string | null | undefined;
  cumulative: SessionCumulative | null | undefined;
}): number | null {
  const { modelId, cumulative } = input;
  // tokenlens 的 helpers 在 modelId 为 undefined/null 时会直接抛 TypeError；
  // 这里先做类型收窄，try/catch 只用来兜第三方定价表未来的行为变化。
  if (!modelId || !cumulative) {
    return null;
  }

  let totalUSD: number | undefined;
  try {
    totalUSD = getUsage({
      modelId,
      usage: { input: cumulative.inputTokens, output: cumulative.outputTokens },
    }).costUSD?.totalUSD;
  } catch (error) {
    logger.debug("[context-usage-cost] 计算预估费用失败", { modelId, error });
    return null;
  }

  // 判据是「是否为有限数」而不是「是否 > 0」：未收录模型返回 {}，若回落成 0
  // 就会把「定价表没有这个模型」伪报成「本会话没花钱」。
  if (typeof totalUSD !== "number") {
    logger.debug("[context-usage-cost] 定价表未收录模型", { modelId });
    return null;
  }
  if (!Number.isFinite(totalUSD)) {
    logger.debug("[context-usage-cost] 定价表返回非有限金额", { modelId, totalUSD });
    return null;
  }

  return totalUSD;
}
