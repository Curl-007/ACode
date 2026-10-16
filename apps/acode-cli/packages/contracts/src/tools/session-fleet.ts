// ============================================================
// Session Fleet Tools - agent 可管理的并行会话工具族契约
// ============================================================
// 七个工具面（apps/acode-cli/specs/session-fleet.md R1-R8）：StartSession（启动
// 用户可见后台舰队会话，返回 session_id 确立所有权）/ SendToSession（session_id
// 寻址跟进路由，非显示名）/ ListSessions（只列自身行 + 本会话所有的舰队行）/
// HandOffToSession（任务移交，目标每收口一回合记最新报告前 400 字符 note）/
// SetSessionPermissionMode（降权/平调直通，升权必过用户，无人值守拒绝）/
// ArchiveSession（在跑拒绝而非强制、worktree/已完成 side 会话级联、支持 self）/
// DeleteSessions（批量 ≤25、全模式过用户审批、绝不删本会话）。
//
// 拒绝是**普通工具结果**而非错误（对齐 escalate / session-worktree 的裁决）：模型
// 需要读到闭集 reason 改道，而不是把可预期的边界当成可重试的故障反复撞墙。
//
// 批 2（spec R11-R15）：initiation 三值闭集（offer 阻塞卡 / user_asked 立即启动 /
// own_initiative 提案卡）、proposal 面、background 上下文契约（≥80 字符）、会话短名。

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

export const START_SESSION_TOOL_NAME = "StartSession";
export const SEND_TO_SESSION_TOOL_NAME = "SendToSession";
export const LIST_SESSIONS_TOOL_NAME = "ListSessions";
export const HAND_OFF_TO_SESSION_TOOL_NAME = "HandOffToSession";
export const SET_SESSION_PERMISSION_MODE_TOOL_NAME = "SetSessionPermissionMode";
export const ARCHIVE_SESSION_TOOL_NAME = "ArchiveSession";
export const DELETE_SESSIONS_TOOL_NAME = "DeleteSessions";

/** 定量界（spec R5/R7/R8 + 批 2 R13）：note 截断 400 / 删除单批 25 / 标题 120 / background 最短 80（结构强制，不替代 prompt）；self = ArchiveSession 自指别名。 */
export const FLEET_NOTE_MAX_CHARS = 400;
export const FLEET_DELETE_BATCH_MAX = 25;
export const FLEET_TITLE_MAX_CHARS = 120;
export const FLEET_SELF_SESSION_ALIAS = "self";
export const FLEET_BACKGROUND_MIN_CHARS = 80;

/** 舰队可请求模式闭集（CollaborationMode 去 auto；严苛度序单一事实源在 core 的 nesting-policy）。 */
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

/** 拒绝理由闭集（spec R2-R8；批 2 增 proposal/start_needs_brief 五值，R11）。 */
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
  // 批 2 R11 五值：start_needs_brief = 既无 proposal_id 也缺 title/prompt；
  // proposal_budget_exceeded = 超每回合预算（≤3）；proposal_duplicate = 同一事项
  // 重复提案（归一 title 判重）；proposal_expired = 提案过期（一周）；
  // proposal_unknown = proposal_id 无记录或非本会话所有。
  "start_needs_brief",
  "proposal_budget_exceeded",
  "proposal_duplicate",
  "proposal_expired",
  "proposal_unknown",
]);
export type FleetRejectReason = z.infer<typeof FleetRejectReasonSchema>;

/** 批 2 R11：initiation 三值闭集——offer = 用户最新消息点名的任务（唯一会等待的调用 = 阻塞式确认卡）；user_asked = 用户用词要求分开/并行/后台（立即启动）；own_initiative = 自己提案（不启动，产 proposal 卡）。 */
export const FleetInitiationSchema = z.enum(["offer", "user_asked", "own_initiative"]);
export type FleetInitiation = z.infer<typeof FleetInitiationSchema>;

// ── StartSession ────────────────────────────────────────────────────

