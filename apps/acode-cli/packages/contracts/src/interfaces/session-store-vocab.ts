// ============================================================
// Session Store vocab - task types / message semantics / projection anchors
// ============================================================
// 例外债务偿还（2026-10-28，batch B）：session-store.port.ts（1282 行）按主题拆叶，
// 本文件承载存储侧基础词汇：会话任务类型、消息语义与 v4 投影锚点词汇。
// 断环纪律：SessionTitleSource / MessageVisibility / SyntheticUserMessageSource 的权威定义
// 已下沉 interfaces/session-shared.ts（session.events ↔ session-store 词汇环的共享叶），
// 本文件原样再导出以保持 session-store 桶的导出面逐名不变。
// 依赖方向（DAG）：shared.js / tools/target.js / session-shared.js → 本文件 →
// message/parts/session/usage/port 叶 → session-store.port.ts 桶。

import type { MessageId, TurnId } from "./shared.js";
import type { SessionGoal } from "../tools/target.js";

// 三组共享词汇的权威定义在 session-shared.ts（断环叶）；此处原样再导出，
// session-store 桶的历史导入路径与导出面不变。
export {
  SESSION_TITLE_SOURCES,
  MESSAGE_VISIBILITIES,
  SYNTHETIC_USER_MESSAGE_SOURCES,
} from "./session-shared.js";
export type {
  SessionTitleSource,
  MessageVisibility,
  SyntheticUserMessageSource,
} from "./session-shared.js";

export const SESSION_TASK_TYPES = [
  "interactive",
  "fork",
  "selection_side_chat",
  "workflow_parent",
  "workflow_child",
  "subagent_child",
  "nested_workflow_child",
  // overnight（K3）隐藏 coordinator 的 fork 会话（specs/overnight-execution.md R1a）。
  // 必须与 "fork" 区分：侧栏可见性由持久化的 taskType 决定（isTaskListSessionType 把
  // interactive/fork/workflow_parent 判为可见），而 coordinator 是「不进 UI 会话列表」的形态。
  // 用 "fork" 落盘会让它在 CLI 冷重启后被 seed 投进侧栏显示为「Fork of X」——隐藏语义跨重启失效。
  // 刻意**不**加入 TASK_LIST_SESSION_TYPES：可见性靠既有集合的「不在即不可见」生效，
  // 不新增 hidden 列或侧栏过滤分支（避免重复状态与第二条可见性写入路径）。
  // 无 DB 迁移：session.task_type 是无 CHECK 约束的 text 列。
  // 运行期 config.taskType 仍是 "fork"（见 overnight-controller 的 configOverrides），
  // 因为 isMainMemoryTaskType 等运行期门正向枚举 "fork"；本值只用于持久化行的可见性判定。
  "overnight_coordinator",
] as const;
export type SessionTaskType = (typeof SESSION_TASK_TYPES)[number];

export type MessageSemanticsOrigin =
  | "real_user"
  | "agent_runtime"
  | "system"
  | "migration"
  | "import";

export type MessageSemanticsKind =
  | "user_prompt"
  | "slash_command"
  | "system_reminder"
  | "background_notification"
  | "subagent_notification"
  | "todo_reminder"
  | "rewind_notice"
  | "fork_notice"
  | "timeline_event"
  | "compact_summary"
  | "shared_context"
  | "assistant_response";

export interface MessageSemantics {
  origin: MessageSemanticsOrigin;
  kind: MessageSemanticsKind;
  source?: string;
  commandName?: string;
  uiVisibility: "visible" | "hidden" | "debug";
  providerVisibility: "visible" | "hidden";
  transcriptVisibility: "visible" | "hidden";
}

// v4 投影锚点词表（userInput.origin）。
// 与 MessageSemanticsOrigin 并存不互替：semantics.origin 是旧读侧语义，
// anchor.origin 是新协议 row 派生依据；老值由读侧只读映射。
export const MESSAGE_ANCHOR_ORIGINS = [
  "realUser",
  "backgroundResult",
  "goalContinuation",
  "mailbox",
  "synthetic",
] as const;
export type MessageAnchorOrigin = (typeof MESSAGE_ANCHOR_ORIGINS)[number];

/**
 * stable fork 的 fork 点 goal 事实。undefined 只表示旧数据；新数据必须显式写 none
 * 或完整快照，避免 fork 时读取 parent 当前 goal 冒充历史状态。
 */
export type StableForkGoalBoundaryMetadata =
  | { kind: "none" }
  | {
      kind: "snapshot";
      target: SessionGoal;
      verificationEntryIds: string[];
    };

/**
 * v4 transcript 锚点（清单）：全部 optional，
 * 走 message JSON blob 的 additive 演进，历史数据留空、读侧宽容降级。
 * sourceCommandId 是命令幂等的 transcript 兜底查重键，
 * 由 v4 command inbox 铺路后写入（接线）。
 */
export interface MessageProjectionAnchor {
  turnId?: TurnId;
  origin?: MessageAnchorOrigin;
  sourceCommandId?: string;
  /** 最终 assistant 固化当前 query 的历史轮次，供 cold hydration 精确恢复。 */
  historyRoundCount?: number;
  /** 新数据的 stable fork 固定边界；历史消息缺省，由唯一 resolver 无歧义时惰性补写。 */
  productTurnId?: string;
  orderedMessageIds?: MessageId[];
  boundaryMessageId?: MessageId;
  goalBoundary?: StableForkGoalBoundaryMetadata;
}
