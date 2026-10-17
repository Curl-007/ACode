// 上下文环 auto-compact 阈值增强（specs/usage-statusbar.md「上下文容量」行）：
// 接近 autoCompactThresholdTokens 分档变色 + 悬停处置建议（compact/新会话）。
// 纯函数 leaf：contextUsage.tsx 只留最小接线行；阈值事实来自
// snapshot.usage.contextWindow.autoCompactThresholdTokens（bootstrap 投影单一写入方）。

export type ContextAutoCompactTone = "normal" | "near" | "critical";

/**
 * 进入「接近」档的 used/threshold 比值；≥1 = 已达阈值（critical）。
 * 分档只驱动呈现（变色 + 建议文案），不参与任何数据计算。
 */
export const CONTEXT_AUTO_COMPACT_NEAR_RATIO = 0.85;

export interface ContextAutoCompactState {
  tone: ContextAutoCompactTone;
  /** 触发器分色 class（环用 currentColor 描边，改文字色即改环色）。 */
  triggerClassName: string | null;
  /** 悬停处置建议的 i18n message id；null = 不显示建议。 */
  adviceMessageId:
    | "chat.contextUsage.autoCompactNear"
    | "chat.contextUsage.autoCompactReached"
    | null;
  /** 建议文案里的阈值展示值；adviceMessageId 非 null 时必在场。 */
  thresholdTokens: number | null;
}

const NORMAL_STATE: ContextAutoCompactState = {
  tone: "normal",
  triggerClassName: null,
  adviceMessageId: null,
  thresholdTokens: null,
};

export function resolveContextAutoCompactState(params: {
  usedTokens: number;
  autoCompactThresholdTokens: number | null | undefined;
}): ContextAutoCompactState {
  const { usedTokens, autoCompactThresholdTokens } = params;
  // 阈值缺席（旧投影恒 null）或非法 → 不分档、不建议，环保持既有中性色。
  if (
    typeof autoCompactThresholdTokens !== "number" ||
    !Number.isFinite(autoCompactThresholdTokens) ||
    autoCompactThresholdTokens <= 0 ||
    !Number.isFinite(usedTokens) ||
    usedTokens <= 0
  ) {
    return NORMAL_STATE;
  }
  const ratio = usedTokens / autoCompactThresholdTokens;
  if (ratio >= 1) {
    return {
      tone: "critical",
      triggerClassName: "text-destructive",
      adviceMessageId: "chat.contextUsage.autoCompactReached",
      thresholdTokens: autoCompactThresholdTokens,
    };
  }
  if (ratio >= CONTEXT_AUTO_COMPACT_NEAR_RATIO) {
    return {
      tone: "near",
      triggerClassName: "text-warning",
      adviceMessageId: "chat.contextUsage.autoCompactNear",
      thresholdTokens: autoCompactThresholdTokens,
    };
  }
  return NORMAL_STATE;
}
