// U07 历史焦点控制器与 conversationProjectionStore 之间的宿主适配（工厂）。
//
// 单独成文件的原因：conversationProjectionStore.ts 已在 legacy ratchet 基线上
// （超限只减不增），适配层约 60 行必须留在 store 之外。本模块只负责「把 store 的
// 只读事实与窗口裁剪能力接成 IndexFocusHost」，不含任何目录/定位裁决逻辑
// （那些在 conversationIndexNavigation.ts 与 conversationIndexFocusController.ts）。
import { PROTOCOL_V4_LIMITS, type ConversationSnapshot } from "@acode/shared/acode-protocol-v4";
import { ConversationIndexFocusController } from "@/v4/conversationIndexFocusController.js";
import type {
  IndexFocusResult,
  IndexFocusRowsRangeParams,
  IndexFocusRowsRangeResult,
} from "@/v4/conversationIndexFocusTypes.js";
import type { TurnIndexEntry } from "@/v4/conversationTurnIndex.js";
import { TURN_INDEX_MAX_ENTRIES } from "@/v4/conversationTurnIndex.js";
import {
  PROJECTION_WINDOW_MAX_BYTES,
  PROJECTION_WINDOW_MAX_ROWS,
  estimateRowBytes,
} from "@/v4/conversationProjectionWindow.js";

/**
 * store 已关闭时的稳定终态（不新建控制器、不发请求、不写任何状态）。
 * 抽成函数是为了让 store 侧的早退分支保持一行，不把结果字面量摊回 store。
 */
export function closedIndexFocusResult(
  code: "closed",
  targetRowId: number | null,
): IndexFocusResult {
  return {
    status: "stale",
    code,
    staleReason: "closed",
    targetRowId,
    nextAction: "none",
    focusRowCount: 0,
  };
}

/** store 需要向适配层暴露的最小事实面（全部为读取函数 + 一个裁尾写入回调）。 */
export interface IndexFocusStoreFacts {
  readonly sessionId: string | null;
  /** 订阅代际（store 内 private，故以函数暴露，避免对象字面量 getter 的 this 误绑）。 */
  generation(): number;
  isClosed(): boolean;
  snapshot(): ConversationSnapshot | null;
  directoryRevision(): number;
  turnIndexEntries(): readonly TurnIndexEntry[];
  turnIndexEvictionCount(): number;
  turnIndexByteEstimate(): number;
  turnIndexSize(): number;
  rowsRange(params: IndexFocusRowsRangeParams): Promise<IndexFocusRowsRangeResult>;
  applyTailTrim(retainRows: number): void;
}

/**
 * 建立控制器。
 *
 * `tailRetainBytes` 与 store 的 `applyTailTrim` 都从同一份 `snapshot.rows.window` 求值，
 * 因此「字节侧裁决」与「实际裁尾」看到同一份行集合，不会因两次读取之间到达 delta
 * 而算出互相矛盾的保留行数。
 */
export function createIndexFocusController(
  facts: IndexFocusStoreFacts,
): ConversationIndexFocusController {
  return new ConversationIndexFocusController(
    {
      sessionId: facts.sessionId,
      get generation() {
        return facts.generation();
      },
      get closed() {
        return facts.isClosed();
      },
      get snapshot() {
        return facts.snapshot();
      },
      get directoryRevision() {
        return facts.directoryRevision();
      },
      turnIndexEntries: () => facts.turnIndexEntries(),
      turnIndexEvictionCount: () => facts.turnIndexEvictionCount(),
      turnIndexByteEstimate: () => facts.turnIndexByteEstimate(),
      turnIndexSize: () => facts.turnIndexSize(),
      tailRetainBytes: (retainRows) => sumTailRetainBytes(facts.snapshot(), retainRows),
      maxWindowRows: PROJECTION_WINDOW_MAX_ROWS,
      maxWindowBytes: PROJECTION_WINDOW_MAX_BYTES,
      rowsRangeMaxLimit: PROTOCOL_V4_LIMITS.rowsRangeMaxLimit,
      maxIndexEntries: TURN_INDEX_MAX_ENTRIES,
      applyTailTrim: (retainRows) => facts.applyTailTrim(retainRows),
    },
    (params) => facts.rowsRange(params),
    estimateRowBytes,
  );
}

/** 尾部保留 retainRows 行时的字节估算（共享信封的字节侧裁决输入）。 */
export function sumTailRetainBytes(
  snapshot: ConversationSnapshot | null,
  retainRows: number,
): number {
  const window = snapshot?.rows.window ?? [];
  const start = Math.max(0, window.length - Math.max(0, retainRows));
  let total = 0;
  for (let index = start; index < window.length; index += 1) {
    const row = window[index];
    if (row !== undefined) total += estimateRowBytes(row);
  }
  return total;
}
