// U07 历史焦点控制器（specs/conversation-index-navigation.md）。
//
// 唯一写入方仍是 conversationProjectionStore：本控制器由 store 组合持有，
// 只做「派生只读焦点视图」的读写与有效性裁决，不产生任何 conversation 事实。
// 拆到独立模块的原因：conversationProjectionStore.ts 已在 legacy ratchet 基线上
// （超限只减不增），新增逻辑必须落到新文件。
//
// 依赖注入：transport / host 读取器 / byteOf 全部由 store 传入，避免与本模块形成
// import 环，也让控制器可在无 DOM 的单测里直接驱动。
import { logger } from "@/logger.js";
import {
  clampRowsRangeLimit,
  isIndexFocusResponseApplicable,
  planIndexFocusPage,
  resolveIndexFocusNextAction,
  resolveRunningTurnRowCount,
  resolveIndexFocusCommit,
  resolveIndexFocusOutcome,
  resolveIndexFocusReconciliation,
} from "@/v4/conversationIndexNavigation.js";
import { ConversationIndexDirectoryView } from "@/v4/conversationIndexDirectoryView.js";
import {
  IDLE_INDEX_FOCUS_STATE,
  type IndexDirectory,
  type IndexFocusDiagnostics,
  type IndexFocusHost,
  type IndexFocusResult,
  type IndexFocusResultCode,
  type IndexFocusRowsRangeParams,
  type IndexFocusRowsRangeResult,
  type IndexFocusState,
  type IndexFocusStatus,
  type IndexFocusTarget,
} from "@/v4/conversationIndexFocusTypes.js";
import type { ConversationRow } from "@acode/shared/acode-protocol-v4";

export class ConversationIndexFocusController {
  private state: IndexFocusState = IDLE_INDEX_FOCUS_STATE;
  private readonly listeners = new Set<() => void>();
  private readonly directory: ConversationIndexDirectoryView;

