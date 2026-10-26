// U07 目录索引与窗口外跳转的裁决逻辑（specs/conversation-index-navigation.md）。
//
// 本模块只放纯函数：不做 IO、不碰 DOM、不持有状态，因此可脱 jsdom 直接单测
// （与 lib/localDiagnosticReport.ts 同一模式）。唯一写入方仍是
// conversationProjectionStore（经 conversationIndexFocusController 组合）。
//
// 预算常量与字节估算由调用方注入（store 传入 PROJECTION_WINDOW_MAX_ROWS /
// PROJECTION_WINDOW_MAX_BYTES / estimateRowBytes），避免与 store 形成 import 环。
// PROTOCOL_V4_LIMITS 来自 shared 协议包（非 store），可直接引用：rowsRange 单请求
// ≤200 行是协议硬约束，必须由本模块自身保证，不依赖调用方传对值。
import { PROTOCOL_V4_LIMITS } from "@acode/shared/acode-protocol-v4";
import type { TurnIndexEntry } from "@/v4/conversationTurnIndex.js";

/** 单次跳转的正文请求上限（spec 规则 3 / 量化门槛：≤3）。 */
export const INDEX_FOCUS_MAX_REQUESTS_PER_JUMP = 3;

// 共享信封预算裁决（尾部下限、行数/字节分配、焦点侧裁剪、运行中 turn 计数）拆到
// conversationIndexFocusBudget.ts，使两模块都在 400 行以内。按原名再导出，
// 保持既有 import 面（控制器 / 测试）逐字不变。
export {
  INDEX_FOCUS_TAIL_FLOOR_ROWS,
  resolveIndexFocusBudget,
  trimIndexFocusRows,
  resolveRunningTurnRowCount,
  type IndexFocusBudget,
  type IndexFocusBudgetInput,
} from "@/v4/conversationIndexFocusBudget.js";
import {
  resolveIndexFocusBudget,
  resolveRunningTurnRowCount,
  trimIndexFocusRows,
} from "@/v4/conversationIndexFocusBudget.js";

// ── 定向单页定位 ──

export interface IndexFocusPage {
  beforeRowId: number;
  limit: number;
}

/**
 * 单请求 limit 夹到 [1, rowsRangeMaxLimit]（spec 量化门槛：单请求 ≤200 行）。
 *
 * 上限直接取协议常量 PROTOCOL_V4_LIMITS.rowsRangeMaxLimit，而不是信任调用方传入的
 * 值——这样「≤200」这条硬约束由纯函数本身保证，任何越界入参（含调用方误传）都被夹回。
 * 非有限值 / <1 回落到最小合法值 1。
 */
export function clampRowsRangeLimit(requested: number): number {
  const cap = PROTOCOL_V4_LIMITS.rowsRangeMaxLimit;
  const normalized = Number.isFinite(requested) && requested >= 1 ? requested : 1;
  return Math.min(normalized, cap);
}

/**
 * 定向单页：`beforeRowId = 目标 rowId + 1`（spec 规则 2）。
 *
 * 服务端 getRowsRange 取 `rowId < beforeRowId` 的行后 `slice(-limit)`，所以目标行必为
 * 返回页最后一行——一次请求即可命中，不需要「先定位页、再在页内找行」的多次往返。
 * limit 由 rowsRangeMaxLimit(200) 夹住，满足单请求 ≤200 行的硬约束。
 */
export function planIndexFocusPage(targetRowId: number, maxLimit: number): IndexFocusPage {
  return { beforeRowId: targetRowId + 1, limit: clampRowsRangeLimit(maxLimit) };
}

export type IndexFocusNextAction = "none" | "continue-older" | "range-exhausted";

/**
 * 超范围必须显式动作（spec 规则 3）：≤3 个请求内未命中目标时，
 * 只把「继续加载更早」交给用户点击，绝不后台遍历全部历史。
 */
export function resolveIndexFocusNextAction(input: {
  requestsUsed: number;
  targetFound: boolean;
  hasMore: boolean;
}): IndexFocusNextAction {
  if (input.targetFound) return "none";
  // 服务端 eligible 已到头：目标确实不在当前分支，收敛为 target-missing，不重试。
  if (!input.hasMore) return "none";
  return input.requestsUsed >= INDEX_FOCUS_MAX_REQUESTS_PER_JUMP
    ? "range-exhausted"
    : "continue-older";
}

