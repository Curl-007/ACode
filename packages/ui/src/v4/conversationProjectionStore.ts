/* eslint-disable max-lines -- projection/base/recovery/optimistic 必须共享一个原子 store 状态机，拆分会重新引入跨对象竞态。 */
// Per-session projection store（只读 projection store）。
// 唯一写入方是订阅推送；UI 只读。客户端遵守三条规则：
//   1. snapshot → 整体替换，绝不 merge；
//   2. delta 帧仅在区间衔接（frame.fromSeq === snapshot.seq）时 apply，断档不猜、不缓存补偿；
//   3. base 与状态同生共死——断档时状态未被污染，携当前水位重订阅，由服务端裁决 resume/snapshot。
// 除 optimistic overlay（pending 命令展示）外，本 store 不产生任何 conversation 事实。
import {
  applyConversationDeltas,
  isDeterministicContentFault,
  parseConversationTopic,
  PROTOCOL_V4_LIMITS,
  readPendingInteractionHints,
  SUBSCRIPTION_CONTENT_REJECTED,
  type ConversationRow,
  type ConversationSnapshot,
  type ConversationTopicFrame,
  type SessionModelTransition,
  type ToolCallRow,
  type TopicFrameDeliveryKind,
} from "@acode/shared/acode-protocol-v4";
import { logger } from "@/logger.js";
import type { ConversationTurnNavigatorHydrationResult } from "@/v4/conversationTurnNavigatorHelpers.js";
import type { ConversationTransport } from "@/v4/transport.js";
import type { TurnIndexEntry } from "@/v4/conversationTurnIndex.js";
import { ConversationTurnIndex } from "@/v4/conversationTurnIndex.js";
import {
  ConversationIndexFocusController,
  EMPTY_INDEX_DIRECTORY,
  IDLE_INDEX_FOCUS_STATE,
  type IndexFocusResult,
  type IndexFocusState,
  type IndexFocusTarget,
} from "@/v4/conversationIndexFocusController.js";
import {
  closedIndexFocusResult,
  createIndexFocusController,
} from "@/v4/conversationIndexFocusStoreAdapter.js";
import type { IndexFocusRowsRangeParams } from "@/v4/conversationIndexFocusTypes.js";
import type { IndexDirectory } from "@/v4/conversationIndexNavigation.js";
import { uiMemoryDiagnosticsRegistry } from "@/lib/memoryDiagnostics.js";

/**
 * runtime 换代打断 subscribe 后的退避节奏。
 *
 * CUA Helper 冷启动就绪会 recycleUntilStable → disposeWorkspace 回收 agent
 * runtime，在途 subscribe 被 rejectAll 打断。若把这次瞬态失败定格成 status="error"，
 * 懒启动的 agent 在 dispose 后可能无人拉起，onRuntimeRestart 就不会到达，面板只能靠用户
 * 手点「重新连接」。subscribeConversationV4 走 start-if-needed，重订阅自身会拉起 runtime，
 * 所以这里按 sessionsIndexStore 的既定模式做有界退避。
 */
const RUNTIME_RECYCLE_RETRY_DELAYS_MS = [250, 1_000, 3_000] as const;

/**
 * accepted ACK 后等待权威输入投影的宽限期。
 *
 * Core admission 的 ACK 不等待 TurnStarted/QueueItem/userInput 投影；正常情况下这两条
 * 路径只相差一个 renderer/network round-trip。把窗口设为 2s 可以覆盖正常 desktop/mobile
 * 延迟，又能尽快从“CLI 继续工作、订阅完全静默”的半开通道自愈。超时只恢复订阅，不重放命令。
 */
const ACCEPTED_INPUT_PROJECTION_GRACE_MS = 2_000;
const ACCEPTED_INPUT_COMMAND_TYPES = new Set(["sendText"]);

/** 退避耗尽时展示给用户的 lastError（无底层 error 对象可引用的换代路径）。 */
const RUNTIME_RECYCLED_ERROR = "ACode agent runtime 已被回收，重连未成功";

function monotonicNow(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function roundedDuration(startedAt: number, endedAt: number): number {
  return Math.max(0, Math.round(endedAt - startedAt));
}

/**
 * 是否为 runtime 换代/回收导致的瞬态 subscribe 失败。
 *
 * 三种文案都来自同一次回收：transport 关闭时 ACodeProtocolClient.rejectAll 打断在途请求
 * （transport closed），复用已回收 client 时 assertNotDisposed 早退（client disposed），
 * 以及 runtime 尚未重新拉起时的 fail-fast（runtime is not running）。
 */
function isRuntimeRecycleError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    // 冷订阅可能亲自拉起新 runtime；restart 令在途 ACK 失效后仍须有界重订，不能停在 error。
    message.includes("fault.subscription.runtimeRestarted") ||
    message.includes("ACode agent transport closed") ||
    message.includes("ACode Protocol client disposed") ||
    message.includes("ACode Protocol client is disposed") ||
    message.includes("ACode Agent runtime is not running")
  );
}

function hasAcceptedInputProjection(
  snapshot: ConversationSnapshot | null,
  commandId: string,
): boolean {
  if (!snapshot) return false;
  if (snapshot.queue.items.some((item) => item.sourceCommandId === commandId)) return true;
  return snapshot.rows.window.some(
    (row) =>
      row.kind === "userInput" && row.origin === "realUser" && row.sourceCommandId === commandId,
  );
}

export type ConversationStoreStatus =
  // subscribe 在途（首连或断档重订阅）。
  | "connecting"
  // 已订阅且帧连续。
  | "live"
  // subscribe 失败，等待 retry()。
  | "error"
  // 已释放（SessionDataLayer 退订后），不再接受任何操作。
  | "closed";

/** optimistic overlay 条目：命令已上行、服务端尚未在投影中确认。 */
export interface OptimisticCommand {
  commandId: string;
  type: string;
  issuedAt: number;
}

export interface ConversationStoreState {
  status: ConversationStoreStatus;
  snapshot: ConversationSnapshot | null;
  subscriptionId: string | null;
  lastError: string | null;
  optimisticCommands: readonly OptimisticCommand[];
  /** loadOlder 在途标记（自动预取防重入）。 */
  loadingOlder: boolean;
  /** CLI 完整有效 projection 返回的终态计划目录。 */
  sessionPlans: readonly ToolCallRow[];
  /** 只用于触发计划目录只读 query，不属于 conversation 协议事实。 */
  planDirectoryRevision: number;
  plansLoading: boolean;
  /**
   * 问题导航目录（turn navigator）的失效代际。
   * not-enough-queries 终态过去只以 logEpoch 判定有效，但
   * "是否已有 ≥2 条可导航 query"是随增量变化的派生条件，logEpoch 表示日志代际而非
   * 内容静止。real-user query 增删（row.appended/row.upserted 命中 realUser userInput，
   * 或 row.removed 截断分支）与 snapshot 整体替换时递增此 revision，使终态缓存失效。
   */
  turnNavigatorDirectoryRevision: number;
}

const INITIAL_STATE: ConversationStoreState = {
  status: "connecting",
  snapshot: null,
  subscriptionId: null,
  lastError: null,
  optimisticCommands: [],
  loadingOlder: false,
  sessionPlans: [],
  planDirectoryRevision: 0,
  plansLoading: false,
  turnNavigatorDirectoryRevision: 0,
};

// 帧分类纯函数（目录失效裁决 + subagent 跃迁日志 + 权威裁剪边界）外迁到
// conversationProjectionFrames.ts（本文件已在 legacy ratchet 基线上、超限只减不增，
// U07 历史焦点需要腾出行数）。
import {
  earliestRemovedFromRowId,
  logSubagentProjectionTransition,
  shouldInvalidatePlanDirectory,
  shouldInvalidateTurnNavigatorDirectory,
} from "@/v4/conversationProjectionFrames.js";

// 投影窗口双上限、字节估算与分页纯函数外迁到 conversationProjectionWindow.ts
// （本文件已在 legacy ratchet 基线上、超限只减不增，U07 历史焦点需要腾出行数）。
// 这里按原名再导出，保持既有 import 面（SessionPane / tests）逐字不变。
export {
  PROJECTION_WINDOW_MAX_ROWS,
  PROJECTION_WINDOW_MAX_BYTES,
  estimateRowBytes,
  trimProjectionWindowToLimits,
  hasOlderRows,
  shouldAutoLoadIncompleteLeadingTurn,
  withProjectionWindowLimits,
  mergeOlderRows,
  type TrimmedProjectionWindow,
} from "@/v4/conversationProjectionWindow.js";
import {
  PROJECTION_WINDOW_MAX_ROWS,
  PROJECTION_WINDOW_MAX_BYTES,
  estimateRowBytes,
  hasOlderRows,
  mergeOlderRows,
  shouldAutoLoadIncompleteLeadingTurn,
  trimProjectionWindowToLimits,
  withProjectionWindowLimits,
} from "@/v4/conversationProjectionWindow.js";

/**
 * 外部 store（useSyncExternalStore 兼容：subscribe + getState 返回稳定引用）。
 * 生命周期由 SessionDataLayer 管（引用计数 + keep-warm），组件不直接 new。
 */
