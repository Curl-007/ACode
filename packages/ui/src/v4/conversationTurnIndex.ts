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
}

export const TURN_INDEX_MAX_ENTRIES = 20000;
const TURN_INDEX_SUMMARY_MAX_CHARS = 120;

/** 从 row 抽取轻量索引条目（纯函数）；summary 只取 userInput 行文本前 120 字符。 */
export function buildTurnIndexEntry(row: ConversationRow): TurnIndexEntry {
  const entry: TurnIndexEntry = {
    rowId: row.rowId,
    kind: row.kind,
    timestamp: row.createdAt,
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
