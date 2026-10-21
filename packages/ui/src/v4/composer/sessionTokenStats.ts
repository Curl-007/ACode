import { ESTIMATED_TOKEN_CHAR_DIVISOR } from "@acode/shared";
import type {
  ConversationSnapshot,
  SessionPhase,
  SessionUsageState,
} from "@acode/shared/acode-protocol-v4";

type SessionCumulative = SessionUsageState["cumulative"];
type ConversationRows = ConversationSnapshot["rows"]["window"];

export function collectChildSessionIds(
  snapshot: ConversationSnapshot | null,
  parentSessionId: string,
): string[] {
  if (!snapshot) return [];
  const ids = new Set<string>();
  for (const id of snapshot.subagents?.childSessionIds ?? []) {
    if (id && id !== parentSessionId) ids.add(id);
  }
  for (const run of snapshot.workflowRuns?.runs ?? []) {
    for (const actor of run.actors) {
      if (!actor.sessionId || actor.sessionId === parentSessionId) continue;
      // 仅排除 queued：actor 创建时可能还没有会话，提前订阅会将错误 store 留在 keep-warm。
      if (
        run.nodes.some(
          (node) =>
            node.actorSiteId === actor.siteId &&
            node.actorOrdinal === actor.ordinal &&
            node.phase !== "queued",
        )
      ) {
        ids.add(actor.sessionId);
      }
    }
  }
  return [...ids];
}

/** 状态栏同时实时订阅的子会话上限：每个订阅都是整条子会话投影常驻 renderer。 */
const MAX_LIVE_CHILD_SESSION_SUBSCRIPTIONS = 6;

/**
 * 需要实时订阅的子会话：只取正在运行的子代理与执行中的 workflow actor，并截断到上限。
 * 不能对 childSessionIds（含全部已结束子会话）逐个订阅整条会话投影，否则子代理多时
 * 一打开会话就并发几十条订阅、每个流式帧全量重算，renderer 主线程被打满。
 */
export function collectLiveChildSessionIds(
  snapshot: ConversationSnapshot | null,
  parentSessionId: string,
): string[] {
  if (!snapshot) return [];
  const ids = new Set<string>();
  for (const item of snapshot.subagents?.running ?? []) {
    if (item.childSessionId && item.childSessionId !== parentSessionId) {
      ids.add(item.childSessionId);
    }
  }
  for (const run of snapshot.workflowRuns?.runs ?? []) {
    for (const actor of run.actors) {
      if (!actor.sessionId || actor.sessionId === parentSessionId) continue;
      if (
        run.nodes.some(
          (node) =>
            node.actorSiteId === actor.siteId &&
            node.actorOrdinal === actor.ordinal &&
            node.phase !== "queued" &&
            node.phase !== "settled",
        )
      ) {
        ids.add(actor.sessionId);
      }
    }
  }
  return [...ids].slice(0, MAX_LIVE_CHILD_SESSION_SUBSCRIPTIONS);
}

export function readChildSessionTokenTotal(child: ConversationSnapshot): number | null {
  // 目标协议没有 usage.inFlight（spec §12.3）：直接读落账后的累计值。
  return readSettledSessionTokenTotal(child);
}

function readSettledSessionTokenTotal(child: ConversationSnapshot): number | null {
  const total = readSessionTokenTotal(
    child.usage.cumulative,
    child.usage.contextWindow?.usedTokens ?? 0,
  );
  // 旧运行时会输出完成回答却丢弃 child ModelComplete；不能将缺失账单显示为 0。
  if (
    total === 0 &&
    child.rows.window.some(
      (row) =>
        (row.kind === "assistantText" || row.kind === "reasoning") &&
        row.state === "complete" &&
        row.text.trim().length > 0,
    )
  ) {
    return null;
  }
  return total;
}

interface StreamingOutputSample {
  responseId: string;
  estimatedTokens: number;
}

interface LiveOutputObservation {
  sessionId: string;
  sample: StreamingOutputSample;
}

export interface LiveOutputTracker {
  responseId: string;
  samples: readonly { at: number; tokens: number }[];
}

const LIVE_OUTPUT_RATE_WINDOW_MS = 2_500;
const LIVE_OUTPUT_RATE_STALE_MS = 1_500;
const MIN_SPAN_MS = 200;

