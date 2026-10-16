// ============================================================
// Session Fleet Tools - agent 可管理的并行会话工具族契约
// ============================================================
// 七个工具面（apps/acode-cli/specs/session-fleet.md）：
//   - StartSession：启动用户可见的后台舰队会话（一等对象，返回 session_id 确立所有权）。
//   - SendToSession：跟进消息路由到持有上下文的既有舰队会话（session_id 寻址，非显示名）。
//   - ListSessions：只列本会话自身行 + 本会话所有的舰队会话（权限信息最小化）。
//   - HandOffToSession：任务移交既有/新建会话；被移交会话每收口一个回合记一条
//     「最新报告前 400 字符」的 note（定量截断防刷屏）。
//   - SetSessionPermissionMode：降权/平调直通；升权永不静默——交互式过用户审批
//     （requiresUserInteraction → ask，先于 yolo 直通），无人值守直接拒绝。
//   - ArchiveSession：停跟进、移入归档、对话保留可重开；共享 worktree 或已完成的
//     side 会话级联；在跑的拒绝而非强制；支持 "self"。
//   - DeleteSessions：批量 ≤25；所有权限模式（含 yolo）都过用户审批（bypass 免疫，
//     走既有 requiresUserInteraction ask 面）；绝不删本会话。
//
// 拒绝是**普通工具结果**而非错误（对齐 escalate / session-worktree 的裁决）：模型
// 需要读到闭集 reason 改道，而不是把可预期的边界当成可重试的故障反复撞墙。

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

export const START_SESSION_TOOL_NAME = "StartSession";
export const SEND_TO_SESSION_TOOL_NAME = "SendToSession";
export const LIST_SESSIONS_TOOL_NAME = "ListSessions";
export const HAND_OFF_TO_SESSION_TOOL_NAME = "HandOffToSession";
export const SET_SESSION_PERMISSION_MODE_TOOL_NAME = "SetSessionPermissionMode";
export const ARCHIVE_SESSION_TOOL_NAME = "ArchiveSession";
export const DELETE_SESSIONS_TOOL_NAME = "DeleteSessions";

/** report-back note 的定量截断界（spec R5）：最新报告前 400 字符。 */
export const FLEET_NOTE_MAX_CHARS = 400;
/** DeleteSessions 单批上限（spec R8）。 */
export const FLEET_DELETE_BATCH_MAX = 25;
/** 会话标题上限。 */
export const FLEET_TITLE_MAX_CHARS = 120;
/** ArchiveSession 的自指别名（spec R7）。 */
export const FLEET_SELF_SESSION_ALIAS = "self";

/**
 * 舰队面的权限模式词表：CollaborationMode 去掉 `auto`（auto 是内部无人值守档，
 * 不作为舰队会话的可请求模式）。严苛度序的单一事实源在 core 的 nesting-policy
 * （MODE_SEVERITY），本枚举只是可请求值的闭集。
 */
export const FleetPermissionModeSchema = z.enum(["plan", "build", "edit", "yolo"]);
export type FleetPermissionMode = z.infer<typeof FleetPermissionModeSchema>;

/** ListSessions 行的状态词表（runtime-task 终态词 + archived 折叠）。 */
export const FleetSessionStatusSchema = z.enum([
  "running",
  "completed",
  "failed",
  "cancelled",
  "killed",
  "stopped",
  "lost",
  "archived",
]);
export type FleetSessionStatus = z.infer<typeof FleetSessionStatusSchema>;

/** 拒绝理由闭集（spec R2-R8）。 */
export const FleetRejectReasonSchema = z.enum([
  "unknown_session",
  "not_owned_by_caller",
  "mode_above_launcher",
  "mode_tightening_unsupported",
  "plan_profile_unavailable",
  "escalation_unattended",
  "unattended_turn",
  "subagent_unavailable",
  "background_unavailable",
  "session_running",
  "cascade_session_running",
  "session_archived",
  "includes_self",
  "batch_too_large",
  "worktree_rejected",
  /** 跟进消息投递失败（既有 SendMessage 端口语义的业务失败面）。 */
  "delivery_failed",
  /** HandOffToSession 新建会话缺 title。 */
  "new_session_needs_title",
]);
export type FleetRejectReason = z.infer<typeof FleetRejectReasonSchema>;

