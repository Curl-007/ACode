// ============================================================
// Session Events - All event types for the agent loop
// ============================================================
// 例外债务偿还（2026-10-28，batch B）：原 1373 行单文件按主题拆为 9 个叶子，
// 本文件降级为纯桶，导入路径与导出面逐名不变（消费方零改动）。
// 叶子职责（依赖方向为严格 DAG）：
//   session-event-type.js           —— SessionEvent 信封 + SessionEventType 词表（最底层）
//   session-event-support.js        —— 支撑类型（attachment/message/tool payload/usage/error）
//   session-event-lifecycle.js      —— session 生命周期载荷（含 SystemMessagePayload）
//   session-event-workflow-launch.js—— 启动轮元数据（WorkflowLaunchMeta + 有界函数）与后台结果元信息
//   session-event-turn.js           —— turn/输入控制载荷（依赖 workflow-launch + support）
//   session-event-model.js          —— 模型侧载荷（依赖 support）
//   session-event-tool.js           —— 工具调用与后台任务载荷（依赖 support）
//   session-event-runtime.js        —— workflow run/插件/swarm/权限/hook/target 载荷
//   session-event-factory.js        —— createSessionEvent / usage 汇总 / SessionEventPayload 联合（最顶层）
// 断环纪律：SessionTitleSource / MessageVisibility / SyntheticUserMessageSource / CollaborationMode
// / RiskLevel / TurnSteer* 等共享词汇的权威定义在 interfaces/session-shared.ts（下沉叶），
// 消除 session.events ↔ session-store.port 的文件级 import 环（forbidCycles）；
// PermissionDecision 定义本就在 permission.port.ts（反向引用事件类型，留在那边）。
// 原文件头部两个类型导入（ExecutionOutputPreview / RuntimeInputPresentation）随使用方迁往
// tool / turn 叶子，桶层不再保留；原首行 max-lines 抑制头注随拆分移除。
//
// Re-export for convenience（原文件原样保留）
export type { CollaborationMode, RiskLevel } from "../interfaces/session-shared.js";
export type { PermissionDecision } from "../interfaces/permission.port.js";

// Re-export ModelToolCall as ToolCall for core usage
export type { ModelToolCall as ToolCall } from "../model/index.js";

export * from "./session-event-type.js";
export * from "./session-event-support.js";
export * from "./session-event-lifecycle.js";
export * from "./session-event-workflow-launch.js";
export * from "./session-event-turn.js";
export * from "./session-event-model.js";
export * from "./session-event-tool.js";
export * from "./session-event-runtime.js";
export * from "./session-event-factory.js";
