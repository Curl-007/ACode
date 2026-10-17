// 收尾卡文案（packages/ui/specs/turn-wrap-up-card.md「i18n」）。
// 键已落 en-US.ts / zh-CN.ts（chat.turnWrapUp.*，2026-10-16 接线），过渡期内置英文
// FALLBACK 词典按 spec 写死的移除条件删除；缺失键回落为 id 本身即视为接线回归。
import type { IntlInstance } from "@/i18n/IntlProvider.js";

export const TURN_WRAP_UP_LABEL_KEYS = {
  nextStep: "chat.turnWrapUp.nextStep",
  suggestedTask: "chat.turnWrapUp.suggestedTask",
  showPrompt: "chat.turnWrapUp.showPrompt",
  hidePrompt: "chat.turnWrapUp.hidePrompt",
  startAsNewTask: "chat.turnWrapUp.startAsNewTask",
  copyPrompt: "chat.turnWrapUp.copyPrompt",
  copiedPrompt: "chat.turnWrapUp.copiedPrompt",
} as const;

export type TurnWrapUpLabelKey =
  (typeof TURN_WRAP_UP_LABEL_KEYS)[keyof typeof TURN_WRAP_UP_LABEL_KEYS];

export function formatTurnWrapUpLabel(intl: IntlInstance, id: TurnWrapUpLabelKey): string {
  return intl.formatMessage({ id });
}
