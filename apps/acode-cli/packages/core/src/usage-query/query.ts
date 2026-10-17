// /usage 取数层：只组合既有查询（UsageStorePort.queryAppUsage/queryTaskUsage +
// SessionStorePort.listSessions），不新增存储面。
//
// 口径裁决（spec「数据口径」「/usage 命令族」节）：
// - 会话累计 totalTokens 沿用 queryTaskUsage 的 producer 事实（与 v4/conversation/usage
//   通道同源；其 input 已按 baseline 去重跨请求的重复上下文），渲染层不再重算。
// - workspace:/session:/sessions 的父子合并：SessionInfo.parentID 是 port 面既有事实，
//   在模块内建森林合并子代理消耗——匹配到祖先的后代不单独成行，避免重复计算。
// - current 的「最近 30 分钟内有请求」用既有查询组合逼近：time.updated 落在窗口内
//   （消息/分片持久化会 touch 会话行，模型请求完成必然伴随 assistant 消息持久化）
//   且 queryTaskUsage.modelRequestCount > 0（排除只有非模型活动的会话）。port 面没有
//   按请求时间戳的枚举查询，这是既有形状下的最近实现（见 spec「用既有查询组合实现」）。
import type { SessionId, SessionInfo } from "@acode/contracts";
import { CURRENT_WINDOW_MINUTES } from "./parse.js";
import type {
  UsageQueryDeps,
  UsageQueryReport,
  UsageQueryScope,
  UsageQueryWindow,
  UsageSessionEntry,
  UsageTokenTotals,
} from "./types.js";
import { USAGE_QUERY_DAY_MS } from "./types.js";

export async function runUsageQuery(
  deps: UsageQueryDeps,
  scope: UsageQueryScope,
): Promise<UsageQueryReport> {
  const now = deps.now ?? Date.now();
  switch (scope.kind) {
    case "range": {
      const window = buildWindow(now, deps.tzOffsetMs, scope.days);
      const result = await deps.usageStore.queryAppUsage({
        since: window.since,
        until: window.until,
        tzOffsetMs: window.tzOffsetMs,
      });
      return { kind: "range", range: scope.range, window, result };
    }
    case "models": {
      const window = buildWindow(now, deps.tzOffsetMs, scope.days);
      const result = await deps.usageStore.queryAppUsage({
        since: window.since,
        until: window.until,
        tzOffsetMs: window.tzOffsetMs,
      });
      return { kind: "models", window, result };
    }
    case "sessions":
      return runSessionsScope(deps, scope.limit);
    case "workspace":
      return runMatchedSessionsScope(deps, {
        kind: "workspace",
        keyword: scope.keyword,
        // workspace 关键词匹配身份字段（目录/路径/workspace 标识），大小写不敏感；
        // 不匹配 title——标题是会话内容，不是 workspace 事实。
        matches: (session) =>
          containsIgnoreCase(session.directory, scope.keyword) ||
          containsIgnoreCase(session.path ?? "", scope.keyword) ||
          containsIgnoreCase(session.workspaceID ?? "", scope.keyword),
        // 子会话即使没命中关键词也并入命中的祖先（同属一个任务的消耗）。
        mergeWholeSubtree: true,
      });
    case "session":
      return runMatchedSessionsScope(deps, {
        kind: "session",
        prefix: scope.prefix,
        matches: (session) =>
          session.id.toLowerCase().startsWith(scope.prefix.trim().toLowerCase()),
        mergeWholeSubtree: true,
      });
    case "current": {
      const windowStart = now - CURRENT_WINDOW_MINUTES * 60_000;
      return runMatchedSessionsScope(deps, {
        kind: "current",
        windowStart,
        matches: (session) => session.time.updated >= windowStart,
        // current 只累计窗口内活跃的会话：窗口外结束的子代理消耗不计入 30 分钟口径。
        mergeWholeSubtree: false,
        requireModelRequests: true,
      });
    }
  }
}

export function buildWindow(now: number, tzOffsetMs: number, dayCount: number): UsageQueryWindow {
  return {
    since: localDayStartMs(now, tzOffsetMs, dayCount - 1),
    until: now,
    tzOffsetMs,
    dayCount,
  };
}

/** 距今 daysBack 个本地日的那一天的本地零点（unix ms）。dayIndex 口径与 adapters 一致。 */
export function localDayStartMs(now: number, tzOffsetMs: number, daysBack: number): number {
  const dayIndex = Math.floor((now + tzOffsetMs) / USAGE_QUERY_DAY_MS);
  return (dayIndex - daysBack) * USAGE_QUERY_DAY_MS - tzOffsetMs;
}

// ── 会话森林与合并 ─────────────────────────────────────────────

interface SessionForest {
  byId: Map<string, SessionInfo>;
  childrenOf: Map<string, SessionInfo[]>;
  /** parentID 缺失或父行不在结果集的会话（孤行按根处理，不漏报）。 */
  roots: SessionInfo[];
}