  constructor(
    private readonly host: IndexFocusHost,
    private readonly rowsRange: (
      params: IndexFocusRowsRangeParams,
    ) => Promise<IndexFocusRowsRangeResult>,
    private readonly byteOf: (row: ConversationRow) => number,
  ) {
    // 目录视图与本控制器共用同一个只读事实面（host），不另立第二条接线。
    this.directory = new ConversationIndexDirectoryView(host);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getState(): IndexFocusState {
    return this.state;
  }

  private setState(patch: Partial<IndexFocusState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  /** 焦点是否生效中（store 据此抑制尾部 loadOlder，避免与焦点行重复）。 */
  get isActive(): boolean {
    return this.state.rows.length > 0 || this.state.status === "loading";
  }

  setDirectoryFallbackSummary(summary: string): void {
    this.directory.setFallbackSummary(summary);
  }

  /** 目录视图：0 个 rowsRange 请求、不扫描正文（spec 规则 1）。 */
  getDirectory(): IndexDirectory {
    return this.directory.resolve();
  }

  /** 目标是否在索引内（淘汰后返回 not-indexed，spec 规则 6）。 */
  private isIndexed(rowId: number): boolean {
    return this.host.turnIndexEntries().some((entry) => entry.rowId === rowId);
  }

  private resultOf(status: IndexFocusStatus, code: IndexFocusResultCode): IndexFocusResult {
    return {
      status,
      code,
      staleReason: this.state.staleReason,
      targetRowId: this.state.targetRowId,
      nextAction: this.state.nextAction,
      focusRowCount: this.state.rows.length,
    };
  }

  /**
   * 四重陈旧校验（spec 规则 7）。点击时与响应时共用同一条构造路径，
   * 避免两处各写一遍身份字段而产生分叉（单一写入路径）。
   *
   * `requestFocusId` / `currentFocusId` 分开传：
   * - 校验点击是否新鲜时两者都传 0（focusId 比较恒真，只查 session/generation/epoch，
   *   因为 requestId 要到请求真正发出后才有意义）；
   * - 校验响应时 requestFocusId=本次请求 id、currentFocusId=store 当前 id，
   *   两者不等即为被更新的定位请求 supersede（规则 8）。
   */
  private checkApplicability(
    target: IndexFocusTarget,
    requestFocusId: number,
    currentFocusId: number,
  ) {
    return isIndexFocusResponseApplicable({
      closed: this.host.closed,
      requestSessionId: target.sessionId,
      currentSessionId: this.host.sessionId ?? "",
      requestGeneration: target.generation,
      currentGeneration: this.host.generation,
      requestLogEpoch: target.logEpoch,
      currentLogEpoch: this.host.snapshot?.logEpoch ?? null,
      requestFocusId,
      currentFocusId,
    });
  }

  /**
   * 定位入口（spec 接口表 focusIndexedRow）。
   *
   * 单飞语义是 supersede 而非拒绝：新请求自增 requestId，旧请求后到时因 id 不匹配
   * 作废（规则 8 / U07-A3）。因此这里**不**因 status==="loading" 提前返回 busy。
   */
  async focusIndexedRow(target: IndexFocusTarget): Promise<IndexFocusResult> {
    if (this.host.closed) {
      this.setState({ status: "stale", staleReason: "closed", rows: [], focusBytes: 0 });
      return this.resultOf("stale", "closed");
    }
    // 点击时观察到的会话/代际/纪元必须仍与当前一致，否则这次点击本身就已过期。
    const applicability = this.checkApplicability(target, 0, 0);
    if (!applicability.applicable) {
      // 过期点击不写任何状态：目录与当前尾部保持不变（spec「定位失败保留目录与尾部」）。
      logger.debug("[v4-index-focus] 定位点击已过期，忽略", {
        reason: applicability.reason,
        rowId: target.rowId,
        sessionId: target.sessionId,
      });
      this.setState({ staleReason: applicability.reason });
      return { ...this.resultOf("stale", "stale"), staleReason: applicability.reason };
    }
    if (!this.isIndexed(target.rowId)) {
      this.setState({ status: "not-indexed", targetRowId: target.rowId, targetFound: false });
      return this.resultOf("not-indexed", "not-indexed");
    }

    const requestId = this.state.requestId + 1;
    this.setState({
      status: "loading",
      requestId,
      targetRowId: target.rowId,
      targetFound: false,
      requestsUsed: 0,
      nextAction: "none",
      staleReason: null,
      // 旧焦点正文立即释放：不做半页拼接（spec 不变量 5）。
      rows: [],
      focusBytes: 0,
    });
    // 定向单页：beforeRowId = target + 1（spec 规则 2）。
    return this.fetchPage(
      target,
      requestId,
      planIndexFocusPage(target.rowId, this.host.rowsRangeMaxLimit),
    );
  }

  /** 显式「继续加载更早」：把超范围的决定权交回用户（spec 规则 3）。 */
  async continueFocusOlder(): Promise<IndexFocusResult> {
    if (this.host.closed) return this.resultOf("stale", "closed");
    const cursor = this.state.rows[0]?.rowId;
    const requestId = this.state.requestId;
    const targetRowId = this.state.targetRowId;
    if (cursor === undefined || targetRowId === null || this.state.status === "loading") {
      return this.resultOf(this.state.status, "busy");
    }
    const snapshot = this.host.snapshot;
    if (!snapshot) return this.resultOf("stale", "stale");
    this.setState({ status: "loading", nextAction: "none" });
    // 继续页以当前焦点最早行为游标，不再做 +1（那是「命中目标」的定向页语义）。
    return this.fetchPage(
      {
        sessionId: this.host.sessionId ?? "",
        generation: this.host.generation,
        logEpoch: snapshot.logEpoch,
        rowId: targetRowId,
      },
      requestId,
      { beforeRowId: cursor, limit: clampRowsRangeLimit(this.host.rowsRangeMaxLimit) },
      { appendOlder: true },
    );
  }

  private async fetchPage(
    target: IndexFocusTarget,
    requestId: number,
    page: { beforeRowId: number; limit: number },
    options: { appendOlder?: boolean } = {},
  ): Promise<IndexFocusResult> {
    const sessionId = this.host.sessionId;
    if (!sessionId) return this.resultOf("stale", "stale");
    const requestsUsed = this.state.requestsUsed + 1;
    this.setState({ requestsUsed });
    let result: IndexFocusRowsRangeResult;
    try {
      result = await this.rowsRange({ sessionId, ...page });
    } catch (error) {
      logger.warn(
        `[v4-index-focus] 定位 rowsRange ${sessionId} 失败: ${error instanceof Error ? error.message : String(error)}`,
      );
      if (!this.isCurrentRequest(requestId)) return this.resultOf("stale", "stale");
      this.setState({ status: "retryable-failure", nextAction: "none" });
      return this.resultOf("retryable-failure", "retryable-failure");
    }

    if (!this.isCurrentRequest(requestId)) {
      // 陈旧结果零应用（spec 规则 7 / U07-A3）。
      return this.resultOf("stale", "stale");
    }
    const applicability = this.checkApplicability(target, requestId, this.state.requestId);
    if (!applicability.applicable) {
      logger.debug("[v4-index-focus] 定位响应已过期，丢弃", {
        reason: applicability.reason,
        requestId,
        rowId: target.rowId,
        sessionId,
      });
      this.setState({ staleReason: applicability.reason, status: "stale" });
      return { ...this.resultOf("stale", "stale"), staleReason: applicability.reason };
    }

    const targetFound = result.rows.some((row) => row.rowId === target.rowId);
    const nextAction = resolveIndexFocusNextAction({
      requestsUsed,
      targetFound,
      hasMore: result.hasMore,
    });
    const merged = options.appendOlder
      ? [...result.rows.filter((row) => row.rowId < page.beforeRowId), ...this.state.rows]
      : [...result.rows];
    const commit = this.resolveCommit(merged);
    // 终态裁决（含分支优先级）统一由纯函数给出，控制器只落地状态与日志。
    const outcome = resolveIndexFocusOutcome({
      mergedRowCount: merged.length,
      committedRowCount: commit.rows.length,
      targetFound,
      nextAction,
    });
    if (outcome.status === "no-budget") {
      logger.debug("[v4-index-focus] 共享信封无可用预算，聚焦降级", {
        rowId: target.rowId,
        sessionId,
      });
    }
    // 单次 setState：rows/focusBytes 与终态原子提交，订阅者看不到中间态。
    this.setState({
      rows: commit.rows,
      focusBytes: commit.focusBytes,
      tailTrimmed: this.state.tailTrimmed || commit.tailTrimmed,
      status: outcome.status,
      nextAction: outcome.nextAction,
      targetFound: outcome.targetFound,
    });
    return this.resultOf(outcome.status, outcome.code);
  }

  /**
   * 共享信封裁剪（spec「窗口语义裁决」步骤 1-3）。
   *
   * 只算账 + 落地必要的裁尾写入，**不写焦点状态**：状态由调用方一次性 setState，
   * 避免出现「rows 已换、status 仍是 loading」这种可被订阅者观察到的中间态
   * （AGENTS.md：避免多条写入路径）。
   */
  private resolveCommit(merged: readonly ConversationRow[]) {
    const tail = this.host.snapshot?.rows.window ?? [];
    // 合并去重、共享信封分配、焦点侧裁剪全部由纯函数裁决（可脱 jsdom 断言总预算）。
    const commit = resolveIndexFocusCommit({
      merged,
      tailFirstRowId: tail[0]?.rowId ?? null,
      tailRowCount: tail.length,
      tailRetainBytes: (retainRows) => this.host.tailRetainBytes(retainRows),
      runningTurnRowCount: resolveRunningTurnRowCount(tail),
      maxRows: this.host.maxWindowRows,
      maxBytes: this.host.maxWindowBytes,
      byteOf: this.byteOf,
    });
    if (commit.tailTrimmed) {
      // 只在信封真的争用时才动尾部；证据 3 保证永不裁进当前运行 turn。
      this.host.applyTailTrim(commit.tailRetainRows);
    }
    return commit;
  }

  private isCurrentRequest(requestId: number): boolean {
    return !this.host.closed && requestId === this.state.requestId;
  }

  /** 返回最新：清焦点正文、作废在途请求、恢复尾部滚动意图（spec 规则 5）。 */
  returnToLive(): void {
    if (this.state.requestId === 0 && this.state.rows.length === 0) return;
    // requestId 自增使任何在途定位响应作废（即使它稍后到达也应用 0 次）。
    this.setState({
      ...IDLE_INDEX_FOCUS_STATE,
      requestId: this.state.requestId + 1,
    });
  }

  /** rewind/edit 或快照整体替换：索引与聚焦一起失效（U07-A4）。 */
  invalidate(reason: "epoch" | "closed"): void {
    this.directory.invalidate();
    if (this.state.requestId === 0 && this.state.rows.length === 0) return;
    this.setState({
      ...IDLE_INDEX_FOCUS_STATE,
      requestId: this.state.requestId + 1,
      status: reason === "closed" ? "idle" : "stale",
      staleReason: reason,
    });
  }

  /**
   * 权威裁剪移除了焦点目标（row.removed：rewind / editUserQuery）。
   *
   * 与 invalidate 的区别：这不是「响应过期」，而是「目标已确定不存在」。
   * 因此收敛为 target-missing 终态而不是 stale —— UI 据此显示确定的
   * 不可定位状态，不做无限重试（spec U07-A4）。在途请求同样作废。
   */
  invalidateTarget(removedFromRowId: number): void {
    this.directory.invalidate();
    if (
      this.state.requestId === 0 &&
      this.state.rows.length === 0 &&
      this.state.status !== "loading"
    ) {
      return;
    }
    const targetRowId = this.state.targetRowId;
    // 目标落在被裁区间内 → 确定不可定位；否则只是焦点正文需要作废，状态回 idle。
    const affected = targetRowId !== null && targetRowId >= removedFromRowId;
    this.setState({
      ...IDLE_INDEX_FOCUS_STATE,
      requestId: this.state.requestId + 1,
      targetRowId,
      status: affected ? "target-missing" : "idle",
    });
  }

  /**
   * 尾部窗口向后扩展后重算焦点（裁决见 resolveIndexFocusReconciliation 的文档注释）。
   * 本方法只负责落地：日志、idle 退化、或写入让位后的焦点正文。
   */
  reconcileAgainstTail(tailFirstRowId: number | null): void {
    const rows = this.state.rows;
    const outcome = resolveIndexFocusReconciliation({
      rows,
      tailFirstRowId,
      targetRowId: this.state.targetRowId,
      byteOf: this.byteOf,
    });
    if (!outcome.changed) return;
    logger.debug("[v4-index-focus] 尾部前插覆盖焦点行，让位权威尾部", {
      retainedRows: outcome.resetToIdle ? 0 : outcome.rows.length,
      tailFirstRowId,
    });
    if (outcome.resetToIdle) {
      this.setState({ ...IDLE_INDEX_FOCUS_STATE, requestId: this.state.requestId + 1 });
      return;
    }
    this.setState({
      rows: outcome.rows,
      focusBytes: outcome.focusBytes,
      targetFound: outcome.targetFound,
    });
  }

  /** 内存诊断计数（specs/renderer-memory-budget.md 规则 1：缓存必须暴露计数）。 */
  diagnostics(): IndexFocusDiagnostics {
    const { rows, focusBytes, status } = this.state;
    return { focusRows: rows.length, focusBytes, status };
  }

  close(): void {
    this.listeners.clear();
    this.directory.invalidate();
    this.state = IDLE_INDEX_FOCUS_STATE;
  }
}

// 类型面与常量（含 EMPTY_INDEX_DIRECTORY / IDLE_INDEX_FOCUS_STATE）统一从 types 模块
// 转出，保持单一再导出路径：消费者既可 import 本模块也可 import types 模块。
export * from "@/v4/conversationIndexFocusTypes.js";
