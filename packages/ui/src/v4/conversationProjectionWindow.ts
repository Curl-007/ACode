// 投影窗口的双上限与分页纯函数（specs/renderer-memory-budget.md 规则 3）。
//
// 从 conversationProjectionStore.ts 原样外迁：该文件已在 legacy ratchet 基线上
// （超限只减不增），U07 需要新增历史焦点逻辑，必须为它腾出行数。语义零改动——
// store 通过再导出保持既有 import 面（SessionPane / tests）不变。
import type { ConversationRow, ConversationSnapshot } from "@acode/shared/acode-protocol-v4";

// ── 投影窗口双上限（specs/renderer-memory-budget.md 规则 3）──
//
// 全量历史常驻 renderer 是主窗口堆棘轮式增长直至 OOM 的活数据无界增长源：wire 尾窗
// 只有 snapshotTailWindowRows(60) 行，但 loadOlder/loadAllOlder 合并历史后从不裁剪，
// 宽窗口下 loadAllOlder 会把整条分支历史（含 CUA base64 截图的行）常驻内存。窗口因此
// 始终保持「有界连续尾窗」：行数与字节双上限，超限从头部丢弃最旧行，
// window[0].rowId 始终是 rowsRange 分页游标（hasOlderRows/beforeRowId 语义不变）。
// 上限取值依据：wire 尾窗只有 snapshotTailWindowRows(60) 行，深滚动历史始终经
// rowsRange 回拉（每页最多 rowsRangeMaxLimit(200) 行），窗口外 turn 由 turn 索引提供
// 目录兜底，因此常驻 1200 行（≈ 6 个回拉页）已覆盖可视余量——深滚动只是多一两次
// 分页，却把最坏常驻（含 CUA base64 截图行）压到原先的 1/3。字节上限随行数上限
// 同比下调到 32MB（行均预算与 128MB/4000 行同量级），裁头不改变分页游标语义。
export const PROJECTION_WINDOW_MAX_ROWS = 1200;
export const PROJECTION_WINDOW_MAX_BYTES = 32 * 1024 * 1024;

// 协议行不可变（结构变化换整行），字节估计按对象身份只算一次。
const projectionRowBytesCache = new WeakMap<ConversationRow, number>();

/**
 * 估算单行在 renderer 的驻留字节：对 row 内所有字符串字段按 UTF-16 code unit 求和
 * （row 是纯 JSON 数据，无环；纯函数，结果按行对象身份缓存）。
 * CUA 截图以 base64 dataUrl 字符串内嵌在 toolCall input 等字段，按原长度计入——
 * 这是行字节的支配项；CJK 正文按 char 计相对 UTF-8 字节低估，但相对截图量级可忽略。
 */
export function estimateRowBytes(row: ConversationRow): number {
  const cached = projectionRowBytesCache.get(row);
  if (cached !== undefined) return cached;
  let total = 0;
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      total += value.length;
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const item of Object.values(value as Record<string, unknown>)) visit(item);
    }
  };
  visit(row);
  projectionRowBytesCache.set(row, total);
  return total;
}

export interface TrimmedProjectionWindow {
  /** 满足双上限的连续尾窗；未超限时与输入同引用（避免无谓换引用触发渲染）。 */
  window: ConversationRow[];
  /** 从头部裁掉的最旧行；这些行仍保留在 turn 索引中（索引登记先于裁剪）。 */
  evicted: readonly ConversationRow[];
}

/**
 * 窗口双上限裁剪：从头部丢弃最旧行，直到行数与字节同时满足上限。
 * 不变量：裁剪后 window 仍是连续尾窗，window[0].rowId 是合法分页游标
 * （hasOlderRows / loadOlder 的 beforeRowId 语义保持正确）。
 * 极端情形：单行即超字节预算时保留尾行、不裁出空窗口——游标与最新内容优先；
 * wire 帧上限（maxFrameBytes / logicalFrameAssemblyMaxBytes）使该情形实际不可达。
 */
