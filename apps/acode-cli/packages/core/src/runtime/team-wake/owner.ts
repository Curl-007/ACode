// 宿主团队唤醒决策与计数 owner（apps/acode-cli/specs/host-team-wake.md R4/R7/R9）。
//
// 状态所有者纪律：世代过滤 / 消息级 ack / 唤醒上限的唯一写入点就是本类；运行态只住
// per-runtime 进程内内存（由 runtime-api 的模块私有 WeakMap 持有），不进 internal.ts
// 状态簇、不跨进程持久化（进程亡即重试链亡，杜绝重启后幽灵续跑 —— 与 auto-resume 同档）。
//
// 去重三层（R9）：插件存储层 UUID 文件名 + 未读→读原子 rename（插件侧）；宿主侧
// 世代号（EI-59）+ 消息级 ack（deliveredFactKeys，consume-on-inject）。
import {
  MAX_WAKE_EVENTS,
  type ResolvedTeamWakeConfig,
  type TeamWakeIntent,
  type TeamWakeMessageFact,
  type TeamWakeMessageKind,
  type TeamWakeSettledTaskFact,
  type TeamWakeSettledTaskStatus,
  type TeamWakeTrigger,
} from "./types.js";

/** 一次可注入的唤醒计划（owner 决策产出，injector 消费）。 */
export interface TeamWakeInjectionPlan {
  readonly teamId: string;
  readonly generation: number;
  readonly captainSessionId: string;
  readonly messages: readonly TeamWakeMessageFact[];
  readonly settledTasks: readonly TeamWakeSettledTaskFact[];
  readonly triggers: readonly TeamWakeTrigger[];
  readonly truncated: boolean;
}

export type TeamWakeSkipReason =
  | "disabled"
  | "expired"
  | "stale_generation"
  | "duplicate_pending"
  | "delivery_exhausted"
  | "empty"
  | "prompts_exhausted";