// ── StartSession ────────────────────────────────────────────────────

export const StartSessionInputSchema = z
  .object({
    title: z
      .string()
      .min(1)
      .max(FLEET_TITLE_MAX_CHARS)
      .describe("Short human-readable session title shown in the session list."),
    prompt: z
      .string()
      .min(1)
      .describe("Self-contained task prompt; the new session has no other context."),
    permission_mode: FleetPermissionModeSchema.optional().describe(
      "Permission mode for the new session. It can never be higher than your current mode (tighten-only). 'plan' launches a read-only planning session; omit to inherit your current mode.",
    ),
    use_worktree: z
      .boolean()
      .optional()
      .describe(
        "true = isolate the session in a fresh git worktree cut from the current HEAD (uncommitted changes are NOT carried over). Default false = run in the current working directory.",
      ),
    branch_name: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .describe("Optional branch suffix for use_worktree (slugified into acode/session/<slug>)."),
  })
  .strict();
export type StartSessionInput = z.infer<typeof StartSessionInputSchema>;

export const StartSessionOutputSchema = z
  .object({
    outcome: z.enum(["started", "rejected"]),
    reason: FleetRejectReasonSchema.optional(),
    /** 所有权凭据：后续舰队工具只认这个 id（spec R3）。 */
    session_id: z.string().optional(),
    /** runtime-task id（≡ agentId）：既有 TaskOutput / TaskStop 观测与停止面。 */
    task_id: z.string().optional(),
    title: z.string().optional(),
    /** 在案的权限模式（recorded mode，spec R4）。 */
    mode: FleetPermissionModeSchema.optional(),
    worktree_path: z.string().optional(),
    branch: z.string().optional(),
    /** use_worktree 时的隔离基点（launch 时的 HEAD sha）。 */
    base_ref: z.string().optional(),
    message: z.string(),
  })
  .strict();
export type StartSessionOutput = z.infer<typeof StartSessionOutputSchema>;

// ── SendToSession ───────────────────────────────────────────────────

export const SendToSessionInputSchema = z
  .object({
    session_id: z
      .string()
      .min(1)
      .describe(
        "The session id returned by StartSession/HandOffToSession in this transcript. Never a display title.",
      ),
    message: z.string().min(1).describe("Follow-up message delivered to the session."),
    summary: z
      .string()
      .max(200)
      .optional()
      .describe("One-line summary of the follow-up (shown in notifications)."),
  })
  .strict();
export type SendToSessionInput = z.infer<typeof SendToSessionInputSchema>;

export const SendToSessionOutputSchema = z
  .object({
    outcome: z.enum(["sent", "rejected"]),
    reason: FleetRejectReasonSchema.optional(),
    session_id: z.string().optional(),
    delivery: z.enum(["queued", "steered", "resumed_background", "persisted_mailbox"]).optional(),
    message: z.string(),
  })
  .strict();
export type SendToSessionOutput = z.infer<typeof SendToSessionOutputSchema>;

// ── ListSessions ────────────────────────────────────────────────────
// 输入类型刻意命名为 ListFleetSessions*：`ListSessionsInput` 已被
// interfaces/session-store.port.ts 的存储面占用（barrel 同名冲突），而舰队列表
// 本来就是另一个东西——只列本 transcript 所有的舰队会话，不是 store 目录。

export const ListFleetSessionsInputSchema = z
  .object({
    include_archived: z
      .boolean()
      .optional()
      .describe("Include archived fleet sessions (default false)."),
  })
  .strict();
export type ListFleetSessionsInput = z.infer<typeof ListFleetSessionsInputSchema>;

