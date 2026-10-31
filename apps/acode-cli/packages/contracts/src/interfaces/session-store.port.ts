// Session Store Port：为会话输入、消息和投影提供稳定的存储边界。
// ============================================================
// 例外债务偿还（2026-10-28，batch B）：原 1282 行单文件按主题拆为 7 个叶子，
// 本文件降级为纯桶，导入路径与导出面逐名不变（消费方零改动）。
// 叶子职责：
//   session-store-vocab.js   —— 任务类型 / 消息语义 / 投影锚点词汇（含三组下沉共享词汇的再导出）
//   session-store-entry.js   —— session entry 词表 + session_input 账本
//   session-store-message.js —— user/assistant 消息记录（FileDiff 下沉于此，断 message↔session 环）
//   session-store-parts.js   —— message part 全类型 + MessageWithParts
//   session-store-session.js —— 会话记录 / fork 提交束 / revert
//   session-store-usage.js   —— 用量账本 + UsageStorePort
//   session-store-port.js    —— SessionStorePort / LocalSettingStorePort 端口本体
// 断环：SessionTitleSource / MessageVisibility / SyntheticUserMessageSource 的权威定义下沉到
// session-shared.ts（session.events 与 session-store 共享的叶子），消除
// session.events ↔ session-store.port 文件级 import 环（forbidCycles）。

export * from "./session-store-vocab.js";
export * from "./session-store-entry.js";
export * from "./session-store-message.js";
export * from "./session-store-parts.js";
export * from "./session-store-session.js";
export * from "./session-store-usage.js";
export * from "./session-store-port.js";