export function trimProjectionWindowToLimits(
  window: readonly ConversationRow[],
): TrimmedProjectionWindow {
  let totalBytes = 0;
  for (const row of window) totalBytes += estimateRowBytes(row);
  if (window.length <= PROJECTION_WINDOW_MAX_ROWS && totalBytes <= PROJECTION_WINDOW_MAX_BYTES) {
    return { window: window as ConversationRow[], evicted: [] };
  }
  let cut = 0;
  while (
    cut < window.length - 1 &&
    (window.length - cut > PROJECTION_WINDOW_MAX_ROWS || totalBytes > PROJECTION_WINDOW_MAX_BYTES)
  ) {
    const oldest = window[cut];
    if (oldest === undefined) break;
    totalBytes -= estimateRowBytes(oldest);
    cut += 1;
  }
  return { window: window.slice(cut), evicted: window.slice(0, cut) };
}

/** 对快照的 rows.window 应用双上限裁剪；未裁剪时原引用返回（避免无谓渲染）。 */
export function withProjectionWindowLimits(snapshot: ConversationSnapshot): ConversationSnapshot {
  const { window, evicted } = trimProjectionWindowToLimits(snapshot.rows.window);
  if (evicted.length === 0) return snapshot;
  return { ...snapshot, rows: { ...snapshot.rows, window } };
}

/** 窗口是否已抵到任一上限（行数或估算字节）；封顶后 loadOlder 无法再让游标后退。 */
export function isProjectionWindowAtCap(window: readonly ConversationRow[]): boolean {
  if (window.length >= PROJECTION_WINDOW_MAX_ROWS) return true;
  let totalBytes = 0;
  for (const row of window) totalBytes += estimateRowBytes(row);
  return totalBytes >= PROJECTION_WINDOW_MAX_BYTES;
}

/**
 * 还有更早历史可拉 ⇔ 窗口首行不是全序首行（firstRowId 判定）。
 * 纯函数供 store/组件共用；快照缺失/空窗口/未知 firstRowId 一律 false。
 */
export function hasOlderRows(snapshot: ConversationSnapshot | null): boolean {
  if (!snapshot) return false;
  const first = snapshot.rows.window[0];
  if (!first || snapshot.rows.firstRowId === null) return false;
  return first.rowId > snapshot.rows.firstRowId;
}

/**
 * 冷快照尾窗是否从一个 turn 的中间截断。turnHeader 是完整 turn 的权威起点；首行允许是
 * lightBoundary，因此不能只判断首行 kind，必须检查首个 turn 在当前窗口里是否已有 header。
 */
export function shouldAutoLoadIncompleteLeadingTurn(
  snapshot: ConversationSnapshot | null,
  loadingOlder: boolean,
): boolean {
  if (loadingOlder || !hasOlderRows(snapshot) || !snapshot) return false;
  // 双上限已封顶时，补拉行会被窗口裁剪原样吃掉（头部游标无法后退），继续补拉只会
  // 空转；首 turn 缺 header 的展示降级让位于内存预算，不再为它自动补拉。
  if (isProjectionWindowAtCap(snapshot.rows.window)) return false;
  const leadingTurnId = snapshot.rows.window[0]?.turnId;
  if (!leadingTurnId) return false;
  return !snapshot.rows.window.some(
    (row) => row.turnId === leadingTurnId && row.kind === "turnHeader",
  );
}

/**
 * rows/range 结果并入本地窗口（合并规范）：按 rowId 键控、只收
 * 窗口首行之前的行、去重后前插；顺序键 = rowId 升序（全序保证）。
 * 返回 null 表示无可并入行（窗口无变化，调用方不换引用）；
 * older 是实际并入的行，供 turn 索引在进入窗口前登记。
 */
export function mergeOlderRows(
  window: readonly ConversationRow[],
  fetched: readonly ConversationRow[],
): { window: ConversationRow[]; older: readonly ConversationRow[] } | null {
  const firstRowId = window[0]?.rowId ?? Number.POSITIVE_INFINITY;
  const older = fetched.filter((row) => row.rowId < firstRowId);
  if (older.length === 0) return null;
  return { window: [...older, ...window], older };
}
