// 宿主团队唤醒（apps/acode-cli/specs/host-team-wake.md R7）领域类型、常量与生效配置解析。
//
// 状态所有者纪律：唤醒决策与计数（世代 / ack / 上限）的唯一写入点是本目录的 owner；
// 运行态只住进程内 per-runtime 内存，不跨进程持久化——长期参数与逃生阀走 config
// （AgentTeamsHostWakeConfig），经 resolveTeamWakeConfig 落成全字段形态。
import type { AgentTeamsHostWakeConfig } from "@acode/contracts";
import { DefaultRuntimeConfig } from "@acode/contracts";

/** 同一 (teamId, messageId) 旨意最多唤醒次数；第 3 次不再注入并置 hint（R7）。 */
export const MAX_WAKE_PROMPTS = 2;
/** 同一 intent 因 drain 失败 / 世代失效重排上限（R7）。 */
export const MAX_WAKE_DELIVERY_ATTEMPTS = 3;
/** wakePending 的 messages / settledTasks 数组上限（与 UI 样本上限是不同层，R7）。 */
export const MAX_WAKE_EVENTS = 8;
/** intent 超过该时长仍未能注入 → 丢弃并置 hint，避免醒来处理化石事件（R7 / EI-11）。 */
export const WAKE_INTENT_TTL_MS = 10 * 60 * 1000;

export type TeamWakeTrigger = "message" | "settled_task" | "question" | "escalation";
export type TeamWakeMessageKind = "report" | "question" | "escalation" | "note";
export type TeamWakeSettledTaskStatus = "done" | "failed" | "blocked";

/** 插件 wakePending.messages 的结构事实（不含成员原文）。 */
export interface TeamWakeMessageFact {
  readonly messageId: string;
  readonly from: string;
  readonly kind: TeamWakeMessageKind;
  readonly deliveredAt: string;
}

/** 插件 wakePending.settledTasks 的结构事实。 */
export interface TeamWakeSettledTaskFact {
  readonly taskId: string;
  readonly owner: string;
  readonly status: TeamWakeSettledTaskStatus;
  readonly at: string;
}

/**
 * 宿主唤醒旨意：由 bootstrap 从插件状态通知的 wakePending 规范化后交给 runtime
 * （core 只接收已规范化的 intent，不订阅 MCP、不读插件状态目录 —— R4）。
 */
export interface TeamWakeIntent {
  readonly teamId: string;
  /** = 插件 TeamState.wakeSeq（单调）；旧世代由 owner 丢弃（R3 / EI-59）。 */
  readonly generation: number;
  /** 路由目标；bootstrap 据此只把 intent 交给队长会话的 runtime。 */
  readonly captainSessionId: string;
  readonly messages: readonly TeamWakeMessageFact[];
  readonly settledTasks: readonly TeamWakeSettledTaskFact[];
  readonly triggers: readonly TeamWakeTrigger[];
  /** messages/settledTasks 被 MAX_WAKE_EVENTS 截断时置位（EI-9 诚实）。 */
  readonly truncated: boolean;
  readonly counts: { readonly unreadMessages: number; readonly unsettledMemberTasks: number };
  /** 宿主接收时刻（ms epoch）；TTL 判定用。 */
  readonly receivedAtMs: number;
}

/** 宿主侧生效配置（全字段）。invalid/缺席值回落 DefaultRuntimeConfig.agentTeams.hostWake。 */
export interface ResolvedTeamWakeConfig {
  enabled: boolean;
  maxWakePrompts: number;
  maxDeliveryAttempts: number;
  intentTtlMs: number;
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function positiveInteger(value: unknown, fallback: number): number {
  return Math.max(1, Math.trunc(positiveNumber(value, fallback)));
}

/**
 * 生效配置解析（R7 默认值三级：用户显式配置 > 偏好设置 > 硬编码回落）。逃生阀
 * `enabled` 只能是用户显式配置（EI-149），不自动回退——缺省沿用硬编码 true。
 * 非法值收窄（与既有 config 解析惯例一致）：非布尔 `enabled` / 非正数上限一律回落默认，
 * 不把 `"yes"` 之类的真值当开启。
 */
export function resolveTeamWakeConfig(
  config: Partial<AgentTeamsHostWakeConfig> | undefined,
): ResolvedTeamWakeConfig {
  const defaults = DefaultRuntimeConfig.agentTeams.hostWake;
  return {
    enabled: typeof config?.enabled === "boolean" ? config.enabled : defaults.enabled,
    maxWakePrompts: positiveInteger(config?.maxWakePrompts, defaults.maxWakePrompts),
    maxDeliveryAttempts: positiveInteger(config?.maxDeliveryAttempts, defaults.maxDeliveryAttempts),
    intentTtlMs: positiveNumber(config?.intentTtlMs, defaults.intentTtlMs),
  };
}