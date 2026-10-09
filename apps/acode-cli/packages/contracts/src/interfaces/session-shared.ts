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
// 本文件必须保持叶子地位：只允许依赖外部包（ModelSelection 直接取自
// @acode/shared/model-selection——与 model/model.ts 的再导出同源——而不是内部
// model 桶文件，否则会重新引入 session-shared → model → tools/contract → session-shared 的环）。

import type { ModelSelection } from "@acode/shared/model-selection";

export type CollaborationMode = "plan" | "build" | "edit" | "yolo" | "auto";
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
  /** 与本次用户 Submission 一起固定的协作模式。 */
  mode?: "build" | "edit" | "plan" | "yolo";
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