/**
 * 焦点提交的完整裁决（spec「窗口语义裁决」步骤 1-3 + 不变量 1/3）。
 *
 * 把「合并页行 → 共享信封分配 → 焦点侧裁剪」串成一个纯函数，使整条预算账目可脱 jsdom
 * 断言（spec 量化门槛：预算断言涵盖焦点、尾部与临时 page buffer 的**总和**）。
 *
 * 返回值里 `tailRetainRows` 只在 `tailTrimmed` 为真时需要落地——控制器据此决定是否
 * 调用 store 的裁尾写入，纯函数本身不产生副作用。
 */
export function resolveIndexFocusCommit<T extends { rowId: number }>(params: {
  merged: readonly T[];
  tailFirstRowId: number | null;
  tailRowCount: number;
  tailRetainBytes: (retainRows: number) => number;
  runningTurnRowCount: number;
  maxRows: number;
  maxBytes: number;
  byteOf: (row: T) => number;
}): { rows: T[]; focusBytes: number; tailRetainRows: number; tailTrimmed: boolean } {
  const ascending = resolveIndexFocusRows(params.merged, params.tailFirstRowId);
  const budget = resolveIndexFocusBudget({
    tailRowCount: params.tailRowCount,
    tailRetainBytesProvider: params.tailRetainBytes,
    focusRowCount: 0,
    incomingRowCount: ascending.length,
    runningTurnRowCount: params.runningTurnRowCount,
    maxRows: params.maxRows,
    maxBytes: params.maxBytes,
  });
  const trimmed = trimIndexFocusRows(
    ascending,
    { maxRows: budget.focusRowCapacity, maxBytes: budget.focusByteCapacity },
    params.byteOf,
  );
  return {
    rows: trimmed.rows,
    focusBytes: trimmed.bytes,
    tailRetainRows: budget.tailRetainRows,
    tailTrimmed: budget.tailTrimmed,
  };
}

/** 终态裁决结果：status/nextAction/targetFound 用于 setState，code 用于返回值。 */
export interface IndexFocusOutcome {
  status: "no-budget" | "target-missing" | "range-exhausted" | "focused";
  nextAction: IndexFocusNextAction;
  targetFound: boolean;
  code: "ok" | "no-budget" | "target-missing" | "range-exhausted";
}

/**
 * 一次定位页返回后的终态裁决（纯决策表，spec「接口」的封闭状态枚举）。
 *
 * 抽成纯函数的理由：这是用户可见状态的唯一裁决点，且分支互有优先级——
 * `no-budget` 必须先于 `target-missing`（信封占满时目标同样「没找到」，
 * 但原因完全不同，混为一谈会让用户去重试一个永远不可能成功的动作）。
 * 判定顺序即优先级，改动必须同步单测。
 *
 * 入参 `committedRowCount` 是裁剪提交**之后**的焦点行数：
 * 「有行可放却一行没放下」正是共享信封被权威尾部占满的信号。
 */
export function resolveIndexFocusOutcome(params: {
  mergedRowCount: number;
  committedRowCount: number;
  targetFound: boolean;
  nextAction: IndexFocusNextAction;
}): IndexFocusOutcome {
  if (params.mergedRowCount > 0 && params.committedRowCount === 0) {
    return { status: "no-budget", nextAction: "none", targetFound: false, code: "no-budget" };
  }
  if (!params.targetFound && params.nextAction === "none") {
    // 服务端 eligible 已到头：目标不在当前分支（rewind/edit 已移除，U07-A4）。
    // 收敛为确定终态，不无限重试。
    return {
      status: "target-missing",
      nextAction: "none",
      targetFound: false,
      code: "target-missing",
    };
  }
  if (params.nextAction === "range-exhausted") {
    return {
      status: "range-exhausted",
      nextAction: "range-exhausted",
      targetFound: false,
      code: "range-exhausted",
    };
  }
  return {
    status: "focused",
    nextAction: params.nextAction,
    targetFound: params.targetFound,
    code: "ok",
  };
}