// 内存诊断计数器：统计存活 store 数与其 rows.window 行数之和，
// 用于观察窗口数据的内存增长。构造时加入、close() 时移除。
const liveProjectionStores = new Set<ConversationProjectionStore>();

export interface LiveProjectionStoreSummary {
  stores: number;
  rows: number;
  turnIndexEntries: number;
  turnIndexEvictions: number;
  turnIndexBytes: number;
}

/**
 * 存活 projection store 的只读汇总（内存诊断计数器与内容状态面包屑采样共用）。
 * 面包屑采样在 interval 里跑，刻意不走 uiMemoryDiagnosticsRegistry.collect()：
 * collect 会逐个调用全部 provider（shiki/xterm/taskQueryCache 等），采样动作本身
 * 就成了它要归因的同步段开销。这里只遍历 projection store（典型 1-3 个）。
 */
export function summarizeLiveProjectionStores(): LiveProjectionStoreSummary {
  let rows = 0;
  let turnIndexEntries = 0;
  let turnIndexEvictions = 0;
  let turnIndexBytes = 0;
  for (const store of liveProjectionStores) {
    rows += store.countProjectionRows();
    turnIndexEntries += store.turnIndexSize();
    turnIndexEvictions += store.turnIndexEvictionCount();
    turnIndexBytes += store.turnIndexByteEstimate();
  }
  return {
    stores: liveProjectionStores.size,
    rows,
    turnIndexEntries,
    turnIndexEvictions,
    turnIndexBytes,
  };
}

uiMemoryDiagnosticsRegistry.register(
  "projection",
  (): Record<string, number> => ({
    ...summarizeLiveProjectionStores(),
  }),
);

export class ConversationProjectionStore {
  private state: ConversationStoreState = INITIAL_STATE;
  private readonly listeners = new Set<() => void>();
  private readonly modelTransitionListeners = new Set<
    (transition: SessionModelTransition) => void
  >();
  private observedModelTransitionEventId: string | null = null;
  // 订阅代际：并发 connect 只认最新一代，过期结果立即退订防服务端悬挂。
  private generation = 0;
  // 首次订阅尚未拿到 ACK 时，runtime available 只是当前启动流程的正常完成信号；
  // 记录在途数量，避免生命周期通知再次启动 connect，制造同 topic 的订阅替换竞态。
  private connectInFlight = 0;
  /**
   * subscribe ACK mode 持久到该代首个 logical frame；不能只依赖同步 activate 栈，
   * 因为 notification 可在 ACK Promise resolve 后异步到达。
   */
  private awaitingInitial: { subscriptionId: string; mode: "snapshot" | "resume" } | null = null;
  /** 当前 subscription 是否已由旧 applied base 或本代 logical frame 证明水位有效。 */
  private subscriptionHasAppliedBase = false;
  private recovery: {
    subscriptionId: string;
    requestInFlight: boolean;
    ackReceived: boolean;
    validFrameSeen: boolean;
    upgradePending: boolean;
    ackMode: "snapshot" | "resume" | null;
    forceSnapshot: boolean;
    postRecoveryGapPending: boolean;
    frameDeadline: ReturnType<typeof setTimeout> | null;
    /** 本次 flight 是为内容确定性失败发起的：终态用 contentRejected，不混进瞬态统计。 */
    contentFault: boolean;
  } | null = null;
  private readonly offAssemblyFault: () => void;
  private readonly offRuntimeRestart: (() => void) | null = null;
  private readonly offRuntimeLifecycle: (() => void) | null = null;
  private runtimeRecycleRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private runtimeRecycleRetryAttempt = 0;
  private planQueryInFlight = false;
  private planQueryPending = false;
  /** accepted input 的 projection confirmation watchdog；不承载命令，也不生成本地事实。 */
  private readonly acceptedInputProjectionTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // hydrated/not-enough-queries 终态缓存。过去仅以
  // logEpoch 判定有效，同一 epoch 内追加 real-user query 后仍永久命中。现追加
  // directoryRevision——real-user query 增删会递增该 revision，使终态失效重探测。
  private turnNavigatorHydrationTerminal:
    | (Extract<
        ConversationTurnNavigatorHydrationResult,
        { status: "hydrated" | "not-enough-queries" }
      > & { directoryRevision: number })
    | null = null;
  /**
   * turn 轻量索引（specs/renderer-memory-budget.md 所有者表）：行进入窗口时登记
   * （含随后被窗口双上限裁剪掉的行），供窗口外 turn 的目录感知与按需回拉；
   * 上限 TURN_INDEX_MAX_ENTRIES 条、超限丢最旧，close() 时与窗口一并释放。
   */
  private readonly turnIndex = new ConversationTurnIndex();
  /**
   * U07 历史焦点控制器（specs/conversation-index-navigation.md）。
   *
   * 懒建：构造期 `this` 尚未就绪，而控制器需要以闭包读取 store 的私有代际/快照。
   * 它是**派生只读视图**的唯一载体，不产生 conversation 事实；与尾部共享同一个
   * 1200 行 / 32 MiB 信封（不是各留一份再相加）。
   */
  private indexFocusController: ConversationIndexFocusController | null = null;
  private closed = false;

  constructor(
    readonly topic: string,
    private readonly transport: ConversationTransport,
  ) {
    liveProjectionStores.add(this);
    this.offAssemblyFault = transport.onAssemblyFault((fault) => {
      if (fault.topic === this.topic) {
        this.handleAssemblyFault(fault.subscriptionId, fault.deliveryKind, fault.reasonCode);
      }
    });
    // runtime 换代（CLI 进程换代）按 sessionsIndexStore 的约定优先走 lifecycle：dispose
    // 当场只有 unavailable 可观测，onRuntimeRestart 要等新进程 spawn——懒启动下可能永不到达。
    if (transport.onRuntimeLifecycle) {
      this.offRuntimeLifecycle = transport.onRuntimeLifecycle((state) => {
        if (state === "available") this.handleRuntimeAvailable();
        else this.handleRuntimeUnavailable();
      });
      // proxy handoff 不是 runtime 换代，只有 restart 通道携带该语义——
      // ReplaceableConversationTransport.replace() 只广播 runtimeRestartListeners，不发任何
      // lifecycle 事件。若这里因"二选一"完全放弃 restart 通道，远程 workspace 的 proxy 换代
      // 就无人接收：replace() 已 best-effort 退订旧 proxy 的订阅，store 却停在 live + 旧
      // subscriptionId，帧流静默中断且不自愈。
      // 只认 transportReplaced 即可两不重叠：底层 runtime restart 经 bindRuntimeRestartListener
      // 转发时调的是 listener()（reason 为 undefined），已由 lifecycle 的 available 接管。
      this.offRuntimeRestart = transport.onRuntimeRestart((reason) => {
        if (reason !== "transportReplaced") return;
        this.handleRuntimeRestart(reason);
      });
    } else {
      this.offRuntimeRestart = transport.onRuntimeRestart((reason) =>
        this.handleRuntimeRestart(reason),
      );
    }
  }

  getState(): ConversationStoreState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onOnlineModelTransition(listener: (transition: SessionModelTransition) => void): () => void {
    this.modelTransitionListeners.add(listener);
    return () => this.modelTransitionListeners.delete(listener);
  }

