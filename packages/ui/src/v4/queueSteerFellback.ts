// 引导内联失败回退队列（steer.state="fellBack"）的 reasonCode → i18n 文案 id 映射。
// 抽成纯函数便于 node:test 直测（对齐 speedLabels.ts 先例），也让 ConversationQueuePanel
// 只关心渲染、不关心 reasonCode 词表。
//
// 根因：投影层已把引导回退事实写进 QueueItem.steer（state="fellBack" + reasonCode），
// 但 UI 从不读该字段，用户看到引导消息静默降级成普通排队项、无任何说明（「被吞掉」）。
// reasonCode 是 Core fallbackPendingGuidesToQueue 产出的有限闭集，逐一给可读文案；
// 未知/缺省落通用兜底，不显示裸码、不报错。

const GUIDE_FELLBACK_MESSAGE_ID_BY_REASON: Readonly<Record<string, string>> = {
  // 当前轮无可用工具批次边界内联（工具执行中 / 纯文本收口）。
  "guide.noToolBoundary": "chat.queue.turnSteer.fellBack.noToolBoundary",
  // 当前轮被中断（stop / 取消）。
  "guide.turnInterrupted": "chat.queue.turnSteer.fellBack.turnInterrupted",
  // 引导携带附件，内联不支持附件。
  "guide.attachmentsUnsupported": "chat.queue.turnSteer.fellBack.attachmentsUnsupported",
};

const GUIDE_FELLBACK_GENERIC_MESSAGE_ID = "chat.queue.turnSteer.fellBack";

/**
 * 返回 fellBack 提示的 i18n message id。
 * reasonCode 缺席或不在闭集内 → 通用兜底文案 id（不抛、不返回裸码）。
 */
export function resolveGuideFellBackMessageId(reasonCode?: string): string {
  if (reasonCode === undefined) return GUIDE_FELLBACK_GENERIC_MESSAGE_ID;
  return GUIDE_FELLBACK_MESSAGE_ID_BY_REASON[reasonCode] ?? GUIDE_FELLBACK_GENERIC_MESSAGE_ID;
}
