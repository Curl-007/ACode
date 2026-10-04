type SystemReminderDeliveryChannel =
  | "request_prefix"
  | "current_turn"
  | "tool_result"
  | "history_continuity"
  | "mid_turn_event"
  | "real_user";

type SystemReminderLifecycle =
  | "request_prefix"
  | "per_current_turn"
  | "runtime_local"
  | "tool_result"
  | "resume_history"
  | "mid_turn_event"
  | "real_user";

type SystemReminderProviderVisibility = "provider_visible" | "provider_hidden";

export const SYSTEM_REMINDER_PREFIX_SOURCES = ["context_prefix", "skills_listing"] as const;

export const SYSTEM_REMINDER_PERSISTED_SOURCES = [
  "todo_reminder",
  "task_status",
  "tool_result_warning",
  "resume_referenced_session_context",
  "plan_file_reference",
  "resume_goal_state",
  "goal_state_change",
  "plugin_reference",
  "target_continuation",
  "goal_completion_verification",
  "rewind_notice",
  "conversation_fork",
  "selection_side_chat",
  "queued_system_notification",
  "shell_environment_change",
] as const;

export const SYSTEM_REMINDER_PER_REQUEST_SOURCES = [
  "incoming_message",
  "hook_context",
  "runtime_mode",
  "plan_mode_exit",
  "output_style",
  "memory_recall",
  "memory_semantic_recall",
  "date_change",
  "runtime_restart_tasks",
  "referenced_session_context",
  "model_anomaly",
  "prompt_attachment",
  "diagnostics",
] as const;

export type SystemReminderPrefixSource = (typeof SYSTEM_REMINDER_PREFIX_SOURCES)[number];
export type SystemReminderPersistedSource = (typeof SYSTEM_REMINDER_PERSISTED_SOURCES)[number];
export type SystemReminderPerRequestSource = (typeof SYSTEM_REMINDER_PER_REQUEST_SOURCES)[number];

export type SystemReminderSource =
  | SystemReminderPrefixSource
  | SystemReminderPersistedSource
  | SystemReminderPerRequestSource;

interface SystemReminderSourceDescriptor {
  source: SystemReminderSource;
  channel: SystemReminderDeliveryChannel;
  lifecycle: SystemReminderLifecycle;
  isMeta: boolean;
  providerVisibility: SystemReminderProviderVisibility;
  evidenceLabel: string;
}

type DescriptorShape = Omit<SystemReminderSourceDescriptor, "source">;

const SYSTEM_REMINDER_TAG_PATTERN = /<\/?system-reminder\b/i;
const SYSTEM_REMINDER_NESTED_TAG_PATTERN = /<\/?system-reminder\b/gi;
const SYSTEM_REMINDER_TRAILING_NEWLINE_SOURCES = new Set<SystemReminderSource>(["context_prefix"]);
const NON_MID_CONVERSATION_SYSTEM_SOURCES = new Set<SystemReminderSource>([
  "context_prefix",
  "resume_referenced_session_context",
  // Fork 和辅助对话边界必须位于新问题之前；走 MCS 会被移到问题之后，改变上下文顺序。
  "conversation_fork",
  "selection_side_chat",
  "plan_file_reference",
  "target_continuation",
  "tool_result_warning",
  "goal_completion_verification",
]);