export const ListSessionsRowSchema = z
  .object({
    session_id: z.string(),
    /** self = 调用方自身行；fleet = 调用方启动的舰队会话。 */
    kind: z.enum(["self", "fleet"]),
    title: z.string().optional(),
    status: FleetSessionStatusSchema.optional(),
    /** 权限信息最小化（spec R3）：只在 self 与 fleet 行上出现。 */
    permission_mode: FleetPermissionModeSchema.optional(),
    started_at: z.string().optional(),
    last_activity: z.string().optional(),
    task_id: z.string().optional(),
    worktree_path: z.string().optional(),
    /** 最近一次回合收口的报告 note（前 400 字符；数据非指令）。 */
    latest_note: z.string().optional(),
  })
  .strict();
export type ListSessionsRow = z.infer<typeof ListSessionsRowSchema>;

export const ListSessionsOutputSchema = z
  .object({
    sessions: z.array(ListSessionsRowSchema),
    count: z.number().int().nonnegative(),
    message: z.string(),
  })
  .strict();
export type ListSessionsOutput = z.infer<typeof ListSessionsOutputSchema>;

// ── HandOffToSession ────────────────────────────────────────────────

export const HandOffToSessionInputSchema = z
  .object({
    prompt: z
      .string()
      .min(1)
      .describe("The task hand-off message: what is being handed over and what to do next."),
    session_id: z
      .string()
      .optional()
      .describe(
        "Existing fleet session id (from this transcript) to hand off to. Omit to hand off to a NEW session created from title/prompt.",
      ),
    title: z
      .string()
      .min(1)
      .max(FLEET_TITLE_MAX_CHARS)
      .optional()
      .describe("Title for the new session (required when session_id is omitted)."),
    permission_mode: FleetPermissionModeSchema.optional(),
    use_worktree: z.boolean().optional(),
    branch_name: z.string().min(1).max(64).optional(),
  })
  .strict();
export type HandOffToSessionInput = z.infer<typeof HandOffToSessionInputSchema>;

export const HandOffToSessionOutputSchema = z
  .object({
    outcome: z.enum(["handed_off", "rejected"]),
    reason: FleetRejectReasonSchema.optional(),
    session_id: z.string().optional(),
    task_id: z.string().optional(),
    /** true = 移交到本次新建的会话。 */
    created: z.boolean().optional(),
    message: z.string(),
  })
  .strict();
export type HandOffToSessionOutput = z.infer<typeof HandOffToSessionOutputSchema>;

// ── SetSessionPermissionMode ────────────────────────────────────────

export const SetSessionPermissionModeInputSchema = z
  .object({
    session_id: z.string().min(1),
    mode: FleetPermissionModeSchema.describe(
      "Target permission mode. Downgrades and sidegrades apply directly; an upgrade always requires the user's approval and is refused outright in unattended runs.",
    ),
  })
  .strict();
export type SetSessionPermissionModeInput = z.infer<typeof SetSessionPermissionModeInputSchema>;

export const SetSessionPermissionModeOutputSchema = z
  .object({
    outcome: z.enum(["updated", "rejected"]),
    reason: FleetRejectReasonSchema.optional(),
    session_id: z.string().optional(),
    mode: FleetPermissionModeSchema.optional(),
    previous_mode: FleetPermissionModeSchema.optional(),
    /**
     * 生效边界（spec R4 诚实语义）：`next_turn_boundary` = plan 系会话下一次
     * resume 起绑定；`cold_restore` = 天花板系会话绑定冷恢复面（热 resume 按既有
     * 继承裁决重锚到发起者当前模式，结构天花板独立兜底）。
     */
    binding: z.enum(["next_turn_boundary", "cold_restore"]).optional(),
    message: z.string(),
  })
  .strict();
export type SetSessionPermissionModeOutput = z.infer<typeof SetSessionPermissionModeOutputSchema>;

// ── ArchiveSession ──────────────────────────────────────────────────

export const ArchiveSessionInputSchema = z
  .object({
    session_id: z
      .string()
      .min(1)
      .describe(
        'A fleet session id you own, or the literal "self" to archive the calling session.',
      ),
  })
  .strict();