/**
 * 尾部窗口向后扩展后的焦点重算裁决（spec 不变量 3）。
 *
 * 为什么需要：`loadOlder` 与聚焦可能交错——自动预取在用户点目录前就已发出，其响应在
 * 焦点提交**之后**才落地，于是权威尾部前插覆盖了已有焦点行，同一 rowId 会被渲染两次
 * （U07-A2「没有重复行」）。裁尾/聚焦互斥只能挡「聚焦期间发起补拉」这一个方向，
 * 挡不住「补拉先发起、后提交」，因此提交后必须重算一次。
 *
 * 处置：把落进新尾部的焦点行让位给权威侧（权威侧是唯一事实源）。若一行不剩则
 * `resetToIdle=true`，由控制器退化为 idle——避免「返回最新」按钮挂在空焦点上。
 * `changed=false` 表示无需任何写入（调用方不得换 state 引用，避免无谓重渲染）。
 */
export function resolveIndexFocusReconciliation<T extends { rowId: number }>(params: {
  rows: readonly T[];
  tailFirstRowId: number | null;
  targetRowId: number | null;
  byteOf: (row: T) => number;
}):
  | { changed: false }
  | { changed: true; resetToIdle: true }
  | { changed: true; resetToIdle: false; rows: T[]; focusBytes: number; targetFound: boolean } {
  const { rows, tailFirstRowId, targetRowId, byteOf } = params;
  if (rows.length === 0) return { changed: false };
  // 复用与提交路径同一个纯函数，避免第二条去重/上界写入路径。
  const kept = resolveIndexFocusRows(rows, tailFirstRowId);
  if (kept.length === rows.length) return { changed: false };
  if (kept.length === 0) return { changed: true, resetToIdle: true };
  let focusBytes = 0;
  for (const row of kept) focusBytes += byteOf(row);
  return {
    changed: true,
    resetToIdle: false,
    rows: kept,
    focusBytes,
    targetFound: targetRowId !== null && kept.some((row) => row.rowId === targetRowId),
  };
}

/**
 * 目录 rowId → render unit index（U07 定位的滚动落点解析）。
 *
 * 归属：unitIndex 是 timeline 的派生事实（依赖虚拟列表的单元切分），只能由 timeline
 * 从自己的 renderUnits 解析，不得由目录面板或宿主反推——那会造出第二条单元索引写入路径。
 *
 * 命中规则：目标 rowId 落在哪个 unit 的 renderRows 里，就返回该 unit 的 index。
 * 找不到返回 null（例如焦点正文尚未提交、或目标行不属于任何可见单元），
 * 调用方据此保持当前滚动位置，不做猜测性跳转。
 */
export function resolveUnitIndexForRowId(
  units: readonly { renderRows: readonly { rowId: number }[] }[],
  rowId: number,
): number | null {
  for (let index = units.length - 1; index >= 0; index -= 1) {
    const unit = units[index];
    if (unit === undefined) continue;
    if (unit.renderRows.some((row) => row.rowId === rowId)) return index;
  }
  return null;
}

/**
 * 焦点正文合并规范（spec 不变量 3）。
 *
 * 三条裁决，缺一不可：
 * 1. **升序**——rowId 是全序键，焦点渲染顺序必须与之一致；
 * 2. **去重**——`continueFocusOlder` 的前插页可能与已有焦点行重叠；
 * 3. **严格早于尾部首行**——权威尾部经 loadOlder 前插后会覆盖部分焦点行，
 *    这些行必须让位给尾部（权威侧是唯一事实源），否则同一 rowId 渲染两次
 *    （U07-A2「没有重复行」）。尾部为空时上界为 +∞。
 */
export function resolveIndexFocusRows<T extends { rowId: number }>(
  merged: readonly T[],
  tailFirstRowId: number | null,
): T[] {
  const upperBound = tailFirstRowId === null ? Number.POSITIVE_INFINITY : tailFirstRowId;
  const seen = new Set<number>();
  const ascending: T[] = [];
  for (const row of [...merged].sort((left, right) => left.rowId - right.rowId)) {
    if (row.rowId >= upperBound || seen.has(row.rowId)) continue;
    seen.add(row.rowId);
    ascending.push(row);
  }
  return ascending;
}

// ── 陈旧结果零应用 ──

export type IndexFocusStaleReason = "closed" | "request" | "session" | "generation" | "epoch";

export interface IndexFocusResponseApplicability {
  applicable: boolean;
  reason: IndexFocusStaleReason | null;
}

/**
 * 四重陈旧校验（spec 规则 7 / U07-A3）：任一不匹配 → 应用次数为 0。
 *
 * generation 覆盖订阅换代（connect / runtime restart / close 各自 ++）；
 * logEpoch 覆盖 rewind / fork / CLI 重建（跨 epoch rowId 会重新编号）；
 * focusRequestId 覆盖同 store 内的 supersede（规则 8：单飞定位）。
 */
