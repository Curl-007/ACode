// ============================================================
// Agent exports
// ============================================================

export * from "./turn-state.js";
export * from "./turn-machine.js";
export { MessageHistoryImpl, createMessageHistory } from "./message-history.js";
export {
  activeSessionMessages,
  hydrateMessageHistoryFromSession,
} from "./session-history-hydrator.js";
export type {
  MessageHistory,
  ModelInputMessage,
  ToolCallInput,
  CacheStats,
} from "./message-history.js";
export type { SessionHistoryHydrationResult } from "./session-history-hydrator.js";
// 用户指名技能调用标记（skill-frontmatter-governance R6 硬门接线）：CLI 手动
// /skill 提交路径是单一写者，经 @acode/core 公开入口消费（core 内部直连叶子）。
export {
  clearUserInvokedSkillMarker,
  consumeUserInvokedSkillMarker,
  markUserInvokedSkillForTurn,
} from "./skill-user-invocation.js";
