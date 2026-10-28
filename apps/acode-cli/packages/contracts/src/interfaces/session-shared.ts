// ============================================================
// Session shared primitives - leaf types across session contracts
// ============================================================
// 架构断环叶子（specs/architecture-contracts-module.md）：CollaborationMode / RiskLevel /
// TurnSteer* / TurnInputIntentMetadata 原住在 session.port.ts，而 session.events、
// permission.port、session-store.port、hooks、tools/contract 都要反向引用它们，
// 形成文件级 import 环（architecture forbidCycles 对 managed 模块按文件粒度执行，
// type-only import 同样算边）。下沉到本叶子文件断环；session.port.ts 原样再导出，
// 所有既有导入路径与包导出面逐名不变。
//
// 第二批下沉（2026-10-28 例外债务偿还 batch B）：SessionTitleSource / MessageVisibility /
// SyntheticUserMessageSource 原住在 session-store.port.ts，session.events.ts 反向引用它们，
// 构成 session.events ↔ session-store.port 文件级环。下沉到本叶子断环后，
// session-store.port.ts 与 session.events.ts 互不再直接引用（各自经本叶子取词汇），
// 原路径桶级再导出保持包导出面与导入路径逐名不变。
//
// 本文件必须保持叶子地位：只允许依赖外部包（ModelSelection 直接取自
// @acode/shared/model-selection——与 model/model.ts 的再导出同源——而不是内部
// model 桶文件，否则会重新引入 session-shared → model → tools/contract → session-shared 的环）。
// 新增词汇均为纯字面量联合，零新增依赖，叶子地位不变。
// 消费方：
// - events 侧叶子（session-event-lifecycle / session-event-turn）经本文件直取，
//   不再绕道 session-store 桶；
// - telemetry/agent-execution.ts 仍按原路径从 interfaces/session-store.port.js 桶导入，
//   该桶原样再导出本文件三组词汇，路径不变。
// - session-store.port.ts 桶原样再导出（导出面不变）；store 侧各叶子按需直取本文件。

import type { ModelSelection } from "@acode/shared/model-selection";

// dontAsk（specs/permission-adjudication-batch2.md R1，接线项 1 落地）：无人可问的
// 裁决姿态——allow 白名单照常放行、deny 照常拒，唯一变化是一切 ask 收敛为不弹卡
// deny。cron/off-peak/-p 无头场景的安全默认位候选；桌面/远端审批面语义不变。
export type CollaborationMode = "plan" | "build" | "edit" | "yolo" | "auto" | "dontAsk";
export type RiskLevel = "low" | "medium" | "high" | "critical";
export type TurnSteerRejectReason =
  | "no_active_turn"
  | "expected_turn_mismatch"
  | "turn_not_steerable"
  | "empty_input"
  | "input_too_large";

export type TurnSteerCommandKind = "sendText" | "sendGoalCommand" | "compact";
export type TurnSteerSource = "plan_approval_feedback" | "workflow_refine_feedback";

/**
 * 输入投递语义：
 * - "queue"：排队的未来意图，消费时切新 product turn（每条一轮，自己的回复/工时/edit 范围）；
 * - "guide"：对进行中工作的补充引导，内联在当前轮，不切轮。
 * runtime 注入机制两者相同（boundary 注入），差异只在产品呈现与账本语义。
 */
export type TurnSteerDeliveryMode = "guide" | "queue";

// ── 第二批下沉词汇（原住 session-store.port.ts；session.events 反向引用，下沉断环）──
// 三组均为纯字面量联合，零新增依赖；原路径（session-store.port.ts 桶）原样再导出。

export const SESSION_TITLE_SOURCES = ["default", "first_input", "generated", "custom"] as const;
export type SessionTitleSource = (typeof SESSION_TITLE_SOURCES)[number];

export const MESSAGE_VISIBILITIES = ["user-visible", "model-only"] as const;
export type MessageVisibility = (typeof MESSAGE_VISIBILITIES)[number];

export const SYNTHETIC_USER_MESSAGE_SOURCES = [
  // 跨回合 auto-resume（specs/turn-auto-resume.md）：临时性故障退避后由 runtime 注入的
  // model-only 继续指令；与 goal-continuation 同档（runtime 注入提醒，非用户真实动作）。
  "auto_resume",
  "background_task",
  "fork",
  "goal_state_change",
  "goal-continuation",
  // peer 消息镜像（specs/agent-peer-messaging.md R5）：成功受理的兄弟间消息落共同父
  // 会话的 model-only 合成 notice，冷目录/审计因此看得到 peer 流量。
  "peer_message",
  "plugin_reference",
  "rewind",
  "selection_side_chat",
  "subagent",
  "subagent_message",
  "todo_reminder",
  // 工具按需检索公告（specs/tool-search.md R9）：公告是持久化轨迹的一部分，
  // 作为 model-only synthetic notice 落库，冷恢复按 runtimeMessage metadata 重建。
  "tool_search_announcement",
  // 中枢直接启动已保存工作流时落的那条 user 消息的来源。
  // 它虽是 synthetic（GUI 用元数据画启动卡而非显示文本），语义上却是用户真实动作：
  // origin=real_user、kind=user_prompt，与其余「运行时注入的提醒」类来源不同档。
  "workflow_launch",
  "shared_context",
] as const;
export type SyntheticUserMessageSource = (typeof SYNTHETIC_USER_MESSAGE_SOURCES)[number];

/** 协议无关的输入 intent metadata；bootstrap v4 在事件边界组装为 ConversationInputIntent。 */
export interface TurnInputIntentMetadata {
  planEnabled?: boolean;
  sourceCommandId: string;
  queueItemId: string;
  clientId: string;
  kind: TurnSteerCommandKind;
  /** transcript hydration 贯穿完整 ConversationInputIntent 的 canonical command text。 */
  text?: string;
  /** Admission 时固定；Queue/Guide 后续不得重新读取 Composer 或 Session 最新选择。 */
  modelSelection?: ModelSelection;
  /** 与本次用户 Submission 一起固定的协作模式。与 shared submissionModeSchema /
   * CollaborationMode 用户可提交子集保持一致（dontAsk 随权限批 2 扩入——
   * execution-state 规范化边界曾因缺档把 --mode dontAsk 静默降级回 build，
   * E2E 决策日志实证，见 shared/test/executionStateDontAsk.test.ts）。 */
  mode?: "build" | "edit" | "plan" | "yolo" | "dontAsk";
  admissionSeq: number;
  admittedAt: number;
  requestedDelivery: "auto" | "startNow" | "queue" | "guide";
  admittedDelivery: "startNow" | "queue" | "guide";
  queuePosition?: number;
  fallbackReasonCode?: string;
  attachmentRefs?: Array<{
    ref: string;
    fileName: string;
    mime: string;
    bytes: number;
    previewRef?: string;
  }>;
  /** edit/retry 重建的新 command 对原始 canonical input cause 的稳定追溯。 */
  provenance?: {
    sourceCommandId: string;
    queueItemId?: string;
    clientId?: string;
  };
}