export function isIndexFocusResponseApplicable(input: {
  closed: boolean;
  requestSessionId: string;
  currentSessionId: string;
  requestGeneration: number;
  currentGeneration: number;
  requestLogEpoch: string;
  currentLogEpoch: string | null;
  requestFocusId: number;
  currentFocusId: number;
}): IndexFocusResponseApplicability {
  if (input.closed) return { applicable: false, reason: "closed" };
  if (input.requestFocusId !== input.currentFocusId)
    return { applicable: false, reason: "request" };
  if (input.requestSessionId !== input.currentSessionId)
    return { applicable: false, reason: "session" };
  if (input.requestGeneration !== input.currentGeneration) {
    return { applicable: false, reason: "generation" };
  }
  if (input.currentLogEpoch === null || input.requestLogEpoch !== input.currentLogEpoch) {
    return { applicable: false, reason: "epoch" };
  }
  return { applicable: true, reason: null };
}

// ── 目录视图（0 请求） ──

export interface IndexDirectoryItem {
  rowId: number;
  /** 复制自权威行（rowBaseFields），不是 UI 推断值——spec「稳定实体标识」裁决。 */
  turnId: string | null;
  entityId: string | null;
  summary: string;
  timestamp: number | null;
  /** 已在权威尾部窗口内：跳转无需 rowsRange。 */
  inWindow: boolean;
}

export interface IndexDirectory {
  items: readonly IndexDirectoryItem[];
  /** realUser query 条目数（= items.length）。 */
  total: number;
  /** 索引覆盖的全序范围（含非 query 行），供「当前可导航范围」展示。 */
  oldestIndexedRowId: number | null;
  newestIndexedRowId: number | null;
  /** 累计 FIFO 淘汰条目数；>0 即可识别为部分覆盖（spec 规则 6 / U07-A5）。 */
  evictedCount: number;
  isPartial: boolean;
  maxEntries: number;
}

export const EMPTY_INDEX_DIRECTORY: IndexDirectory = {
  items: [],
  total: 0,
  oldestIndexedRowId: null,
  newestIndexedRowId: null,
  evictedCount: 0,
  isPartial: false,
  maxEntries: 0,
};

/**
 * 索引 → 目录（spec 规则 1：打开目录 0 个 rowsRange 请求，不扫描正文）。
 *
 * 只取 `kind === "userInput" && origin === "realUser"`：目录代表用户主动 query，
 * 与既有 buildConversationTurnNavigatorItems 的产品语义一致（provider/store 的物理
 * role=user 还含 background/goal/mailbox 等系统上下文，不进目录）。
 *
 * 必须按 rowId 重排：ConversationTurnIndex.addRow 一律 push 到末尾，而 loadOlder 会
 * 把更早的行登记在更晚的行之后，登记序不等于全序。
 */
export function resolveIndexDirectory(
  entries: readonly TurnIndexEntry[],
  evictionCount: number,
  options: { tailFirstRowId: number | null; maxEntries: number; fallbackSummary: string },
): IndexDirectory {
  let oldest: number | null = null;
  let newest: number | null = null;
  const items: IndexDirectoryItem[] = [];
  for (const entry of entries) {
    if (oldest === null || entry.rowId < oldest) oldest = entry.rowId;
    if (newest === null || entry.rowId > newest) newest = entry.rowId;
    if (entry.kind !== "userInput" || entry.origin !== "realUser") continue;
    const summary = entry.summary?.trim();
    items.push({
      rowId: entry.rowId,
      turnId: entry.turnId ?? null,
      entityId: entry.entityId ?? null,
      summary: summary && summary.length > 0 ? summary : options.fallbackSummary,
      timestamp: entry.timestamp ?? null,
      inWindow: options.tailFirstRowId !== null && entry.rowId >= options.tailFirstRowId,
    });
  }
  items.sort((left, right) => left.rowId - right.rowId);
  return {
    items,
    total: items.length,
    oldestIndexedRowId: oldest,
    newestIndexedRowId: newest,
    evictedCount: Math.max(0, evictionCount),
    // 淘汰可识别：只承诺现有覆盖范围，不假装完整。
    isPartial: evictionCount > 0,
    maxEntries: options.maxEntries,
  };
}