  private setState(patch: Partial<ConversationStoreState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  /**
   * 发起/重发订阅。base 取自当前 snapshot 水位（水位不变量：仅当真持有该时刻
   * 一致状态才携带）；forceSnapshot 用于 resume 续传帧仍断档的兜底，丢 base 要全量。
   */
  async connect(
    options: {
      forceSnapshot?: boolean;
      initialOverflowRetry?: boolean;
    } = {},
  ): Promise<void> {
    if (this.closed) return;
    const generation = ++this.generation;
    this.discardRecovery();
    const snapshot = options.forceSnapshot ? null : this.state.snapshot;
    const subscribeStartedAt = monotonicNow();
    logger.lifecycle.info("v4 conversation store connect started", {
      event: "v4.conversation.store.connect.started",
      generation,
      hasBase: Boolean(snapshot),
      module: "ui.v4.conversation_projection_store",
      status: "started",
      topic: this.topic,
    });
    this.connectInFlight += 1;
    this.setState({ status: "connecting" });
    try {
      const result = await this.transport.subscribe({
        topic: this.topic,
        base: snapshot ? { logEpoch: snapshot.logEpoch, seq: snapshot.seq } : undefined,
      });
      if (generation !== this.generation || this.closed) {
        // 过期代际：这份订阅已无人消费，立即退订。
        logger.lifecycle.warn("v4 conversation store connect ACK became stale", {
          event: "v4.conversation.store.connect.stale_ack",
          generation,
          currentGeneration: this.generation,
          module: "ui.v4.conversation_projection_store",
          status: "failed",
          subscriptionId: result.ack.subscriptionId,
          topic: this.topic,
        });
        void this.transport.unsubscribe(result.ack.subscriptionId);
        return;
      }
      // 线上 fault.subscription.notOwned 卡死的根因：connect() 只在发起时
      // discardRecovery，subscribe ACK 的 await 窗口内旧订阅仍可能创建 same-sub recovery；
      // 而 host scope 在新 ACK remember() 时已按 ownershipKey 静默驱逐旧订阅，该 recovery
      // 的在途 resync 注定被 notOwned 拒绝。换代成功即丢弃旧 recovery——新订阅的 initial
      // 会原子替换整个投影，旧恢复流已无意义；否则其迟到失败会把 live 的新订阅打成 error。
      this.discardRecovery();
      this.runtimeRecycleRetryAttempt = 0;
      this.setState({
        status: "live",
        subscriptionId: result.ack.subscriptionId,
        lastError: null,
      });
      this.subscriptionHasAppliedBase = Boolean(
        snapshot && result.ack.mode === "resume" && result.ack.logEpoch === snapshot.logEpoch,
      );
      // 公共 result 已是 ACK-only；initial 与 online 统一走 notification。
      // subscriptionId 必须先入 store，activate 才能同步释放同一 read 中暂存的 own initial。
      this.awaitingInitial = {
        subscriptionId: result.ack.subscriptionId,
        mode: result.ack.mode,
      };
      this.transport.activate(result.ack.subscriptionId);
      // attach 链路判代（apps/acode-cli/specs/protocol-attachment-typed-errors.md R5 /
      // 接线 W4）：ack 上 pendingInteractionHints 的**字段存在性**是响应级判代探针，唯一
      // 读法 readPendingInteractionHints（services 侧 acodeAgentService 同款判代已透传原
      // ack）。hints 只是提示性引用：本 store 的 pendingInteractions 水合权威源恒为随后
      // initial snapshot 帧（整体替换），故这里零状态写入，仅把「对端是老世代 CLI」记成
      // debug 诊断——缺席不得推断成「无 pending」，也禁止用 wire 版本反推字段存在性。
      const pendingHintsReading = readPendingInteractionHints(result.ack);
      if (pendingHintsReading.generation === "legacy") {
        logger.debug(
          `[v4-store] subscribe ack 缺少 pendingInteractionHints 字段（老世代 CLI）: ${this.topic}`,
          {
            event: "v4.conversation.store.pending_hints_legacy",
            generation,
            subscriptionId: result.ack.subscriptionId,
            topic: this.topic,
          },
        );
      }
      logger.lifecycle.info("v4 conversation store connect completed", {
        durationMs: roundedDuration(subscribeStartedAt, monotonicNow()),
        event: "v4.conversation.store.connect.completed",
        generation,
        logEpoch: result.ack.logEpoch,
        mode: result.ack.mode,
        module: "ui.v4.conversation_projection_store",
        status: "completed",
        subscriptionId: result.ack.subscriptionId,
        topic: this.topic,
      });
    } catch (error) {
      if (generation !== this.generation || this.closed) return;
      const message = error instanceof Error ? error.message : String(error);
      this.awaitingInitial = null;
      this.subscriptionHasAppliedBase = false;
      if (
        message.includes("fault.subscription.initialFrameStagingOverflow") &&
        !options.initialOverflowRetry
      ) {
        // ACK 前 physical batch 已残缺，active same-sub 尚不存在；只能 fresh
        // subscribe 强制 snapshot。最多自动一次，避免异常 peer 造成重试风暴。
        await this.connect({ forceSnapshot: true, initialOverflowRetry: true });
        return;
      }
      if (this.scheduleRuntimeRecycleRetry(error, generation)) {
        logger.lifecycle.warn("v4 conversation store connect retry scheduled", {
          durationMs: roundedDuration(subscribeStartedAt, monotonicNow()),
          errorMessage: message,
          event: "v4.conversation.store.connect.retry_scheduled",
          generation,
          module: "ui.v4.conversation_projection_store",
          status: "retrying",
          topic: this.topic,
        });
        logger.warn(`[v4-store] subscribe ${this.topic} 被 runtime 换代打断，退避重连: ${message}`);
        return;
      }
      logger.lifecycle.warn("v4 conversation store connect failed", {
        durationMs: roundedDuration(subscribeStartedAt, monotonicNow()),
        errorMessage: message,
        event: "v4.conversation.store.connect.failed",
        generation,
        module: "ui.v4.conversation_projection_store",
        status: "failed",
        topic: this.topic,
      });
      logger.warn(`[v4-store] subscribe ${this.topic} 失败: ${message}`);
      this.setState({ status: "error", lastError: message });
    } finally {
      this.connectInFlight -= 1;
    }
  }

  private clearRuntimeRecycleRetry(): void {
    if (this.runtimeRecycleRetryTimer === null) return;
    clearTimeout(this.runtimeRecycleRetryTimer);
    this.runtimeRecycleRetryTimer = null;
  }

  /**
   * runtime 换代导致的 subscribe 失败：保持 connecting 并有界退避重连。
   * 返回 true 表示已接管本次失败，调用方不应再落 error。
   */
  private scheduleRuntimeRecycleRetry(error: unknown, generation: number): boolean {
    if (!isRuntimeRecycleError(error)) return false;
    return this.scheduleRuntimeRecycleReconnect(generation);
  }

  /**
   * 有界退避重连。重订阅走 start-if-needed（acodeAgentService.subscribeConversationV4），
   * 自身即可把懒启动的 runtime 拉起来——这是 available 永不到达时唯一的自愈路径。
   * 返回 true 表示已接管，调用方不应再落 error。
   */
  private scheduleRuntimeRecycleReconnect(generation: number): boolean {
    if (this.closed) return false;
    const delayMs = RUNTIME_RECYCLE_RETRY_DELAYS_MS[this.runtimeRecycleRetryAttempt];
    if (delayMs === undefined) return false;
    this.runtimeRecycleRetryAttempt += 1;
    this.clearRuntimeRecycleRetry();
    // 保留旧 snapshot：换代期间投影未被污染，重连成功会原子替换。
    this.setState({ status: "connecting" });
    this.runtimeRecycleRetryTimer = setTimeout(() => {
      this.runtimeRecycleRetryTimer = null;
      if (this.closed || generation !== this.generation) return;
      void this.connect();
    }, delayMs);
    return true;
  }

  /** workspace-dispose 当场：旧 runtime 已死，新的尚不存在，不可重订阅。 */
  private handleRuntimeUnavailable(): void {
    if (this.closed) return;
    this.clearRuntimeRecycleRetry();
    this.discardRecovery();
    this.awaitingInitial = null;
    this.subscriptionHasAppliedBase = false;
    this.generation += 1;
    // 旧 subscriptionId 属于已死 runtime，不得再 unsubscribe（host 侧 owner 已失效）。
    this.setState({ status: "connecting", subscriptionId: null });
    // 不能只 dormant 等 available：agent 懒启动，dispose 后无人拉起时该信号永不到达，
    // 面板会永久转圈。退避重连自身会拉起 runtime；available 先到则复位计数并即时重连。
    if (this.scheduleRuntimeRecycleReconnect(this.generation)) return;
    // 退避额度耗尽（runtime 反复回收）：必须落 error 暴露「重新连接」入口，
    // 否则 connecting 无 timer 就是永久转圈，连手动重试都没有。
    this.setState({ status: "error", lastError: RUNTIME_RECYCLED_ERROR });
  }

  /** 新 runtime 就绪：与 onRuntimeRestart 同义，携原水位重订阅。 */
  private handleRuntimeAvailable(): void {
    if (this.closed) return;
    this.clearRuntimeRecycleRetry();
    this.runtimeRecycleRetryAttempt = 0;
    if (this.connectInFlight > 0) {
      // 冷启动 spawn 会在首次 subscribe ACK
      // 返回前广播 available。若这里立即再 connect，服务端会按同一 connection/topic
      // 替换旧订阅；旧 ACK 随即被本地代际防护退订，首帧交接存在竞态，面板可能永久无快照。
      // 当前在途 connect 已经负责完成这次启动，不需要重复重订阅。
      return;
    }
    this.handleRuntimeRestart("runtimeRestart");
  }

  /** 订阅失败后的手动重试入口（pane 层「重新连接」按钮落点）。 */
  retry(): Promise<void> {
    this.clearRuntimeRecycleRetry();
    this.runtimeRecycleRetryAttempt = 0;
    return this.connect();
  }

  /** row command/query 的 epoch/entity authority 失效，复用 same-sub recovery 收敛。 */
  recoverFromStaleAuthority(): void {
    this.requestRecovery();
  }

  /** SessionDataLayer 帧路由入口。 */
  handleFrame(
    frame: ConversationTopicFrame,
    delivery?: { deliveryKind: TopicFrameDeliveryKind },
  ): void {
    if (this.closed) return;
    // 代际防护：旧订阅的迟到帧直接丢弃。
    if (frame.subscriptionId !== this.state.subscriptionId) return;
    const awaitingInitial =
      this.awaitingInitial?.subscriptionId === frame.subscriptionId ? this.awaitingInitial : null;
    const deliveryKind = delivery?.deliveryKind ?? "online";
    // RPC 时序无法证明帧用途。只有 publisher 标记的 initial 才消费
    // awaitingInitial；recovery 必须优先清除此状态，避免 recovery gap 被误判为
    // original subscribe gap 而换新 subId。迟到 online duplicate 不得消费任何闸门。
    const initial = deliveryKind === "initial" ? awaitingInitial : null;
    if (initial || (deliveryKind === "recovery" && awaitingInitial)) {
      this.awaitingInitial = null;
    }
    if (deliveryKind === "online" && this.recovery && frame.payload.kind === "snapshot") {
      // online overflow snapshot 本身是完整权威状态，可建立 applied base；但它不冒充
      // recovery delivery，flight 仍等待自己的 recovery frame/ACK 收口。
      this.applyFrame(frame, { subscribeMode: null, recovery: false, online: true });
      return;
    }
    if (deliveryKind === "online" && this.recovery) {
      // recovery reservation 之后的 online 可能与 ACK 同 read 到达；在 recovery
      // logical frame 已 apply 后看到非重复 online，ACK 收口时必须再开 successor flight。
      if (frame.toSeq > (this.state.snapshot?.seq ?? 0)) {
        this.recovery.postRecoveryGapPending ||= this.recovery.validFrameSeen;
      }
      return;
    }
    if (frame.payload.kind === "deltas" && !this.subscriptionHasAppliedBase) {
      // ACK(snapshot) 不构成 applied base；initial 丢失后即便数值 fromSeq 恰好
      // 对上旧 projection，也不能把新 epoch delta 拼到旧状态。
      this.requestRecovery(deliveryKind === "recovery");
      return;
    }
    this.applyFrame(frame, {
      subscribeMode: initial?.mode ?? null,
      recovery: deliveryKind === "recovery",
      online: deliveryKind === "online",
    });
  }

  private applyFrame(
    frame: ConversationTopicFrame,
    context: {
      subscribeMode: "snapshot" | "resume" | null;
      recovery: boolean;
      online: boolean;
    },
  ): void {
    if (frame.payload.kind === "snapshot") {
      const hadAppliedBase = this.subscriptionHasAppliedBase;
      logSubagentProjectionTransition(
        this.topic,
        this.state.snapshot,
        frame.payload.snapshot,
        "snapshot",
      );
      // 行进入窗口前先登记 turn 索引（含随后被双上限裁剪的行）。
      // 规则 1：整体替换，扔掉手里的一切换新的；替换后的窗口同样执行双上限裁剪。
      this.registerSnapshotRowsInTurnIndex(frame.payload.snapshot);
      const committedSnapshot = withProjectionWindowLimits(frame.payload.snapshot);
      this.setState({
        snapshot: committedSnapshot,
        planDirectoryRevision: this.state.planDirectoryRevision + 1,
        // snapshot 整体替换后 real-user query 集合可能已变，终态缓存必须失效。
        turnNavigatorDirectoryRevision: this.state.turnNavigatorDirectoryRevision + 1,
      });
      this.subscriptionHasAppliedBase = true;
      this.reconcileOptimistic(committedSnapshot);
      this.reconcileAcceptedInputProjection(committedSnapshot);
      // U07：snapshot 整体替换会把权威尾部换成一份全新窗口，其首行可能落到焦点正文
      // 区间内。若不重算，焦点与尾部会出现重复 rowId（U07-A2「没有重复行」）。
      this.reconcileIndexFocusAgainstTail();
      // initial 丢失时，publisher 允许完整 online snapshot 建立首个
      // applied base；其中的持久 transition 可能早于本次订阅，不能冒充实时新事件。
      // 首帧只播种观察基线，后续 online 跃迁才通知 pane。
      this.observeModelTransition(committedSnapshot, context.online && hadAppliedBase);
      if (context.recovery) this.markRecoveryFrameSeen();
      return;
    }
    const current = this.state.snapshot;
    // 规则 2a：迟到/重复 logical frame 永远静默丢弃。若它是 ACK 后的 aligned
    // recovery `(N,N]`，则只收口 flight，不重复 apply。
    if (current && frame.toSeq <= current.seq) {
      if (context.recovery) this.markRecoveryFrameSeen();
      return;
    }
    if (!current || frame.fromSeq !== current.seq) {
      // 规则 2：断档不猜。状态本身仍是 seq=current.seq 时刻的一致投影（这帧没碰它），
      // 所以 base 仍合法——重订阅让服务端裁决续传或全量；若断档发生在 subscribe 的
      // resume 续传帧上（服务端已裁决过一次仍不衔接），丢 base 强制 snapshot 防循环。
      logger.warn(
        `[v4-store] ${this.topic} 帧断档 fromSeq=${frame.fromSeq} local=${current?.seq ?? "none"}，重订阅`,
      );
      if (context.subscribeMode !== null) {
        // fresh subscribe 的 resume initial 仍断档，换代订阅强制 snapshot；active
        // subscription 的 online/recovery gap 则保持 same-sub。
        void this.connect({ forceSnapshot: true });
      } else {
        this.requestRecovery(context.recovery);
      }
      return;
    }
    const applied = applyConversationDeltas(current, frame.payload.deltas);
    // seq 是快照对齐水位，delta 帧应用完推进到帧右端点。
    const next = { ...applied, seq: frame.toSeq };
    logSubagentProjectionTransition(this.topic, current, next, "deltas");
    // 行进入窗口即登记 turn 索引（row.upserted 按 rowId 去重）；登记先于下方窗口裁剪，
    // 被双上限裁掉的行仍保留「窗口外 turn」的目录与回拉依据。
    for (const delta of frame.payload.deltas) {
      if (delta.op === "row.appended" || delta.op === "row.upserted") {
        this.turnIndex.addRow(delta.row);
      }
    }
    const removedFromRowId = earliestRemovedFromRowId(frame);
    if (removedFromRowId !== null) {
      // U07：索引与聚焦一起失效（specs/conversation-index-navigation.md U07-A4）。
      // 目录过去只按「登记序」增长，rewind/edit 移除的 query 仍留在索引里，
      // 于是目录继续提供已不存在的入口、点击后定位到旧分支正文。
      // 这里按权威裁剪边界同步删条目（与 apply.ts 的 row.removed 同一语义）。
      const pruned = this.turnIndex.pruneFrom(removedFromRowId);
      if (pruned > 0) {
        logger.debug("[v4-store] row.removed 同步裁剪 turn 索引", {
          fromRowId: removedFromRowId,
          prunedEntries: pruned,
          topic: this.topic,
        });
      }
      // 焦点目标若落在被裁区间内，定位已不可达：作废焦点与在途请求，
      // 收敛为确定的 target-missing 终态，不做无限重试（U07-A4）。
      this.indexFocusController?.invalidateTarget(removedFromRowId);
    }
    this.setState({
      snapshot: withProjectionWindowLimits(next),
      // row.removed 已给出权威裁剪边界，可以同步删掉缓存目录中的旧分支计划；
      // 完整 query 继续负责补回 wire tail 之外、但仍属于当前分支的早期计划。
      ...(removedFromRowId === null
        ? {}
        : {
            sessionPlans: this.state.sessionPlans.filter((row) => row.rowId < removedFromRowId),
          }),
      ...(shouldInvalidatePlanDirectory(frame)
        ? { planDirectoryRevision: this.state.planDirectoryRevision + 1 }
        : {}),
      // real-user query 增删（row.appended/row.upserted 命中 realUser userInput，
      // 或 row.removed 截断分支）递增导航目录 revision，使终态缓存失效允许重新探测。
      ...(shouldInvalidateTurnNavigatorDirectory(frame)
        ? {
            turnNavigatorDirectoryRevision: this.state.turnNavigatorDirectoryRevision + 1,
          }
        : {}),
    });
    this.subscriptionHasAppliedBase = true;
    this.reconcileOptimistic(next);
    this.reconcileAcceptedInputProjection(next);
    this.observeModelTransition(next, context.online);
    if (context.recovery) this.markRecoveryFrameSeen();
  }

  private observeModelTransition(snapshot: ConversationSnapshot, online: boolean): void {
    const transition = snapshot.modelTransition;
    const eventId = transition?.eventId ?? null;
    if (eventId === this.observedModelTransitionEventId) return;
    // 持久 transition 会随 initial/recovery snapshot 重放；若只在 toast 时记 ID，
    // 后续普通 online snapshot 会把旧 fallback 误当新事件。所有合法帧都更新观察基线，
    // 只有首次实时 online 跃迁才通知当前客户端。
    this.observedModelTransitionEventId = eventId;
    if (!online || !transition) return;
    for (const listener of this.modelTransitionListeners) listener(transition);
  }

  /** physical assembly fault：旧 projection 保持可见，active sub 上 single-flight 恢复。 */
  handleAssemblyFault(
    subscriptionId: string,
    deliveryKind?: TopicFrameDeliveryKind,
    reasonCode?: string,
  ): void {
    if (this.closed || subscriptionId !== this.state.subscriptionId) return;
    if (
      this.awaitingInitial?.subscriptionId === subscriptionId &&
      (deliveryKind === "initial" || deliveryKind === "recovery" || deliveryKind === undefined)
    ) {
      this.awaitingInitial = null;
    }
    // 内容确定性失败不进瞬态阶梯（04-sync 封闭规则 11）：resume 只会把同一批 delta 再投一遍，
    // 必然再被拒；deliveryKind 也不改变结论——本端读不懂这份内容。唯一可能产出不同字节的是
    // 强制 snapshot，所以直接跳到它，它再被内容拒绝就停手，不把订阅烧在必然失败的重试上。
    if (isDeterministicContentFault(reasonCode)) {
      this.requestRecovery(true, { contentFault: true });
      return;
    }
    // 缺失/伪 deliveryKind 会以 undefined typed fault 到达；若 recovery 已在途，
    // 必须 fail closed/升级，不能把坏 recovery 当普通 burst 后永远等待。
    const recoveryFault =
      deliveryKind === "recovery" || (deliveryKind === undefined && this.recovery !== null);
    if (deliveryKind === "online" && this.recovery) {
      this.recovery.postRecoveryGapPending ||= this.recovery.validFrameSeen;
      return;
    }
    this.requestRecovery(recoveryFault);
  }

  private requestRecovery(recoveryEvent = false, options: { contentFault?: boolean } = {}): void {
    if (this.closed) return;
    const subscriptionId = this.state.subscriptionId;
    if (!subscriptionId) {
      void this.connect({ forceSnapshot: true });
      return;
    }
    const contentFault = options.contentFault === true;
    const existing = this.recovery;
    if (existing) {
      // 一旦本次 flight 里出现过内容失败，终态就归内容失败：后续瞬态 fault 不该把它洗白。
      if (contentFault) existing.contentFault = true;
      if (!recoveryEvent) return;
      if (existing.forceSnapshot) {
        this.failRecovery("fault.subscription.recoveryFailed");
        return;
      }
      // recovery logical/fault 可早于 ACK Promise continuation；记住升级意图，
      // ACK=resume 后立即 force snapshot。普通 burst gap 不设置此标记。
      if (existing.requestInFlight || !existing.ackReceived) {
        existing.upgradePending = true;
        return;
      }
      if (existing.ackMode === "resume") this.issueRecovery(existing, true);
      else this.failRecovery("fault.subscription.recoveryFailed");
      return;
    }
    const recovery = {
      subscriptionId,
      requestInFlight: false,
      ackReceived: false,
      validFrameSeen: false,
      upgradePending: false,
      ackMode: null,
      forceSnapshot: false,
      postRecoveryGapPending: false,
      frameDeadline: null,
      contentFault,
    };
    this.recovery = recovery;
    // 内容失败跳过 resume 档直接强制 snapshot；瞬态失败仍按原阶梯先试 resume。
    this.issueRecovery(recovery, contentFault);
  }

  private issueRecovery(
    recovery: NonNullable<ConversationProjectionStore["recovery"]>,
    forceSnapshot: boolean,
  ): void {
    this.clearRecoveryDeadline(recovery);
    const snapshot = this.state.snapshot;
    const effectiveForceSnapshot = forceSnapshot || !this.subscriptionHasAppliedBase;
    recovery.requestInFlight = true;
    recovery.ackReceived = false;
    recovery.ackMode = null;
    recovery.upgradePending = false;
    recovery.validFrameSeen = false;
    recovery.forceSnapshot = effectiveForceSnapshot;
    recovery.postRecoveryGapPending = false;
    void this.transport
      .resync({
        subscriptionId: recovery.subscriptionId,
        base:
          this.subscriptionHasAppliedBase && snapshot
            ? { logEpoch: snapshot.logEpoch, seq: snapshot.seq }
            : null,
        ...(effectiveForceSnapshot ? { forceSnapshot: true } : {}),
      })
      .then((result) => {
        if (this.closed || this.recovery !== recovery) return;
        if (result.ack.subscriptionId !== recovery.subscriptionId) {
          throw new Error("fault.subscription.resyncGenerationMismatch");
        }
        recovery.requestInFlight = false;
        recovery.ackReceived = true;
        recovery.ackMode = result.ack.mode;
        this.settleRecovery(recovery);
      })
      .catch((error) => {
        if (this.closed || this.recovery !== recovery) return;
        this.clearRecoveryDeadline(recovery);
        this.recovery = null;
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(`[v4-store] resync ${this.topic} 失败: ${message}`);
        if (message.includes("fault.subscription.notOwned")) {
          // 线上事件：notOwned 表示某一层已不认这份 subscription
          // ownership（scope 换代静默驱逐、错位 unsubscribe 等状态分歧），是确定性失效
          // 而非瞬态故障；停在 error 等手动重连会让会话永久卡死。本地 snapshot 仍是一致
          // 投影，携当前水位 fresh subscribe 由服务端裁决 resume/snapshot（04-sync 规则 3），
          // 完成自愈。仅对 notOwned 特判，避免瞬态错误引发重连风暴。
          void this.connect();
          return;
        }
        this.setState({ status: "error", lastError: message });
      });
  }

  private markRecoveryFrameSeen(): void {
    const recovery = this.recovery;
    if (!recovery) return;
    recovery.validFrameSeen = true;
    this.settleRecovery(recovery);
  }

  private settleRecovery(recovery: NonNullable<ConversationProjectionStore["recovery"]>): void {
    if (this.recovery !== recovery || !recovery.ackReceived || recovery.requestInFlight) return;
    if (recovery.upgradePending) {
      this.clearRecoveryDeadline(recovery);
      if (!recovery.forceSnapshot && recovery.ackMode === "resume") {
        this.issueRecovery(recovery, true);
      } else {
        this.failRecovery("fault.subscription.recoveryFailed");
      }
      return;
    }
    if (recovery.validFrameSeen) {
      this.clearRecoveryDeadline(recovery);
      if (recovery.postRecoveryGapPending) {
        this.issueRecovery(recovery, false);
      } else {
        this.recovery = null;
      }
      return;
    }
    if (recovery.frameDeadline) return;
    recovery.frameDeadline = setTimeout(() => {
      recovery.frameDeadline = null;
      if (this.closed || this.recovery !== recovery || recovery.validFrameSeen) return;
      if (!recovery.forceSnapshot) this.issueRecovery(recovery, true);
      else
        this.failRecovery("fault.subscription.recoveryFrameTimedOut", { contentEligible: false });
    }, PROTOCOL_V4_LIMITS.logicalFrameAssemblyTimeoutMs);
  }

  private clearRecoveryDeadline(
    recovery: NonNullable<ConversationProjectionStore["recovery"]>,
  ): void {
    if (!recovery.frameDeadline) return;
    clearTimeout(recovery.frameDeadline);
    recovery.frameDeadline = null;
  }

  private discardRecovery(): void {
    if (this.recovery) this.clearRecoveryDeadline(this.recovery);
    this.recovery = null;
  }

  /**
   * `contentEligible: false` 给**超时**终态用：deadline 没等到 recovery 帧是传输症状，即使本次
   * flight 起因是内容失败，也不该被重标成 contentRejected——那会连带取消一次仍然有意义的重试。
   */
  private failRecovery(reasonCode: string, options: { contentEligible?: boolean } = {}): void {
    if (!this.recovery) return;
    // 内容确定性失败与传输失败必须可区分：前者重连不会变好，遥测按 code 聚合时也不该把一次
    // 版本失配读成网络抖动（reasonCode 词表见 wire-fault.ts）。
    const contentFault = this.recovery.contentFault && options.contentEligible !== false;
    const code = contentFault ? SUBSCRIPTION_CONTENT_REJECTED : reasonCode;
    this.discardRecovery();
    logger.warn(`[v4-store] ${this.topic} recovery fail-closed: ${code}`);
    this.setState({ status: "error", lastError: code });
  }

  private handleRuntimeRestart(reason?: "runtimeRestart" | "transportReplaced"): void {
    if (this.closed) return;
    // transport 已先失效旧 ownership/assembler；旧 transport/runtime subId 不得再 unsubscribe，
    // 直接 fresh subscribe，保留旧 snapshot 直到新 snapshot 原子替换。
    this.generation += 1;
    this.discardRecovery();
    this.awaitingInitial = null;
    this.subscriptionHasAppliedBase = false;
    this.setState({ status: "connecting", subscriptionId: null });
    // proxy handoff 不等于 CLI runtime 重启；强制 snapshot 会把用户已加载的
    // older rows 替换回 tail window。handoff 保留一致 projection 水位，由服务端按
    // logEpoch/seq 裁决 resume 或 snapshot；真实 runtime restart 仍保持 full subscribe。
    if (reason === "transportReplaced") void this.connect();
    else void this.connect({ forceSnapshot: true });
  }

  /**
   * loadOlder：以窗口首行为游标向上拉一窗历史行并前插。
   * - 单飞：在途期间重复调用 no-op（loadingOlder 防重入）；
   * - 陈旧读防护：atLogEpoch ≠ 当前快照 epoch 的结果整体丢弃（跨 CLI 重启）；
   * - 合并以 rowId 为键：与订阅流的 row.upserted/removed 天然一致，
   *   在途期间到达的 delta 帧不受影响（它们只动 ≥ 窗口首行的行）；
   * - 合并后按窗口双上限从头部裁剪：窗口保持有界连续尾窗，window[0].rowId
   *   始终是下一次分页游标；封顶时拉回行全部被裁掉，跳过提交避免空转渲染。
   */
  async loadOlder(limit: number = PROTOCOL_V4_LIMITS.snapshotTailWindowRows): Promise<void> {
    if (this.closed || this.state.loadingOlder) return;
    // U07：历史焦点生效时，「更早」方向由 focusIndexedRow/continueFocusOlder 独占。
    // 若此处同时前插尾部行，会与焦点正文争用同一分页方向，制造重复 rowId 与滚动跳变
    // （spec 不变量 3 / U07-A2「没有重复行」）。焦点退出后自动预取恢复既有行为。
    if (this.indexFocusController?.isActive === true) return;
    const snapshot = this.state.snapshot;
    if (!hasOlderRows(snapshot) || !snapshot) return;
    const sessionId = parseConversationTopic(this.topic);
    if (!sessionId) return;
    const beforeRowId = snapshot.rows.window[0]?.rowId;
    if (beforeRowId === undefined) return;
    this.setState({ loadingOlder: true });
    try {
      const result = await this.transport.rowsRange({
        sessionId,
        beforeRowId,
        limit,
      });
      if (this.closed) return;
      const current = this.state.snapshot;
      if (!current || result.atLogEpoch !== current.logEpoch) {
        logger.warn(
          `[v4-store] ${this.topic} rows/range 纪元不匹配（${result.atLogEpoch}），整体丢弃`,
        );
        return;
      }
      // 在途期间游标失效（row.removed 截断 / snapshot resync 整体替换）→ 结果作废，
      // 防止把权威侧已移除的历史行复活；下次触发按新窗口重新拉。
      if (current.rows.window[0]?.rowId !== beforeRowId) return;
      const mergeOutcome = mergeOlderRows(current.rows.window, result.rows);
      if (mergeOutcome === null) return;
      // 拉回的历史行进入窗口前先登记 turn 索引：随后被双上限裁掉的行仍保留目录依据。
      this.turnIndex.addRows(mergeOutcome.older);
      // 合并后的窗口按双上限从头部裁剪，保持「连续尾窗 + window[0] 为分页游标」不变量。
      const { window, evicted } = trimProjectionWindowToLimits(mergeOutcome.window);
      if (
        window[0]?.rowId === current.rows.window[0]?.rowId &&
        window.length === current.rows.window.length
      ) {
        // 双上限封顶：拉回行全部被裁掉，窗口内容无变化。保持旧引用，避免无谓渲染
        // 与游标漂移；后续触发仍以当前 window[0] 为游标，分页语义不中断。
        return;
      }
      if (evicted.length > 0) {
        logger.debug("[v4-store] loadOlder 合并后按窗口双上限裁剪头部", {
          evictedRows: evicted.length,
          retainedRows: window.length,
          topic: this.topic,
        });
      }
      this.setState({
        snapshot: { ...current, rows: { ...current.rows, window } },
      });
      // U07：补拉可能在聚焦**之前**就已发出（自动预取），其响应在焦点提交之后落地，
      // 于是权威尾部前插覆盖了已有焦点行 → 同一 rowId 渲染两次。焦点互斥只挡住
      // 「聚焦期间发起补拉」，挡不住这个方向，故提交后按新尾部首行重算焦点。
      this.reconcileIndexFocusAgainstTail();
    } catch (error) {
      // query 只读且可重发：失败不进 error 态，留给下次触发重试。
      logger.warn(
        `[v4-store] rowsRange ${this.topic} 失败: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      if (!this.closed) this.setState({ loadingOlder: false });
    }
  }

  /**
   * 完整问题目录：沿既有 rows/range 游标把当前有效分支一次补齐。
   *
   * 问题导航过去直接扫描 renderer 的 tail window，因此 1000 轮会话只显示
   * 已加载的几十轮。这里按协议上限分页读取，但等全部页成功后只换一次 snapshot，
   * 避免每 200 行重建一次 timeline render units 与两个 virtualizer。
   * 分页缓冲与最终提交都受窗口双上限约束：renderer 只常驻靠近当前窗口的尾段，
   * 更早的分页行在拉取时登记 turn 索引后即可丢弃（specs 规则 3）。
   */
  async loadAllOlder(): Promise<ConversationTurnNavigatorHydrationResult> {
    const stale = (logEpoch = this.state.snapshot?.logEpoch ?? "unknown") => ({
      status: "stale" as const,
      logEpoch,
    });
    if (this.closed || this.state.loadingOlder) return stale();
    // U07：历史焦点生效期间不得整分支补拉。两个理由——
    // (1) 本方法会沿游标遍历全部历史，正是 spec 规则 3 明令禁止的「后台遍历」；
    // (2) 它把历史行前插进权威尾部，与焦点争用同一分页方向，会产生重复 rowId。
    // 焦点退出后 rail 的既有 hydration 资格判定会重新放行（不改变既有终态缓存语义）。
    if (this.indexFocusController?.isActive === true) return stale();
    const snapshot = this.state.snapshot;
    if (!snapshot) return stale();
    // 终态必须同时匹配 logEpoch 与 directoryRevision。logEpoch 表示日志代际，
    // 不表示内容静止——real-user query 增删会递增 revision 使终态失效，允许重新探测。
    const directoryRevision = this.state.turnNavigatorDirectoryRevision;
    if (
      this.turnNavigatorHydrationTerminal?.logEpoch === snapshot.logEpoch &&
      this.turnNavigatorHydrationTerminal.directoryRevision === directoryRevision
    ) {
      return this.turnNavigatorHydrationTerminal;
    }
    if (!hasOlderRows(snapshot)) return stale(snapshot.logEpoch);
    const sessionId = parseConversationTopic(this.topic);
    const initialBeforeRowId = snapshot.rows.window[0]?.rowId;
    if (!sessionId || initialBeforeRowId === undefined) return stale(snapshot.logEpoch);

    const initialLogEpoch = snapshot.logEpoch;
    const preserveIncompleteLeadingTurn = shouldAutoLoadIncompleteLeadingTurn(snapshot, false);
    // 分页缓冲只保留「靠近当前窗口」且在双上限内的尾段：整条分支历史常驻 renderer 是
    // 活数据无界增长的根源（specs/renderer-memory-budget.md 规则 3），补拉扫描途中也不
    // 能例外。更早的分页行丢弃前已登记 turn 索引（含未提交的探测页），窗口外 turn 的
    // 目录与回拉依据不丢。
    let retainedOlderAsc: ConversationRow[] = [];
    let fetchedRealUserQueryCount = 0;
    let pageCount = 0;
    let beforeRowId = initialBeforeRowId;
    let committed = false;
    this.setState({ loadingOlder: true });
    logger.debug("[v4-store] 完整问题目录开始补拉历史 rows", {
      beforeRowId,
      loadedRows: snapshot.rows.window.length,
      sessionId,
      totalRows: snapshot.rows.totalCount,
    });

    try {
      while (true) {
        const result = await this.transport.rowsRange({
          sessionId,
          beforeRowId,
          limit: PROTOCOL_V4_LIMITS.rowsRangeMaxLimit,
        });
        if (this.closed) return stale(initialLogEpoch);
        const current = this.state.snapshot;
        if (
          !current ||
          result.atLogEpoch !== initialLogEpoch ||
          current.logEpoch !== initialLogEpoch ||
          current.rows.window[0]?.rowId !== initialBeforeRowId
        ) {
          logger.warn("[v4-store] 完整问题目录补拉期间投影游标失效，整批丢弃", {
            currentBeforeRowId: current?.rows.window[0]?.rowId,
            expectedBeforeRowId: initialBeforeRowId,
            resultLogEpoch: result.atLogEpoch,
            sessionId,
          });
          return stale(initialLogEpoch);
        }

        const older = result.rows.filter((row) => row.rowId < beforeRowId);
        const nextBeforeRowId = older[0]?.rowId;
        if (nextBeforeRowId === undefined || nextBeforeRowId >= beforeRowId) {
          logger.warn("[v4-store] 完整问题目录 rows/range 未推进游标，停止补拉", {
            beforeRowId,
            hasMore: result.hasMore,
            sessionId,
          });
          return { status: "retryable-failure", logEpoch: initialLogEpoch };
        }
        pageCount += 1;
        for (const row of older) {
          if (row.kind === "userInput" && row.origin === "realUser") {
            fetchedRealUserQueryCount += 1;
          }
        }
        this.turnIndex.addRows(older);
        // 页行全在缓冲首行之前，前插保持 rowId 升序（与 mergeOlderRows 输入约定一致），
        // 再用与窗口提交相同的纯函数裁掉最旧行，缓冲始终有界。
        retainedOlderAsc = trimProjectionWindowToLimits([...older, ...retainedOlderAsc]).window;
        beforeRowId = nextBeforeRowId;
        if (!result.hasMore) break;
      }

      const current = this.state.snapshot;
      if (
        !current ||
        current.logEpoch !== initialLogEpoch ||
        current.rows.window[0]?.rowId !== initialBeforeRowId
      ) {
        return stale(initialLogEpoch);
      }
      // 运行累计的 query 数覆盖全部拉取页（含被缓冲裁掉的行），与旧的全量计数等价。
      const olderRows = retainedOlderAsc;
      const realUserQueryCount =
        fetchedRealUserQueryCount +
        current.rows.window.reduce(
          (count, row) =>
            row.kind === "userInput" && row.origin === "realUser" ? count + 1 : count,
          0,
        );
      if (realUserQueryCount < 2) {
        if (preserveIncompleteLeadingTurn) {
          const mergeOutcome = mergeOlderRows(current.rows.window, olderRows);
          if (mergeOutcome === null) return stale(initialLogEpoch);
          // 提交前按双上限裁剪：补齐首轮所需的行保留，更早的分页行不常驻 renderer。
          const { window } = trimProjectionWindowToLimits(mergeOutcome.window);
          committed = true;
          this.setState({
            loadingOlder: false,
            snapshot: { ...current, rows: { ...current.rows, window } },
          });
          // navigator 已经拿到补齐首轮所需的权威 rows，必须在隐藏 rail 前先提交它们。
          logger.debug("[v4-store] 完整问题目录不足两条 query，保留首轮补齐 rows", {
            loadedRows: window.length,
            pages: pageCount,
            sessionId,
          });
        }
        // wire snapshot 只保留最后 60 rows，tail 中的 0/1 条 query 不能证明
        // 完整分支也是单 query。宽屏必须探测到分支起点；确认不足两条后不合并探测页，
        // 避免为一个不会显示的 rail 把完整历史常驻 renderer projection。
        logger.debug("[v4-store] 完整问题目录探测后不足两条 query", {
          pages: pageCount,
          preservedIncompleteLeadingTurn: preserveIncompleteLeadingTurn,
          realUserQueryCount,
          sessionId,
        });
        const result = {
          status: "not-enough-queries" as const,
          logEpoch: initialLogEpoch,
          directoryRevision,
        };
        this.turnNavigatorHydrationTerminal = result;
        return result;
      }
      const mergeOutcome = mergeOlderRows(current.rows.window, olderRows);
      if (mergeOutcome === null) return stale(initialLogEpoch);
      // 提交前按双上限裁剪：整窗提交不再把整条分支历史常驻 renderer。
      const { window } = trimProjectionWindowToLimits(mergeOutcome.window);
      committed = true;
      this.setState({
        loadingOlder: false,
        snapshot: { ...current, rows: { ...current.rows, window } },
      });
      logger.debug("[v4-store] 完整问题目录历史 rows 补拉完成", {
        loadedRows: window.length,
        pages: pageCount,
        sessionId,
      });
      const result = {
        status: "hydrated" as const,
        logEpoch: initialLogEpoch,
        directoryRevision,
      };
      this.turnNavigatorHydrationTerminal = result;
      return result;
    } catch (error) {
      logger.warn(
        `[v4-store] 完整问题目录 rowsRange ${this.topic} 失败: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { status: "retryable-failure", logEpoch: initialLogEpoch };
    } finally {
      if (!this.closed && !committed) this.setState({ loadingOlder: false });
    }
  }

  /**
   * 按本地失效 revision 合并并发的计划目录查询。
   * 旧计划可能早于 snapshot tail；同时 edit/retry 的 row.removed 会让在途
   * query 立刻过期，必须以 revision + epoch 双重校验，不能把旧分支计划重新写回 UI。
   */
  async refreshPlans(): Promise<void> {
    if (this.closed) return;
    if (this.planQueryInFlight) {
      this.planQueryPending = true;
      return;
    }
    const snapshot = this.state.snapshot;
    const sessionId = parseConversationTopic(this.topic);
    if (!snapshot || !sessionId) return;
    const requestedGeneration = this.generation;
    const requestedRevision = this.state.planDirectoryRevision;
    this.planQueryInFlight = true;
    this.setState({ plansLoading: true });
    try {
      const result = await this.transport.plans({ sessionId });
      if (this.closed) return;
      if (this.generation !== requestedGeneration) return;
      const current = this.state.snapshot;
      if (!current || current.logEpoch !== result.atLogEpoch) {
        return;
      }
      if (this.state.planDirectoryRevision !== requestedRevision) {
        this.planQueryPending = true;
        return;
      }
      this.setState({ sessionPlans: result.plans });
    } catch (error) {
      if (!this.closed) {
        logger.warn(
          `[v4-store] plans ${this.topic} 失败: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } finally {
      this.planQueryInFlight = false;
      if (!this.closed) this.setState({ plansLoading: false });
      if (this.planQueryPending && !this.closed) {
        this.planQueryPending = false;
        void this.refreshPlans();
      }
    }
  }

  /** 命令上行前登记 overlay（pending/stopping 展示用）。 */
  markCommandPending(command: OptimisticCommand): void {
    if (this.closed) return;
    this.setState({
      optimisticCommands: [...this.state.optimisticCommands, command],
    });
  }

  /**
   * ACK accepted/duplicate 后登记“必须能在权威投影中看见”的输入命令。
   *
   * command RPC 与 conversation topic 是两条独立通路；只有收到后续
   * delta 才能发现 gap，若 topic 在 ACK 后完全静默，CLI 继续工作但 UI 永远等不到 user row。
   * 这里不伪造消息，只在有限窗口后复用既有 same-sub recovery；权威 projection 一旦出现
   * queue/user row，watchdog 立即收口。
   */
  expectAcceptedInputProjection(commandId: string): void {
    if (this.closed || this.acceptedInputProjectionTimers.has(commandId)) return;
    const command = this.state.optimisticCommands.find((item) => item.commandId === commandId);
    if (!command || !ACCEPTED_INPUT_COMMAND_TYPES.has(command.type)) return;
    if (hasAcceptedInputProjection(this.state.snapshot, commandId)) {
      this.settleCommand(commandId);
      return;
    }
    const timer = setTimeout(() => {
      this.acceptedInputProjectionTimers.delete(commandId);
      if (
        this.closed ||
        !this.state.optimisticCommands.some((item) => item.commandId === commandId)
      ) {
        return;
      }
      if (hasAcceptedInputProjection(this.state.snapshot, commandId)) {
        this.settleCommand(commandId);
        return;
      }
      logger.warn("[v4-store] accepted input projection silent, trigger same-sub recovery", {
        commandId,
        topic: this.topic,
      });
      this.requestRecovery();
    }, ACCEPTED_INPUT_PROJECTION_GRACE_MS);
    this.acceptedInputProjectionTimers.set(commandId, timer);
  }

  private clearAcceptedInputProjectionWatch(commandId: string): void {
    const timer = this.acceptedInputProjectionTimers.get(commandId);
    if (timer !== undefined) clearTimeout(timer);
    this.acceptedInputProjectionTimers.delete(commandId);
  }

  /** 命令被拒/失败等本地收口时移除 overlay。 */
  settleCommand(commandId: string): void {
    this.clearAcceptedInputProjectionWatch(commandId);
    const remaining = this.state.optimisticCommands.filter(
      (command) => command.commandId !== commandId,
    );
    if (remaining.length !== this.state.optimisticCommands.length) {
      this.setState({ optimisticCommands: remaining });
    }
  }

  // 服务端投影出现同 commandId（pendingCommands / userInput.sourceCommandId 锚点）即代表权威侧已接管展示，overlay 条目退场。
  private reconcileOptimistic(snapshot: ConversationSnapshot): void {
    if (this.state.optimisticCommands.length === 0) return;
    const acknowledged = new Set<string>(
      snapshot.pendingCommands.map((command) => command.commandId),
    );
    const inputProjectionIds = new Set<string>();
    for (const item of snapshot.queue.items) {
      inputProjectionIds.add(item.sourceCommandId);
    }
    for (const row of snapshot.rows.window) {
      if (row.kind === "userInput" && row.sourceCommandId) {
        acknowledged.add(row.sourceCommandId);
        if (row.origin === "realUser") inputProjectionIds.add(row.sourceCommandId);
      }
    }
    const remaining = this.state.optimisticCommands.filter((command) =>
      ACCEPTED_INPUT_COMMAND_TYPES.has(command.type)
        ? !inputProjectionIds.has(command.commandId)
        : !acknowledged.has(command.commandId),
    );
    if (remaining.length !== this.state.optimisticCommands.length) {
      this.setState({ optimisticCommands: remaining });
    }
  }

  private reconcileAcceptedInputProjection(snapshot: ConversationSnapshot): void {
    for (const commandId of this.acceptedInputProjectionTimers.keys()) {
      if (!hasAcceptedInputProjection(snapshot, commandId)) continue;
      this.clearAcceptedInputProjectionWatch(commandId);
      this.settleCommand(commandId);
    }
  }

  /** 内存诊断：当前 rows.window 行数；只读。 */
  countProjectionRows(): number {
    return this.state.snapshot?.rows.window.length ?? 0;
  }

  /** turn 轻量索引只读快照（窗口外 turn 可回拉的依据；close() 后为空）。 */
  getTurnIndexEntries(): readonly TurnIndexEntry[] {
    return this.turnIndex.snapshotEntries();
  }

  /** 内存诊断：turn 索引条目数。 */
  turnIndexSize(): number {
    return this.turnIndex.size;
  }

  /** 内存诊断：turn 索引累计淘汰条目数。 */
  turnIndexEvictionCount(): number {
    return this.turnIndex.evictionCount;
  }

  /** 内存诊断：turn 索引字节估算（specs 规则 1：缓存必须暴露条数/字节/淘汰数）。 */
  turnIndexByteEstimate(): number {
    return this.turnIndex.byteEstimate;
  }

  // ── U07 目录索引与窗口外跳转（specs/conversation-index-navigation.md）──
  //
  // 宿主适配层在 conversationIndexFocusStoreAdapter.ts（本文件已在 legacy ratchet 基线上，
  // 适配代码约 50 行必须留在 store 之外）。这里只暴露 store 的只读事实与裁尾回调。

  private getIndexFocus(): ConversationIndexFocusController {
    if (this.indexFocusController === null) {
      const sessionId = parseConversationTopic(this.topic);
      // 事实面全部为箭头函数，闭包直接捕获 this（不再 alias），避免 no-this-alias。
      const controller = createIndexFocusController({
        sessionId,
        generation: () => this.generation,
        isClosed: () => this.closed,
        snapshot: () => this.state.snapshot,
        directoryRevision: () => this.state.turnNavigatorDirectoryRevision,
        turnIndexEntries: () => this.turnIndex.snapshotEntries(),
        turnIndexEvictionCount: () => this.turnIndex.evictionCount,
        turnIndexByteEstimate: () => this.turnIndex.byteEstimate,
        turnIndexSize: () => this.turnIndex.size,
        rowsRange: (params: IndexFocusRowsRangeParams) => this.transport.rowsRange(params),
        applyTailTrim: (retainRows: number) => this.trimTailForIndexFocus(retainRows),
      });
      this.indexFocusController = controller;
      return controller;
    }
    return this.indexFocusController;
  }

  /**
   * 焦点争用共享信封时裁尾（spec「窗口语义裁决」步骤 2）。
   *
   * 只在信封真的装不下时被调用；被裁行仍留在 turn 索引中（目录与回拉依据不丢），
   * 且下限由控制器按「60 与运行中 turn 行数」的较大者算出，永不裁进当前运行 turn。
   */
  private trimTailForIndexFocus(retainRows: number): void {
    const snapshot = this.state.snapshot;
    if (!snapshot) return;
    const window = snapshot.rows.window;
    const start = Math.max(0, window.length - Math.max(0, retainRows));
    if (start === 0) return;
    logger.debug("[v4-store] 历史焦点争用共享信封，裁剪尾部头部", {
      evictedRows: start,
      retainedRows: window.length - start,
      topic: this.topic,
    });
    this.setState({
      snapshot: { ...snapshot, rows: { ...snapshot.rows, window: window.slice(start) } },
    });
  }

  /**
   * 尾部窗口向后扩展后，让焦点让位（U07 不变量 3：焦点严格早于尾部首行）。
   * 无焦点时零成本 no-op；详见 conversationIndexFocusController.reconcileAgainstTail。
   */
  private reconcileIndexFocusAgainstTail(): void {
    const controller = this.indexFocusController;
    if (controller === null) return;
    controller.reconcileAgainstTail(this.state.snapshot?.rows.window[0]?.rowId ?? null);
  }

  /** 目录视图（0 个 rowsRange 请求，不扫描正文）；close() 后返回空目录。 */
  getIndexDirectory(): IndexDirectory {
    if (this.closed) return EMPTY_INDEX_DIRECTORY;
    return this.getIndexFocus().getDirectory();
  }

  /** 焦点派生态（只读）；close() 后为 idle。 */
  getIndexFocusState(): IndexFocusState {
    if (this.closed) return IDLE_INDEX_FOCUS_STATE;
    return this.getIndexFocus().getState();
  }

  /** 订阅焦点态变化（与主 state 分开，避免历史浏览触发整棵 timeline 重渲染）。 */
  subscribeIndexFocus(listener: () => void): () => void {
    if (this.closed) return () => {};
    return this.getIndexFocus().subscribe(listener);
  }

  /** 定位入口（spec 接口表 focusIndexedRow）；≤3 个正文请求，超范围返回可恢复错误码。 */
  focusIndexedRow(target: IndexFocusTarget): Promise<IndexFocusResult> {
    if (this.closed) return Promise.resolve(closedIndexFocusResult("closed", target.rowId));
    return this.getIndexFocus().focusIndexedRow(target);
  }

  /**
   * 原子捕获一次点击的定位目标（sessionId + generation + logEpoch + rowId）。
   *
   * generation 与 snapshot 必须**同一次读取**捕获：若调用方先读 snapshot 再单独读
   * generation，两次读取之间可能已 ++generation，捕获到的就是自相矛盾的身份。
   * store 返回 null 表示当前无快照（草稿态 / 尚未连上），调用方据此不发请求。
   */
  captureIndexFocusTarget(rowId: number): IndexFocusTarget | null {
    const snapshot = this.state.snapshot;
    if (this.closed || !snapshot) return null;
    const sessionId = parseConversationTopic(this.topic);
    if (!sessionId) return null;
    return { sessionId, generation: this.generation, logEpoch: snapshot.logEpoch, rowId };
  }

  /** 显式「继续加载更早」（spec 规则 3：超范围必须用户动作，绝不后台遍历历史）。 */
  continueIndexFocusOlder(): Promise<IndexFocusResult> {
    if (this.closed) return Promise.resolve(closedIndexFocusResult("closed", null));
    return this.getIndexFocus().continueFocusOlder();
  }

  /** 返回最新（spec 接口表 returnToLive）；清焦点正文、作废在途请求。 */
  returnToLive(): void {
    this.indexFocusController?.returnToLive();
  }

  /** 内存诊断：焦点区行数/字节（预算断言涵盖焦点、尾部与临时 page buffer）。 */
  indexFocusDiagnostics(): { focusRows: number; focusBytes: number } {
    const diagnostics = this.indexFocusController?.diagnostics();
    return { focusRows: diagnostics?.focusRows ?? 0, focusBytes: diagnostics?.focusBytes ?? 0 };
  }

  /** 目录摘要用的空文案（由 i18n 侧注入，store 不持有词典）。 */
  setIndexDirectoryFallbackSummary(summary: string): void {
    this.getIndexFocus().setDirectoryFallbackSummary(summary);
  }

  /**
   * snapshot 整体替换时登记行进 turn 索引。logEpoch 变更（CLI 换代/重开日志）先清空：
   * rowId 只在 epoch 内单调，跨 epoch 复用会让去重集合误判，旧分支的窗口外 turn 也
   * 已不可回拉；同 epoch 重放（recovery snapshot）按 rowId 去重，不重复占额度。
   */
  private registerSnapshotRowsInTurnIndex(snapshot: ConversationSnapshot): void {
    const previous = this.state.snapshot;
    if (previous && previous.logEpoch !== snapshot.logEpoch) {
      this.turnIndex.clear();
      // 跨 epoch rowId 会重新编号：焦点目标与在途定位一并失效（spec 规则 7 / U07-A4）。
      this.indexFocusController?.invalidate("epoch");
    }
    this.turnIndex.addRows(snapshot.rows.window);
  }

  /** 退订并终结本 store（仅 SessionDataLayer 调用）。 */
  async close(): Promise<void> {
    if (this.closed) return;
    liveProjectionStores.delete(this);
    const closeStartedAt = monotonicNow();
    logger.lifecycle.info("v4 conversation store close started", {
      event: "v4.conversation.store.close.started",
      generation: this.generation,
      module: "ui.v4.conversation_projection_store",
      status: "started",
      subscriptionId: this.state.subscriptionId,
      topic: this.topic,
    });
    this.closed = true;
    this.offAssemblyFault();
    this.offRuntimeRestart?.();
    this.offRuntimeLifecycle?.();
    this.clearRuntimeRecycleRetry();
    for (const timer of this.acceptedInputProjectionTimers.values()) clearTimeout(timer);
    this.acceptedInputProjectionTimers.clear();
    this.modelTransitionListeners.clear();
    // specs 所有者表：投影窗口与 turn 索引在 store close() 时一并释放。
    this.turnIndex.clear();
    // U07：焦点派生正文随 store 一并释放（spec 状态所有者表 / hidden-pane lease 规则）。
    this.indexFocusController?.close();
    this.indexFocusController = null;
    this.discardRecovery();
    this.awaitingInitial = null;
    this.subscriptionHasAppliedBase = false;
    this.generation++;
    const { subscriptionId } = this.state;
    this.setState({ status: "closed", subscriptionId: null });
    if (subscriptionId) {
      try {
        await this.transport.unsubscribe(subscriptionId);
      } catch (error) {
        logger.lifecycle.warn("v4 conversation store close unsubscribe failed", {
          durationMs: roundedDuration(closeStartedAt, monotonicNow()),
          errorMessage: error instanceof Error ? error.message : String(error),
          event: "v4.conversation.store.close.unsubscribe_failed",
          module: "ui.v4.conversation_projection_store",
          status: "failed",
          subscriptionId,
          topic: this.topic,
        });
        logger.warn(`[v4-store] unsubscribe ${this.topic} 失败（忽略）: ${String(error)}`);
      }
    }
    logger.lifecycle.info("v4 conversation store close completed", {
      durationMs: roundedDuration(closeStartedAt, monotonicNow()),
      event: "v4.conversation.store.close.completed",
      module: "ui.v4.conversation_projection_store",
      status: "completed",
      topic: this.topic,
    });
  }
}