export function readSessionTokenTotal(
  cumulative: SessionCumulative | null,
  contextUsedTokens = 0,
): number | null {
  if (
    !cumulative ||
    !Number.isFinite(cumulative.inputTokens) ||
    !Number.isFinite(cumulative.outputTokens) ||
    cumulative.inputTokens < 0 ||
    cumulative.outputTokens < 0
  ) {
    return null;
  }
  const total = cumulative.inputTokens + cumulative.outputTokens;
  // 旧冷会话可以恢复上下文水位，却没有历史用量分项；此时 0 不是会话总量。
  return total === 0 && contextUsedTokens > 0 ? null : total;
}

export function isLiveOutputPhase(phase: SessionPhase): boolean {
  return phase === "prewarming" || phase === "running";
}

export function readLiveOutputObservation(
  snapshot: ConversationSnapshot | null | undefined,
): LiveOutputObservation | null {
  if (!snapshot || !isLiveOutputPhase(snapshot.control.phase)) return null;
  const sample = readStreamingOutputSample(snapshot.rows.window);
  return sample ? { sessionId: snapshot.sessionId, sample } : null;
}

export function readStreamingOutputSample(rows: ConversationRows): StreamingOutputSample | null {
  let latest: ConversationRows[number] | undefined;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row?.kind === "toolCall" || row?.kind === "turnHeader" || row?.kind === "userInput")
      return null;
    if (row?.kind === "assistantText" || row?.kind === "reasoning") {
      latest = row;
      break;
    }
  }
  if (
    !latest ||
    (latest.kind !== "assistantText" && latest.kind !== "reasoning") ||
    latest.state !== "streaming"
  )
    return null;

  const responseId = latest.assistantResponseId ?? `row:${latest.rowId}`;
  let weightedChars = 0;
  for (const row of rows) {
    if (row.kind !== "assistantText" && row.kind !== "reasoning") continue;
    if (
      latest.assistantResponseId
        ? row.assistantResponseId !== latest.assistantResponseId
        : row !== latest
    )
      continue;
    // 每个流式帧、每个订阅都会走到这里：逐字计数，不用 match 为整段文本分配匹配数组。
    let chineseChars = 0;
    for (let index = 0; index < row.text.length; index += 1) {
      const code = row.text.charCodeAt(index);
      if (code >= 0x4e00 && code <= 0x9fff) chineseChars += 1;
    }
    weightedChars += row.text.length + chineseChars;
  }
  return { responseId, estimatedTokens: Math.ceil(weightedChars / ESTIMATED_TOKEN_CHAR_DIVISOR) };
}

export function recordStreamingOutputSample(
  tracker: LiveOutputTracker | null,
  sample: StreamingOutputSample,
  at: number,
): LiveOutputTracker {
  if (!Number.isFinite(at) || !Number.isFinite(sample.estimatedTokens))
    return tracker ?? { responseId: sample.responseId, samples: [] };
  const previous = tracker?.samples.at(-1);
  if (
    !tracker ||
    tracker.responseId !== sample.responseId ||
    (previous && (sample.estimatedTokens < previous.tokens || at < previous.at))
  ) {
    return { responseId: sample.responseId, samples: [{ at, tokens: sample.estimatedTokens }] };
  }
  if (previous?.tokens === sample.estimatedTokens) return tracker;

  const samples = [...tracker.samples, { at, tokens: sample.estimatedTokens }];
  // 留下窗口边界前的一个样本作为基线，避免定时器刷新时把速度误算成 0。
  const firstInWindow = samples.findIndex((entry) => entry.at >= at - LIVE_OUTPUT_RATE_WINDOW_MS);
  return { responseId: sample.responseId, samples: samples.slice(Math.max(0, firstInWindow - 1)) };
}

export function readStreamingOutputRate(
  tracker: LiveOutputTracker | null,
  now: number,
): number | null {
  if (!tracker || !Number.isFinite(now)) return null;
  const last = tracker.samples.at(-1);
  if (!last || now - last.at > LIVE_OUTPUT_RATE_STALE_MS) return null;
  const first =
    tracker.samples.find((entry) => entry.at >= now - LIVE_OUTPUT_RATE_WINDOW_MS) ??
    tracker.samples.at(-2);
  if (!first || last === first || last.at - first.at < MIN_SPAN_MS) return null;
  const rate = ((last.tokens - first.tokens) * 1000) / (last.at - first.at);
  return Number.isFinite(rate) && rate > 0 ? Math.round(rate) : null;
}

export function retainObservedOutputRate(
  previous: number | null,
  measured: number | null,
): number | null {
  return measured !== null && measured > 0 ? measured : previous;
}