const SYSTEM_REMINDER_DESCRIPTORS: Record<SystemReminderSource, DescriptorShape> = {
  incoming_message: descriptor("mid_turn_event", "mid_turn_event", true, "sr.incoming_message"),
  context_prefix: descriptor("request_prefix", "request_prefix", true, "sr.context_prefix"),
  skills_listing: descriptor("request_prefix", "request_prefix", true, "sr.skills_listing"),
  hook_context: descriptor("current_turn", "per_current_turn", true, "sr.hook_context"),
  runtime_mode: descriptor("current_turn", "per_current_turn", true, "sr.runtime_mode"),
  plan_mode_exit: descriptor("current_turn", "runtime_local", true, "sr.plan_mode_exit"),
  output_style: descriptor("current_turn", "per_current_turn", true, "sr.output_style"),
  // 召回记忆定性提醒（specs/reminder-extensions.md R3）：正文是静态定性文本，冷恢复按同一
  // 条件重建即可，因此走 per-request 档、不落 session；不进 persisted 名单也就不会出现在
  // contracts 枚举、v4 origin 映射与 shared 投影白名单里（R7 有断言钉住）。
  memory_recall: descriptor("current_turn", "per_current_turn", true, "sr.memory_recall"),
  // 语义召回动态注入（specs/memory-semantic-recall.md R6）：每 turn 以最新用户消息检索
  // 出的 top-K 记忆条目正文，内容逐 turn 变化。与 memory_recall 的静态定性提醒刻意
  // 分开成两种 kind：定性提醒有 5-turn 节奏配额，动态注入必须每轮独立评估、不能共享
  // 配额（否则注入会被定性提醒的节奏拖延）。同样走 per-request 档、不落 session——
  // 注入文本只对当轮模型请求有效，冷恢复后下一 turn 重新检索即可，持久化反而会把
  // 「某轮的检索结果」伪装成「会话事实」。
  memory_semantic_recall: descriptor(
    "current_turn",
    "per_current_turn",
    true,
    "sr.memory_semantic_recall",
  ),
  date_change: descriptor("current_turn", "runtime_local", true, "sr.date_change"),
  // 重启孤儿任务提醒（specs/runtime-restart-task-reminder.md R2）：正文是持久化历史的
  // 确定性派生（launch/终态记录都在 session store），冷恢复重算即可、无需逐字存活，
  // 故走 per-request 档 + runtime_local 一次性触发；不进 persisted 名单，跨包分类零改动。
  runtime_restart_tasks: descriptor(
    "current_turn",
    "runtime_local",
    true,
    "sr.runtime_restart_tasks",
  ),
  referenced_session_context: descriptor(
    "current_turn",
    "per_current_turn",
    true,
    "sr.referenced_session_context",
  ),
  // Plugin 对话引用：当轮生成后按
  // model-only synthetic notice 固化，后续只追加、不改写；冷恢复按原文重建以保持缓存前缀。
  plugin_reference: descriptor("current_turn", "per_current_turn", true, "sr.plugin_reference"),
  todo_reminder: descriptor("current_turn", "per_current_turn", true, "sr.todo_reminder"),
  task_status: descriptor("mid_turn_event", "mid_turn_event", true, "sr.task_status"),
  // 只用于 Read 等 tool result 内容内联 warning，不作为 synthetic user notice 持久化。
  tool_result_warning: descriptor("tool_result", "tool_result", true, "sr.tool_result_warning"),
  resume_referenced_session_context: descriptor(
    "history_continuity",
    "resume_history",
    true,
    "sr.resume_referenced_session_context",
  ),
  plan_file_reference: descriptor(
    "history_continuity",
    "resume_history",
    true,
    "sr.plan_file_reference",
  ),
  resume_goal_state: descriptor(
    "history_continuity",
    "resume_history",
    true,
    "sr.resume_goal_state",
  ),
  goal_state_change: descriptor("mid_turn_event", "mid_turn_event", true, "sr.goal_state_change"),
  target_continuation: descriptor("real_user", "real_user", false, "sr.target_continuation"),
  goal_completion_verification: descriptor(
    "tool_result",
    "tool_result",
    true,
    "sr.goal_completion_verification",
  ),
  model_anomaly: descriptor("mid_turn_event", "mid_turn_event", true, "sr.model_anomaly"),
  rewind_notice: descriptor("history_continuity", "resume_history", true, "sr.rewind_notice"),
  conversation_fork: descriptor(
    "history_continuity",
    "resume_history",
    true,
    "sr.conversation_fork",
  ),
  selection_side_chat: descriptor(
    "history_continuity",
    "resume_history",
    true,
    "sr.selection_side_chat",
  ),
  prompt_attachment: descriptor("current_turn", "per_current_turn", true, "sr.prompt_attachment"),
  queued_system_notification: descriptor(
    "mid_turn_event",
    "mid_turn_event",
    true,
    "sr.queued_system_notification",
  ),
  shell_environment_change: descriptor(
    "mid_turn_event",
    "mid_turn_event",
    true,
    "sr.shell_environment_change",
  ),
  diagnostics: descriptor("mid_turn_event", "mid_turn_event", true, "sr.diagnostics"),
};

export const SYSTEM_REMINDER_SOURCES = Object.freeze([
  ...SYSTEM_REMINDER_PREFIX_SOURCES,
  ...SYSTEM_REMINDER_PERSISTED_SOURCES,
  ...SYSTEM_REMINDER_PER_REQUEST_SOURCES,
]);

const MID_CONVERSATION_SYSTEM_SOURCES = new Set<SystemReminderSource>(
  SYSTEM_REMINDER_SOURCES.filter((source) => !NON_MID_CONVERSATION_SYSTEM_SOURCES.has(source)),
);

export function getSystemReminderDescriptor(
  source: SystemReminderSource,
): SystemReminderSourceDescriptor {
  const descriptor = SYSTEM_REMINDER_DESCRIPTORS[source];
  return {
    source,
    ...descriptor,
  };
}

export function isMidConversationSystemSource(source: SystemReminderSource): boolean {
  return MID_CONVERSATION_SYSTEM_SOURCES.has(source);
}

export function wrapSystemReminderForSource(
  source: SystemReminderSource,
  body: string | readonly string[],
): string {
  const sourceDescriptor = getSystemReminderDescriptor(source);
  if (sourceDescriptor.providerVisibility !== "provider_visible") {
    throw new Error(`System reminder source ${source} is not provider-visible`);
  }
  const wrapped = wrapSystemReminder(sanitizeSystemReminderBody(body));

  return SYSTEM_REMINDER_TRAILING_NEWLINE_SOURCES.has(source) ? `${wrapped}\n` : wrapped;
}

export function wrapSystemReminder(body: string | readonly string[]): string {
  const content = typeof body === "string" ? body : body.join("\n");
  if (content.length === 0) {
    throw new Error("System reminder body cannot be empty");
  }
  if (SYSTEM_REMINDER_TAG_PATTERN.test(content)) {
    throw new Error("System reminder body must not include nested system-reminder tags");
  }
  return ["<system-reminder>", content, "</system-reminder>"].join("\n");
}

export function sanitizeSystemReminderBody(body: string | readonly string[]): string {
  return escapeNestedSystemReminderTags(body);
}

function descriptor(
  channel: SystemReminderDeliveryChannel,
  lifecycle: SystemReminderLifecycle,
  isMeta: boolean,
  evidenceLabel: string,
): DescriptorShape {
  return {
    channel,
    lifecycle,
    isMeta,
    providerVisibility: "provider_visible",
    evidenceLabel,
  };
}

function escapeNestedSystemReminderTags(body: string | readonly string[]): string {
  const content = typeof body === "string" ? body : body.join("\n");
  // 与 wrapper 的拒绝规则一致，含空格/大小写变体的关闭标签也只中和起始 <。
  return content.replace(SYSTEM_REMINDER_NESTED_TAG_PATTERN, (tag) => `&lt;${tag.slice(1)}`);
}
