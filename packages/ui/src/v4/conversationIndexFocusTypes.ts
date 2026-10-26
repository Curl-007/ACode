// U07 历史焦点的类型面与宿主读取契约（specs/conversation-index-navigation.md）。
//
// 单独成文件的原因：conversationIndexFocusController.ts 承载状态机本体，
// 类型面（含 store 提供的最小读取面）拆出后两文件都在 400 行以内。
import type { ConversationRow, ConversationSnapshot } from "@acode/shared/acode-protocol-v4";
import type { TurnIndexEntry } from "@/v4/conversationTurnIndex.js";
import type { IndexDirectory, IndexFocusStaleReason } from "@/v4/conversationIndexNavigation.js";

export type { IndexDirectory, IndexFocusStaleReason };

export interface IndexFocusRowsRangeParams {
  sessionId: string;
  beforeRowId: number;
  limit: number;
}

export interface IndexFocusRowsRangeResult {
  rows: readonly ConversationRow[];
  atLogEpoch: string;
  hasMore: boolean;
}

/** store 提供的最小读取面（只读，控制器不反向持有 store 引用）。 */
export interface IndexFocusHost {
  sessionId: string | null;
  generation: number;
  closed: boolean;
  snapshot: ConversationSnapshot | null;
  /** 目录内容失效代际（store turnNavigatorDirectoryRevision）。 */
  directoryRevision: number;
  turnIndexEntries(): readonly TurnIndexEntry[];
  turnIndexEvictionCount(): number;
  turnIndexByteEstimate(): number;
  turnIndexSize(): number;
  /** 尾部窗口裁到 retainRows 行后的字节估算；裁尾时用于共享信封的字节侧裁决。 */
  tailRetainBytes(retainRows: number): number;
  maxWindowRows: number;
  maxWindowBytes: number;
  rowsRangeMaxLimit: number;
  maxIndexEntries: number;
  /** 焦点生效时裁尾（共享信封争用时才调用），由 store 回调实现。 */
  applyTailTrim(retainRows: number): void;
}

export type IndexFocusStatus =
  | "idle"
  | "loading"
  | "focused"
  /**
   * 共享信封已被权威尾部占满（运行中 turn 行数 ≥ 1200），焦点分不到任何预算。
   *
   * 这是**确定的降级态**而不是错误：运行中 turn 的存活内容优先级高于历史焦点
   * （裁尾会丢 row.delta 流式增量，见 spec 证据 2/3）。UI 据此提示用户
   * 「当前回答过长，返回最新后重试」，并保留目录与尾部不动。
   */
  | "no-budget"
  | "target-missing"
  | "not-indexed"
  | "range-exhausted"
  | "stale"
  | "retryable-failure";

export type IndexFocusNextAction = "none" | "continue-older" | "range-exhausted";

export interface IndexFocusState {
  status: IndexFocusStatus;
  /** 派生只读焦点正文（严格早于尾部窗口，rowId 升序、与尾部无重复）。 */
  rows: readonly ConversationRow[];
  targetRowId: number | null;
  /** 定位到的目标行是否已在焦点正文内。 */
  targetFound: boolean;
  requestsUsed: number;
  nextAction: IndexFocusNextAction;
  staleReason: IndexFocusStaleReason | null;
  /** 自增定位代：同一 store 最多一个**有效**定位（spec 规则 8）。 */
  requestId: number;
  /** 尾部是否被裁过（证据 2：只在信封争用时才发生）。 */
  tailTrimmed: boolean;
  /** 焦点区估算字节（内存诊断 / 预算断言）。 */
  focusBytes: number;
}

export const IDLE_INDEX_FOCUS_STATE: IndexFocusState = {
  status: "idle",
  rows: [],
  targetRowId: null,
  targetFound: false,
  requestsUsed: 0,
  nextAction: "none",
  staleReason: null,
  requestId: 0,
  tailTrimmed: false,
  focusBytes: 0,
};

export type IndexFocusResultCode =
  | "ok"
  | "stale"
  | "busy"
  | "no-budget"
  | "not-indexed"
  | "target-missing"
  | "range-exhausted"
  | "retryable-failure"
  | "closed";

/** 焦点区内存诊断（specs/renderer-memory-budget.md 规则 1：必须暴露计数）。 */
export interface IndexFocusDiagnostics {
  focusRows: number;
  focusBytes: number;
  status: IndexFocusStatus;
}

export interface IndexFocusResult {
  status: IndexFocusStatus;
  /** 结构化可恢复错误码（spec 接口表：响应包含定位结果和可恢复错误码）。 */
  code: IndexFocusResultCode;
  staleReason: IndexFocusStaleReason | null;
  targetRowId: number | null;
  nextAction: IndexFocusNextAction;
  focusRowCount: number;
}

export interface IndexFocusTarget {
  /** 点击时观察到的会话/代际/纪元；与当前值不符则请求作废（spec 规则 7）。 */
  sessionId: string;
  generation: number;
  logEpoch: string;
  rowId: number;
}

export interface IndexDirectoryCacheKey {
  size: number;
  evictions: number;
  bytes: number;
  revision: number;
  tailFirstRowId: number | null;
}

export function sameIndexDirectoryCacheKey(
  a: IndexDirectoryCacheKey | null,
  b: IndexDirectoryCacheKey,
): boolean {
  if (a === null) return false;
  return (
    a.size === b.size &&
    a.evictions === b.evictions &&
    a.bytes === b.bytes &&
    a.revision === b.revision &&
    a.tailFirstRowId === b.tailFirstRowId
  );
}

/** 空目录常量（close() 后与索引尚未登记时的稳定引用，避免无谓重渲染）。 */
export const EMPTY_INDEX_DIRECTORY: IndexDirectory = {
  items: [],
  total: 0,
  oldestIndexedRowId: null,
  newestIndexedRowId: null,
  evictedCount: 0,
  isPartial: false,
  maxEntries: 0,
};