export type TeamWakeDecision =
  | { readonly kind: "enqueued"; readonly plan: TeamWakeInjectionPlan }
  | {
      readonly kind: "skipped";
      readonly reason: TeamWakeSkipReason;
      readonly teamId: string;
      readonly generation: number;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asPositiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

const MESSAGE_KINDS: ReadonlySet<string> = new Set(["report", "question", "escalation", "note"]);
const SETTLED_STATUSES: ReadonlySet<string> = new Set(["done", "failed", "blocked"]);
const TRIGGERS: ReadonlySet<string> = new Set([
  "message",
  "settled_task",
  "question",
  "escalation",
]);

function parseMessages(value: unknown): TeamWakeMessageFact[] {
  if (!Array.isArray(value)) return [];
  const facts: TeamWakeMessageFact[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const messageId = asString(item.messageId);
    const from = asString(item.from);
    const kind = asString(item.kind);
    const deliveredAt = asString(item.deliveredAt);
    if (!messageId || !from || !kind || !deliveredAt) continue;
    if (!MESSAGE_KINDS.has(kind)) continue;
    facts.push({ messageId, from, kind: kind as TeamWakeMessageKind, deliveredAt });
  }
  return facts;
}

function parseSettledTasks(value: unknown): TeamWakeSettledTaskFact[] {
  if (!Array.isArray(value)) return [];
  const facts: TeamWakeSettledTaskFact[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const taskId = asString(item.taskId);
    const owner = asString(item.owner);
    const status = asString(item.status);
    const at = asString(item.at);
    if (!taskId || !owner || !status || !at) continue;
    if (!SETTLED_STATUSES.has(status)) continue;
    facts.push({ taskId, owner, status: status as TeamWakeSettledTaskStatus, at });
  }
  return facts;
}

function parseTriggers(value: unknown): TeamWakeTrigger[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<TeamWakeTrigger>();
  for (const item of value) {
    if (typeof item === "string" && TRIGGERS.has(item)) seen.add(item as TeamWakeTrigger);
  }
  return [...seen];
}

function clampEvents<T>(facts: readonly T[]): { facts: readonly T[]; truncated: boolean } {
  return facts.length > MAX_WAKE_EVENTS
    ? { facts: facts.slice(0, MAX_WAKE_EVENTS), truncated: true }
    : { facts, truncated: false };
}

/**
 * 从插件面板快照解析待唤醒旨意（R1/R4，纯函数）。宿主只按形状收窄 wakePending 的
 * **结构化事实**（不解释成员原文）；主快照与其 `teams[]` 平铺数组各自的 wakePending
 * 都产出候选。形状不符 / 无 wakePending / 无触发事实 → 不产出（emptiness guard，R9）。
 */
export function parseTeamWakeIntents(state: unknown, receivedAtMs: number): TeamWakeIntent[] {
  if (!isRecord(state)) return [];
  const nested = Array.isArray(state.teams) ? state.teams.filter(isRecord) : [];
  const candidates: Record<string, unknown>[] = [state, ...nested];
  const intents: TeamWakeIntent[] = [];
  for (const candidate of candidates) {
    const wake = candidate.wakePending;
    if (!isRecord(wake)) continue;
    const teamId = asString(candidate.teamId);
    const generation = asPositiveInt(wake.generation);
    const captainSessionId = asString(wake.captainSessionId) ?? asString(candidate.captainSessionId);
    if (!teamId || generation === undefined || !captainSessionId) continue;
    const messages = clampEvents(parseMessages(wake.messages));
    const settledTasks = clampEvents(parseSettledTasks(wake.settledTasks));
    const triggers = parseTriggers(wake.triggers);
    // emptiness guard：无事实或触发器空 → 无事件（跨进程时序竞态由此幂等吃掉）。
    if (messages.facts.length === 0 && settledTasks.facts.length === 0) continue;
    if (triggers.length === 0) continue;
    const counts = isRecord(wake.counts)
      ? {
          unreadMessages: asPositiveInt(wake.counts.unreadMessages) ?? 0,
          unsettledMemberTasks: asPositiveInt(wake.counts.unsettledMemberTasks) ?? 0,
        }
      : { unreadMessages: 0, unsettledMemberTasks: 0 };
    intents.push({
      teamId,
      generation,
      captainSessionId,
      messages: messages.facts,
      settledTasks: settledTasks.facts,
      triggers,
      truncated: wake.truncated === true || messages.truncated || settledTasks.truncated,
      counts,
      receivedAtMs,
    });
  }
  return intents;
}

function messageFactKey(teamId: string, messageId: string): string {
  return `${teamId}\u0000m\u0000${messageId}`;
}

function settledTaskFactKey(teamId: string, taskId: string): string {
  return `${teamId}\u0000t\u0000${taskId}`;
}

function resolveTriggers(
  messages: readonly TeamWakeMessageFact[],
  settledTasks: readonly TeamWakeSettledTaskFact[],
): TeamWakeTrigger[] {
  const triggers = new Set<TeamWakeTrigger>();
  if (settledTasks.length > 0) triggers.add("settled_task");
  for (const message of messages) {
    triggers.add("message");
    if (message.kind === "question") triggers.add("question");
    if (message.kind === "escalation") triggers.add("escalation");
  }
  return [...triggers];
}

/**
 * per-runtime 唤醒 owner。所有决策/计数/ack 都收敛到这里；调用方（runtime-api /
 * injector）只经公开方法驱动，不直接触碰内部 Map。
 */
export class TeamWakeOwner {
  private readonly deliveredFactKeys = new Set<string>();
  private readonly handledGeneration = new Map<string, number>();
  private readonly pending = new Map<string, { generation: number; factKeys: readonly string[] }>();
  private readonly wakePrompts = new Map<string, number>();
  private readonly deliveryAttempts = new Map<string, number>();

  constructor(
    private readonly ports: {
      now: () => number;
      getConfig: () => ResolvedTeamWakeConfig;
    },
  ) {}

  /** 消费一条 intent：世代/去重/上限/可注入性判定后产出计划（或跳过原因）。 */
  applyIntent(intent: TeamWakeIntent): TeamWakeDecision {
    const config = this.ports.getConfig();
    const skip = (reason: TeamWakeSkipReason): TeamWakeDecision => ({
      kind: "skipped",
      reason,
      teamId: intent.teamId,
      generation: intent.generation,
    });
    if (!config.enabled) return skip("disabled");
    if (this.ports.now() - intent.receivedAtMs > config.intentTtlMs) return skip("expired");

    const handled = this.handledGeneration.get(intent.teamId) ?? -1;
    if (intent.generation < handled) return skip("stale_generation");

    const pending = this.pending.get(intent.teamId);
    if (pending) {
      // 同队已有未消费的唤醒命令：一律抑制新 intent（合并留待命令消费后的下一次通知）。
      // **不计** delivery attempt——这是「已排队」的重复确认（插件镜像双 intent、每次
      // 工具调用重发），不是 drain 失败/世代失效的重排尝试；只有真正入队才算一次尝试
      // （见下方 enqueue 路径）。否则队长忙碌期的重复通知会提前耗尽上限并丢失唤醒。
      return skip("duplicate_pending");
    }

    const overCap = (key: string): boolean =>
      (this.wakePrompts.get(key) ?? 0) >= config.maxWakePrompts;
    const messages = intent.messages.filter(
      (message) => {
        const key = messageFactKey(intent.teamId, message.messageId);
        return !this.deliveredFactKeys.has(key) && !overCap(key);
      },
    );
    const settledTasks = intent.settledTasks.filter((task) => {
      const key = settledTaskFactKey(intent.teamId, task.taskId);
      return !this.deliveredFactKeys.has(key) && !overCap(key);
    });
    if (messages.length === 0 && settledTasks.length === 0) {
      const exhausted =
        intent.messages.some((m) => overCap(messageFactKey(intent.teamId, m.messageId))) ||
        intent.settledTasks.some((t) => overCap(settledTaskFactKey(intent.teamId, t.taskId)));
      return skip(exhausted ? "prompts_exhausted" : "empty");
    }

    // delivery attempt 只在**真正入队**时递增（R7「因 drain 失败/世代失效重排」语义：
    // 命令被陈旧/丢弃后同一世代才可能再次入队）。超上限即拒绝入队。
    const attemptKey = `${intent.teamId}:${intent.generation}`;
    const attempts = (this.deliveryAttempts.get(attemptKey) ?? 0) + 1;
    if (attempts > config.maxDeliveryAttempts) return skip("delivery_exhausted");

    const factKeys = [
      ...messages.map((message) => messageFactKey(intent.teamId, message.messageId)),
      ...settledTasks.map((task) => settledTaskFactKey(intent.teamId, task.taskId)),
    ];
    for (const key of factKeys) this.wakePrompts.set(key, (this.wakePrompts.get(key) ?? 0) + 1);
    this.pending.set(intent.teamId, { generation: intent.generation, factKeys });
    this.deliveryAttempts.set(attemptKey, attempts);
    return {
      kind: "enqueued",
      plan: {
        teamId: intent.teamId,
        generation: intent.generation,
        captainSessionId: intent.captainSessionId,
        messages,
        settledTasks,
        triggers: resolveTriggers(messages, settledTasks),
        truncated: intent.truncated,
      },
    };
  }

  /**
   * 消费成功后计入 ack（consume-on-inject）：消息/任务级去重键落库、世代推进、清 pending。
   * 由 injector 在成功持久化 synthetic notice 之后调用。
   */
  completeDelivery(input: {
    teamId: string;
    generation: number;
    messageIds: readonly string[];
    settledTaskIds: readonly string[];
  }): void {
    for (const messageId of input.messageIds) {
      this.deliveredFactKeys.add(messageFactKey(input.teamId, messageId));
    }
    for (const taskId of input.settledTaskIds) {
      this.deliveredFactKeys.add(settledTaskFactKey(input.teamId, taskId));
    }
    const handled = this.handledGeneration.get(input.teamId) ?? -1;
    if (input.generation > handled) this.handledGeneration.set(input.teamId, input.generation);
    const pending = this.pending.get(input.teamId);
    if (pending && pending.generation === input.generation) this.pending.delete(input.teamId);
  }

  /** 命令因陈旧/空触发被丢弃（未注入）：清 pending 但不计 ack（下次通知可重排）。 */
  dropPending(teamId: string): void {
    this.pending.delete(teamId);
  }

  /** 成功 turn / 用户输入 admission 的重置档（R7，镜像 auto-resume）：清唤醒计数与重试档。 */
  resetChain(): void {
    this.wakePrompts.clear();
    this.deliveryAttempts.clear();
  }

  // ── 只读投影（诊断/测试） ──
  isDelivered(teamId: string, messageId: string): boolean {
    return this.deliveredFactKeys.has(messageFactKey(teamId, messageId));
  }

  wakePromptCount(teamId: string, messageId: string): number {
    return this.wakePrompts.get(messageFactKey(teamId, messageId)) ?? 0;
  }

  hasPending(teamId: string): boolean {
    return this.pending.has(teamId);
  }
}