function buildForest(sessions: readonly SessionInfo[]): SessionForest {
  const byId = new Map<string, SessionInfo>();
  for (const session of sessions) byId.set(session.id, session);
  const childrenOf = new Map<string, SessionInfo[]>();
  const roots: SessionInfo[] = [];
  for (const session of sessions) {
    const parentId = session.parentID;
    if (parentId && byId.has(parentId) && parentId !== session.id) {
      const siblings = childrenOf.get(parentId);
      if (siblings) siblings.push(session);
      else childrenOf.set(parentId, [session]);
    } else {
      roots.push(session);
    }
  }
  return { byId, childrenOf, roots };
}

function collectSubtreeIds(forest: SessionForest, root: SessionInfo, wholeSubtree: boolean, matchedIds?: ReadonlySet<string>): SessionId[] {
  const ids: SessionId[] = [root.id];
  const visited = new Set<string>([root.id]);
  const queue: SessionInfo[] = [root];
  while (queue.length > 0) {
    const current = queue.shift() as SessionInfo;
    for (const child of forest.childrenOf.get(current.id) ?? []) {
      if (visited.has(child.id)) continue;
      visited.add(child.id);
      if (wholeSubtree || (matchedIds?.has(child.id) ?? false)) {
        ids.push(child.id);
        queue.push(child);
      }
    }
  }
  return ids;
}

/** 匹配集中存在祖先的成员不单独成行（其消耗由最上层匹配祖先合并承载）。 */
function effectiveMatchRoots(forest: SessionForest, matched: readonly SessionInfo[]): SessionInfo[] {
  const matchedIds = new Set(matched.map((session) => session.id));
  return matched.filter((session) => {
    const seen = new Set<string>([session.id]);
    let parentId = session.parentID;
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId);
      if (matchedIds.has(parentId)) return false;
      parentId = forest.byId.get(parentId)?.parentID;
    }
    return true;
  });
}

async function sumTaskUsage(
  deps: UsageQueryDeps,
  sessionIds: readonly SessionId[],
): Promise<UsageTokenTotals> {
  const totals: UsageTokenTotals = {
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    modelRequestCount: 0,
    modelErrorCount: 0,
  };
  for (const sessionID of sessionIds) {
    const usage = await deps.usageStore.queryTaskUsage({ sessionID });
    totals.totalTokens += usage.totalTokens;
    totals.inputTokens += usage.inputTokens;
    totals.outputTokens += usage.outputTokens;
    totals.reasoningTokens += usage.reasoningTokens;
    totals.cacheCreationTokens += usage.cacheCreationTokens;
    totals.cacheReadTokens += usage.cacheReadTokens;
    totals.modelRequestCount += usage.modelRequestCount;
    totals.modelErrorCount += usage.modelErrorCount;
  }
  return totals;
}

async function runSessionsScope(deps: UsageQueryDeps, limit: number): Promise<UsageQueryReport> {
  const sessions = await deps.listSessions({ includeArchived: true });
  const forest = buildForest(sessions);
  // 不依赖 listSessions 的排序契约：本地按 time.updated 重排后取最近 limit 个根会话。
  const roots = [...forest.roots].sort((a, b) => b.time.updated - a.time.updated).slice(0, limit);
  const entries: UsageSessionEntry[] = [];
  for (const root of roots) {
    const subtreeIds = collectSubtreeIds(forest, root, true);
    entries.push({
      session: root,
      mergedChildIds: subtreeIds.filter((id) => id !== root.id),
      usage: await sumTaskUsage(deps, subtreeIds),
    });
  }
  return { kind: "sessions", limit, tzOffsetMs: deps.tzOffsetMs, entries };
}

interface MatchedScopeInput {
  kind: "workspace" | "session" | "current";
  keyword?: string;
  prefix?: string;
  windowStart?: number;
  matches(session: SessionInfo): boolean;
  mergeWholeSubtree: boolean;
  requireModelRequests?: boolean;
}

async function runMatchedSessionsScope(
  deps: UsageQueryDeps,
  input: MatchedScopeInput,
): Promise<UsageQueryReport> {
  const sessions = await deps.listSessions({ includeArchived: true });
  const forest = buildForest(sessions);
  const matched = sessions.filter((session) => input.matches(session));
  const matchedIds = new Set(matched.map((session) => session.id));
  const roots = effectiveMatchRoots(forest, matched);
  const entries: UsageSessionEntry[] = [];
  for (const root of roots) {
    const subtreeIds = collectSubtreeIds(forest, root, input.mergeWholeSubtree, matchedIds);
    const usage = await sumTaskUsage(deps, subtreeIds);
    if (input.requireModelRequests && usage.modelRequestCount <= 0) continue;
    entries.push({
      session: root,
      mergedChildIds: subtreeIds.filter((id) => id !== root.id),
      usage,
    });
  }
  entries.sort((a, b) => b.session.time.updated - a.session.time.updated);
  const tzOffsetMs = deps.tzOffsetMs;
  if (input.kind === "workspace") {
    return { kind: "workspace", keyword: input.keyword ?? "", tzOffsetMs, entries };
  }
  if (input.kind === "session") {
    return { kind: "session", prefix: input.prefix ?? "", tzOffsetMs, entries };
  }
  return {
    kind: "current",
    windowMinutes: CURRENT_WINDOW_MINUTES,
    windowStart: input.windowStart ?? 0,
    tzOffsetMs,
    entries,
  };
}

function containsIgnoreCase(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}