export const StartSessionInputSchema = z
  .object({
    title: z
      .string()
      .min(1)
      .max(FLEET_TITLE_MAX_CHARS)
      .optional()
      .describe(
        "Short human-readable session title shown in the session list. Required unless proposal_id is given.",
      ),
    prompt: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Self-contained task brief: name the files/area it touches and what done looks like, in your own words. The new session has no other context. Required unless proposal_id is given.",
      ),
    initiation: FleetInitiationSchema.optional().describe(
      "Whose task this is: 'offer' = a task the user named in their latest message (the call waits for the user's New session / Do it here decision); 'user_asked' = the user asked in words for separate, parallel or background work (starts now); 'own_initiative' = work you propose yourself (registers a proposal card instead of starting anything). A task the user's message tells you to do is never own_initiative. Omit only for a plain user-asked start.",
    ),
    proposal_id: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Start a proposal YOU registered earlier with own_initiative, after the user gave the go-ahead (a click or words). The proposal carries its own title/prompt; this consumes it.",
      ),
    background: z
      .string()
      .min(FLEET_BACKGROUND_MIN_CHARS)
      .max(4000)
      .optional()
      .describe(
        "Context for a fresh session, at least 80 characters: the overall goal, decisions and constraints so far, and how this piece fits. Complements prompt; never replaces it.",
      ),
    permission_mode: FleetPermissionModeSchema.optional().describe(
      "Permission mode for the new session. It can never be higher than your current mode (tighten-only). 'plan' launches a read-only planning session; omit to inherit your current mode.",
    ),
    use_worktree: z
      .boolean()
      .optional()
      .describe(
        "true = isolate the session in a fresh git worktree cut from the current HEAD (uncommitted changes are NOT carried over). Default false = run in the current working directory with no overwrite protection: when its edits may overlap yours or another session's, pass true.",
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
    outcome: z.enum(["started", "proposed", "rejected"]),
    reason: FleetRejectReasonSchema.optional(),
    /** 所有权凭据：后续舰队工具只认这个 id（spec R3）。 */
    session_id: z.string().optional(),
    /** runtime-task id（≡ agentId）：既有 TaskOutput / TaskStop 观测与停止面。 */
    task_id: z.string().optional(),
    /** 批 2 R14 会话短名（显示键，寻址仍只认 id）；R11 提案 id 与过期时刻（一周）。 */
    name: z.string().optional(),
    proposal_id: z.string().optional(),
    proposal_expires_at: z.string().optional(),
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
// 输入类型刻意命名为 ListFleetSessions*：`ListSessionsInput` 已被存储面占用（barrel 同名冲突）。

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
    /** self = 调用方自身行；fleet = 调用方启动的舰队会话。name = 批 2 R14 短名（显示键）。 */
    kind: z.enum(["self", "fleet"]),
    name: z.string().optional(),
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
    background: z
      .string()
      .min(FLEET_BACKGROUND_MIN_CHARS)
      .max(4000)
      .optional()
      .describe(
        "Context for a NEW session (ignored with session_id), at least 80 characters: overall goal, decisions and constraints so far, how the piece fits.",
      ),
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
    /** 生效边界（spec R4 诚实语义）：`next_turn_boundary` = plan 系会话下一次 resume 起绑定；`cold_restore` = 天花板系会话绑定冷恢复面（热 resume 按既有继承裁决重锚，结构天花板独立兜底）。 */
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

/** 报告 → note 定量截断（spec R5）：前 {@link FLEET_NOTE_MAX_CHARS} 字符；截断追加标记（标记不占 400 配额）；空报告回 undefined（不产生空 note）。 */
export function buildFleetReportNote(report: string): string | undefined {
  const text = report.trim();
  if (text.length === 0) return undefined;
  if (text.length <= FLEET_NOTE_MAX_CHARS) return text;
  return `${text.slice(0, FLEET_NOTE_MAX_CHARS)}… [truncated]`;
}
