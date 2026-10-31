// turn 轻量索引：投影窗口裁剪后「窗口外 turn 可回拉」的依据。
//
// 全量历史常驻 renderer 是主窗口活数据无界增长的根源（specs/renderer-memory-budget.md
// 规则 3：投影窗口有界）。rows.window 被双上限裁剪后，窗口头部之外的 turn 仍需要被
// 目录/回拉逻辑感知，因此行进入窗口时在这里登记一份轻量元数据（rowId/kind/origin/
// createdAt/摘要），与正文行（可能含 CUA base64 截图）解耦；条目总量有上限。
import type { ConversationRow } from "@acode/shared/acode-protocol-v4";

/** 有 origin 字段的 row（turnHeader / userInput）的 origin 取值并集。 */
type RowOrigin = Extract<ConversationRow, { origin: unknown }>["origin"];

export interface TurnIndexEntry {
  rowId: number;
  kind: ConversationRow["kind"];
  origin?: RowOrigin;
  /** row.createdAt（协议 epoch ms）；供目录排序/展示，不参与身份判定。 */
  timestamp?: number;
  /** 仅 userInput 行：行文本前 120 字符，作为窗口外 turn 的目录摘要。 */
  summary?: string;
  /**
   * 权威 turn 标签（U07 目录跳转用）。
   *
   * 值**复制**自协议行的 `rowBaseFields.turnId`（rows.ts 展开全部 9 个 row 变体，CLI
   * rowBase() 对每行必写），不是 UI 从「最后一个 turnHeader」推断出来的——
   * specs/conversation-index-navigation.md「稳定实体标识」裁决：无需新增协议字段。
   * optional 只为兼容缺省该字段的旧帧，不做任何 fallback 猜测。
   */
  turnId?: string;
  /** 权威 canonical 实体 id，同样复制自协议行；rewind/edit 后由权威侧失效。 */
  entityId?: string;
}

// 上限取值依据：索引只需覆盖「当前窗口（≤1200 行）+ 被裁历史 + loadAllOlder 探测页」
// 的目录感知，窗口外正文始终经 rowsRange 回拉兜底；8000 条约为窗口行数上限的
// 6-7 倍，深滚动的目录余量足够。超限丢最旧只造成目录起点回退，不丢正文数据。
export const TURN_INDEX_MAX_ENTRIES = 8000;
const TURN_INDEX_SUMMARY_MAX_CHARS = 120;

/** 从 row 抽取轻量索引条目（纯函数）；summary 只取 userInput 行文本前 120 字符。 */
export function buildTurnIndexEntry(row: ConversationRow): TurnIndexEntry {
  const entry: TurnIndexEntry = {
    rowId: row.rowId,
    kind: row.kind,
    timestamp: row.createdAt,
    // 权威标识按行原样登记；缺失即缺失，不由 UI 补齐（避免把推断值当权威值）。
    ...(row.turnId !== undefined ? { turnId: row.turnId } : {}),
    ...(row.entityId !== undefined ? { entityId: row.entityId } : {}),
  };
  if ("origin" in row) {
    entry.origin = row.origin as RowOrigin;
  }
  if (row.kind === "userInput") {
    entry.summary = row.text.slice(0, TURN_INDEX_SUMMARY_MAX_CHARS);
  }
  return entry;
}

/**
 * turn 索引：FIFO 登记 + 超限丢最旧 + close 清空。
 * 同 rowId 去重（row.upserted / recovery snapshot 重放不重复占额度）；
 * 淘汰条目同步移出 rowId 集合，保证去重集合与条目同生共死、不无界增长。
 */
export class ConversationTurnIndex {
  private entries: TurnIndexEntry[] = [];
  private readonly rowIds = new Set<number>();
  private evicted = 0;
  private bytes = 0;

  addRow(row: ConversationRow): void {
    if (this.rowIds.has(row.rowId)) return;
    this.rowIds.add(row.rowId);
    const entry = buildTurnIndexEntry(row);
    this.entries.push(entry);
    this.bytes += estimateEntryBytes(entry);
    if (this.entries.length > TURN_INDEX_MAX_ENTRIES) {
      // 超限丢最旧：目录只关心「更早还有哪些 turn」，FIFO 淘汰即可，不需要 LRU。
      const dropped = this.entries.splice(0, this.entries.length - TURN_INDEX_MAX_ENTRIES);
      for (const entry of dropped) {
        this.rowIds.delete(entry.rowId);
        this.bytes -= estimateEntryBytes(entry);
      }
      this.evicted += dropped.length;
    }
  }

  addRows(rows: readonly ConversationRow[]): void {
    for (const row of rows) this.addRow(row);
  }

  /** 当前条目数；供内存诊断采样（specs 规则 1：缓存必须暴露计数）。 */
  get size(): number {
    return this.entries.length;
  }

  /** 累计淘汰条目数；供内存诊断观察淘汰速率。 */
  get evictionCount(): number {
    return this.evicted;
  }

  /** 条目字节估算（kind/origin/summary 字符串之和）；供内存诊断采样。 */
  get byteEstimate(): number {
    return this.bytes;
  }

  /** 只读快照；调用方不得修改数组内容（与窗口裁剪/登记共用同一引用）。 */
  snapshotEntries(): readonly TurnIndexEntry[] {
    return this.entries;
  }

  /**
   * 权威裁剪（row.removed / rewind / editUserQuery）：丢弃 rowId ≥ fromRowId 的条目。
   *
   * 与协议窗口语义逐字对齐——apply.ts 的 row.removed 也是 `window.filter(rowId < fromRowId)`。
   * rowId 在一个 logEpoch 内单调且永不复用（rows.ts RowBase 注释），因此被裁分支上的
   * query 不会再以同 rowId 回来；保留它们会让目录继续提供已不存在的入口。
   *
   * 返回被移除的条目数。**不计入 evictionCount**：淘汰计数只表达「预算 FIFO 淘汰」，
   * 而权威移除是事实变更。两者混算会让 isPartial 把「已 rewind」误报成「目录不完整」。
   */
  pruneFrom(fromRowId: number): number {
    let removed = 0;
    const kept: TurnIndexEntry[] = [];
    for (const entry of this.entries) {
      if (entry.rowId >= fromRowId) {
        this.rowIds.delete(entry.rowId);
        this.bytes -= estimateEntryBytes(entry);
        removed += 1;
        continue;
      }
      kept.push(entry);
    }
    if (removed > 0) this.entries = kept;
    return removed;
  }

  /** store close() 时释放（specs 所有者表：索引与窗口一并释放）。 */
  clear(): void {
    this.entries = [];
    this.rowIds.clear();
    this.evicted = 0;
    this.bytes = 0;
  }
}

function estimateEntryBytes(entry: TurnIndexEntry): number {
  return entry.kind.length + (entry.origin?.length ?? 0) + (entry.summary?.length ?? 0);
}
