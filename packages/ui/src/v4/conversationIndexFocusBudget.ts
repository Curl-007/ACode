// U07 共享信封预算裁决（specs/conversation-index-navigation.md「窗口语义裁决」）。
//
// 从 conversationIndexNavigation.ts 拆出，使两个模块都在 400 行以内；语义零改动。
// 本模块只算账不写状态：焦点 + 尾部 + 瞬态 page buffer 合计必须落在**同一个**
// 1200 行 / 32 MiB 信封内（不是各留一份再相加）。

/**
 * 尾部保留下限（spec「窗口语义裁决」证据 1）。
 *
 * 取值 = PROTOCOL_V4_LIMITS.snapshotTailWindowRows(60)：冷 subscribe 只下发最后 60 行，
 * 裁到 60 意味着 renderer 持有量不低于服务端自己的重订阅基线，被裁行始终可经
 * rowsRange 原样取回。它只是**下限**——证据 2/3 表明不得无条件把尾部收缩到 60。
 */
export const INDEX_FOCUS_TAIL_FLOOR_ROWS = 60;

export interface IndexFocusBudgetInput {
  /** 权威尾部窗口当前行数。 */
  tailRowCount: number;
  /** 尾部窗口在「保留 tailRetainRows 行」后的估算字节；由 store 用 estimateRowBytes 求出。 */
  tailRetainBytesProvider: (tailRetainRows: number) => number;
  /** 焦点区已驻留行数（不含本次待并入页）。 */
  focusRowCount: number;
  /** 本次待并入的定向页行数（瞬态分页缓冲计入焦点，不作为第三份常驻）。 */
  incomingRowCount: number;
  /** 运行中 turn 的行数（证据 3：下限必须按实况抬高，永不裁进当前运行 turn）。 */
  runningTurnRowCount: number;
  /** 共享信封上限（不是各留一份再相加）。 */
  maxRows: number;
  maxBytes: number;
}

export interface IndexFocusBudget {
  /** 尾部保留行数；`tailRowCount - tailRetainRows` 行从尾部头部裁掉。 */
  tailRetainRows: number;
  tailRetainBytes: number;
  /** 焦点区在并入 incoming 后的行数上限。 */
  focusRowCapacity: number;
  /** 焦点区在并入 incoming 后的字节上限。 */
  focusByteCapacity: number;
  /** 焦点区需从头部丢弃的行数（更早的焦点行让位给更近的）。 */
  focusDropHeadRows: number;
  /** 是否真的动了尾部（false = 信封未争用，零代价聚焦）。 */
  tailTrimmed: boolean;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/**
 * 共享信封分配：尾部优先、争用时才裁尾（spec「窗口语义裁决」）。
 *
 * 顺序是有意的：
 * 1. 先按「不裁尾」尝试——`tailRowCount + focusRowCount + incoming ≤ maxRows` 时零代价；
 * 2. 装不下才把尾部向下压到 `max(下限, 运行中 turn 行数)`；
 * 3. 仍装不下则裁焦点头部（更早的焦点行让位），绝不突破信封。
 *
 * 证据 2（apply.ts:82/112 对未加载行静默 no-op）说明无条件收缩尾部会让被裁行丢失
 * 后续 row.delta 流式增量，故步骤 1 是常态、步骤 2 只在真的争用时发生。
 */
export function resolveIndexFocusBudget(input: IndexFocusBudgetInput): IndexFocusBudget {
  const maxRows = Math.max(0, input.maxRows);
  // 下限取「60 与运行中 turn 行数」的较大者，再被信封与实际尾部行数夹住。
  const tailFloor = clamp(
    Math.max(INDEX_FOCUS_TAIL_FLOOR_ROWS, input.runningTurnRowCount),
    0,
    Math.min(maxRows, input.tailRowCount),
  );
  const demanded = input.focusRowCount + input.incomingRowCount;
  // 步骤 1：能不动尾部就不动。
  const wanted = clamp(input.tailRowCount, 0, Math.max(0, maxRows - demanded));
  // 步骤 2：低于下限时抬回下限（不裁进运行中 turn）。
  const tailRetainRows = Math.max(wanted, tailFloor);

  const tailRetainBytes = input.tailRetainBytesProvider(tailRetainRows);
  const focusRowCapacity = Math.max(0, maxRows - tailRetainRows);
  const focusByteCapacity = Math.max(0, input.maxBytes - tailRetainBytes);
  const focusDropHeadRows = Math.max(
    0,
    input.focusRowCount + input.incomingRowCount - focusRowCapacity,
  );
  return {
    tailRetainRows,
    tailRetainBytes,
    focusRowCapacity,
    focusByteCapacity,
    focusDropHeadRows,
    tailTrimmed: tailRetainRows < input.tailRowCount,
  };
}

/**
 * 焦点侧行数/字节双上限裁剪：从头部丢最旧（更早焦点行先让位），至少保留末行。
 * 末行优先与 store 的 trimProjectionWindowToLimits 同一裁决——定向页的目标行正是末行
 * （服务端 getRowsRange 以 eligible.slice(-limit) 收口），宁可丢更早上下文也不丢目标。
 *
 * 「至少保留末行」有**一个**例外：容量为 0 时必须返回空。这发生在运行中 turn 已占满
 * 整个信封时（tailFloor = 运行中 turn 行数 = maxRows → focusRowCapacity = 0）。
 * 此时若仍保留末行，焦点 + 尾部合计会突破信封（实测 1200+1=1201），
 * 违反 spec 不变量 1；而运行中 turn 的存活内容优先级高于历史焦点，
 * 因此让焦点整体让位、由 UI 呈现「当前无法聚焦历史」的确定降级态。
 */
export function trimIndexFocusRows<T>(
  rows: readonly T[],
  budget: { maxRows: number; maxBytes: number },
  byteOf: (row: T) => number,
): { rows: T[]; droppedHead: number; bytes: number } {
  const maxRows = Math.max(0, budget.maxRows);
  // 容量为 0：焦点无预算可用，整体让位（不保留末行），守住合计 ≤ maxRows。
  if (maxRows === 0 || budget.maxBytes <= 0) {
    return { rows: [], droppedHead: rows.length, bytes: 0 };
  }
  let totalBytes = 0;
  for (const row of rows) totalBytes += byteOf(row);
  if (rows.length <= maxRows && totalBytes <= budget.maxBytes) {
    return { rows: [...rows], droppedHead: 0, bytes: totalBytes };
  }
  let cut = 0;
  while (cut < rows.length - 1 && (rows.length - cut > maxRows || totalBytes > budget.maxBytes)) {
    const oldest = rows[cut];
    if (oldest === undefined) break;
    totalBytes -= byteOf(oldest);
    cut += 1;
  }
  return { rows: rows.slice(cut), droppedHead: cut, bytes: totalBytes };
}

/**
 * 运行中 turn 的行数 = 与窗口末行同 turnId 的行数（证据 3）。
 *
 * 只有尾部这一段还可能收到 row.delta 流式追加，因此它是裁尾的硬边界；
 * 用 turnId 分组而非「最后一个 turnHeader 之后」是因为 turn 是 row 上的标签不是容器
 * （rows.ts 头部注释），同 turnId 才是权威的「同一个运行中 turn」。
 */
export function resolveRunningTurnRowCount(window: readonly { turnId: string }[]): number {
  const lastTurnId = window.at(-1)?.turnId;
  if (lastTurnId === undefined) return 0;
  let count = 0;
  for (const row of window) if (row.turnId === lastTurnId) count += 1;
  return count;
}