export type ArchiveSessionInput = z.infer<typeof ArchiveSessionInputSchema>;

export const ArchiveSessionOutputSchema = z
  .object({
    outcome: z.enum(["archived", "rejected"]),
    reason: FleetRejectReasonSchema.optional(),
    session_id: z.string().optional(),
    /** 随单级联归档的会话 id（共享 worktree 或已完成的 side 会话，spec R7）。 */
    cascaded: z.array(z.string()).optional(),
    message: z.string(),
  })
  .strict();
export type ArchiveSessionOutput = z.infer<typeof ArchiveSessionOutputSchema>;

// ── DeleteSessions ──────────────────────────────────────────────────

export const DeleteSessionsInputSchema = z
  .object({
    session_ids: z
      .array(z.string().min(1))
      .min(1)
      .max(FLEET_DELETE_BATCH_MAX)
      .describe(
        `Fleet session ids to delete (max ${FLEET_DELETE_BATCH_MAX}). Every delete is presented to the user for approval in every permission mode, including yolo. The current session can never be deleted.`,
      ),
  })
  .strict();
export type DeleteSessionsInput = z.infer<typeof DeleteSessionsInputSchema>;

export const DeleteSessionsOutputSchema = z
  .object({
    outcome: z.enum(["deleted", "rejected"]),
    reason: FleetRejectReasonSchema.optional(),
    deleted: z.array(z.string()).optional(),
    /** 删除时仍在运行、被先行停止的会话 id。 */
    stopped: z.array(z.string()).optional(),
    message: z.string(),
  })
  .strict();
export type DeleteSessionsOutput = z.infer<typeof DeleteSessionsOutputSchema>;

// ── JSON Schema 投影 ────────────────────────────────────────────────

export const StartSessionInputJsonSchema = toToolJsonSchema(StartSessionInputSchema);
export const StartSessionOutputJsonSchema = toToolJsonSchema(StartSessionOutputSchema);
export const SendToSessionInputJsonSchema = toToolJsonSchema(SendToSessionInputSchema);
export const SendToSessionOutputJsonSchema = toToolJsonSchema(SendToSessionOutputSchema);
export const ListFleetSessionsInputJsonSchema = toToolJsonSchema(ListFleetSessionsInputSchema);
export const ListSessionsOutputJsonSchema = toToolJsonSchema(ListSessionsOutputSchema);
export const HandOffToSessionInputJsonSchema = toToolJsonSchema(HandOffToSessionInputSchema);
export const HandOffToSessionOutputJsonSchema = toToolJsonSchema(HandOffToSessionOutputSchema);
export const SetSessionPermissionModeInputJsonSchema = toToolJsonSchema(
  SetSessionPermissionModeInputSchema,
);
export const SetSessionPermissionModeOutputJsonSchema = toToolJsonSchema(
  SetSessionPermissionModeOutputSchema,
);
export const ArchiveSessionInputJsonSchema = toToolJsonSchema(ArchiveSessionInputSchema);
export const ArchiveSessionOutputJsonSchema = toToolJsonSchema(ArchiveSessionOutputSchema);
export const DeleteSessionsInputJsonSchema = toToolJsonSchema(DeleteSessionsInputSchema);
export const DeleteSessionsOutputJsonSchema = toToolJsonSchema(DeleteSessionsOutputSchema);

// ── note 截断（单一事实源：core 的 watcher 与测试共用） ─────────────

/**
 * 报告 → note 的定量截断（spec R5）：前 {@link FLEET_NOTE_MAX_CHARS} 字符；
 * 截断时追加标记（标记不占 400 配额——「前 400 字符」是内容界，不是总长界）。
 * 空报告回 undefined（不产生空 note）。
 */
export function buildFleetReportNote(report: string): string | undefined {
  const text = report.trim();
  if (text.length === 0) return undefined;
  if (text.length <= FLEET_NOTE_MAX_CHARS) return text;
  return `${text.slice(0, FLEET_NOTE_MAX_CHARS)}… [truncated]`;
}
