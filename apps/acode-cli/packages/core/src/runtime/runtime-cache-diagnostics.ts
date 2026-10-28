/**
 * Cache Diagnostics 状态的所有者（R1-01 批次 B1）。
 *
 * 背景：`methods/` 下约 180 个函数经 installAgentRuntimeMethods 原型注入，签名一律
 * `this: AgentRuntimeInternal`。该类型组合了全部 7 簇，含 `RuntimeCacheDiagnosticsState`
 * 的扁平可写字段——任何 method 都能直接 `this.mainTurnCacheHitAggregate = ...`
 * 绕过收敛（2026-10-22 review R1-01，P1）。
 *
 * 本切片把 CacheDiagnostics 的 4 个字段（mainTurnCacheHitAggregate / pendingCacheMissCause /
 * cacheMissCauseCounts / autoCompactConsecutiveFailures）加上 2 个派生游标
 * （lastRequestModelId、lastAssistantCompletedAtMs）收敛进一个私有 owner，形态与
 * `runtime-turn-timing.ts`/`turn-coordination.ts` 完全一致：WeakMap 持有真值、构造期
 * 用 Object.defineProperty 装只读 getter（无 setter、configurable:false）、写者只能经
 * 有限写端口。method 的读面（`this.mainTurnCacheHitAggregate` 等）保持不变，只把
 * **赋值点**改成端口调用，行为逐点等价。
 *
 * 字段归属（唯一写入方 = turn 模型步 / compact / resume / rewind / context-refresh /
 * microcompact / control-only-turn）：
 * - mainTurnCacheHitAggregate：turn-model-step-usage 累计 + resume/rewind 重建；
 * - pendingCacheMissCause：显式事件点写入（compact/microcompact/control-only-turn/
 *   context-refresh/rewind），turn-model-step-usage 消费即清；
 * - cacheMissCauseCounts：turn-model-step-usage 累计 + resume/rewind 重建；
 * - autoCompactConsecutiveFailures：compact 成功 reset、失败 ++；
 * - lastRequestModelId：turn-model-step-usage 在 recordMainTurnUsage 内更新；
 * - lastAssistantCompletedAtMs：turn-model-step 在 turn 完成时写入。
 *
 * 关键不变量（spec §B1）：resolveCacheMissCause 归因事务（pendingCacheMissCause /
 * lastRequestModelId / lastAssistantCompletedAtMs 作为输入）与 recordMainTurnUsage 的
 * 累计/消费（D1/D2/D3/M4/T5 同时写）是同一个原子事务，必须同一 owner 持有。
 */
import type { PromptCacheMissCause } from "@acode/contracts";
import type { MainTurnCacheHitAggregate } from "./types.js";

export interface RuntimeCacheDiagnosticsView {
  readonly mainTurnCacheHitAggregate: MainTurnCacheHitAggregate;
  readonly pendingCacheMissCause?: PromptCacheMissCause;
  readonly cacheMissCauseCounts: Partial<Record<PromptCacheMissCause, number>>;
  readonly autoCompactConsecutiveFailures: number;
  readonly lastRequestModelId?: string;
  readonly lastAssistantCompletedAtMs?: number;
}

export interface RuntimeCacheDiagnosticsPort {
  /**
   * turn 完成时原子推进 assistant 完成时间戳（原 `this.lastAssistantCompletedAtMs = Date.now()`）。
   * 只由 turn-model-step 的 turn 完成点调用。
   */
  recordAssistantCompleted(atMs: number): void;
  /**
   * 主 turn 模型用量累计（原子事务）：
   * ① mainTurnCacheHitAggregate 累加 inputTokens/cacheRead/cacheWrite + requestCount+1；
   * ② cacheMissCauseCounts[cause] += 1（仅当 isMiss）；
   * ③ pendingCacheMissCause 消费即清；
   * ④ lastRequestModelId 更新为当前 modelId（若提供）；
   * ⑤ lastAssistantCompletedAtMs 不动（由 recordAssistantCompleted 负责）。
   *
   * 返回最新聚合快照 + 当前 missCauses 副本（若空则省略）+ 命中率派生值。
   * 等价于原 `turn-model-step-usage.ts:138-174` 的累计段。
   */
  recordMainTurnUsage(input: {
    inputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    isMiss: boolean;
    cause?: PromptCacheMissCause;
    modelId?: string;
  }): {
    aggregate: MainTurnCacheHitAggregate;
    missCauses?: Partial<Record<PromptCacheMissCause, number>>;
  };
  /**
   * 显式事件点写入 pendingCacheMissCause（compaction/control_only_turn/context_refresh/
   * conversation_rewind）。与「消费即清」是同一 pending 语义的两面。
   */
  setPendingCacheMissCause(cause: PromptCacheMissCause): void;
  /** resume/rewind 重建后清空 pending（原 `this.pendingCacheMissCause = undefined`）。 */
  clearPendingCacheMissCause(): void;
  /** 消费 pending 并返回当前值（用于 resolveCacheMissCause 的归因读取）。 */
  consumePendingCacheMissCause(): PromptCacheMissCause | undefined;
  /** resume/rewind 重建后重置 miss-cause 计数为空。 */
  resetCacheMissCauseCounts(): void;
  /**
   * resume/rewind 重建主 turn cache 聚合（从持久消息反推）。
   * 等价于原 `this.mainTurnCacheHitAggregate = mainTurnCacheHitAggregateFromMessages(...)`。
   */
  resetMainTurnCacheHitAggregate(aggregate: MainTurnCacheHitAggregate): void;
  /** compact 成功后重置 autoCompactConsecutiveFailures 为 0。 */
  resetAutoCompactFailures(): void;
  /** compact 失败后 autoCompactConsecutiveFailures += 1，返回新值（用于日志）。 */
  recordAutoCompactFailure(): number;
  /**
   * resume/rewind 时同步恢复 lastAssistantCompletedAtMs（从 latest assistant 消息时间反推）。
   * 等价于原 `this.lastAssistantCompletedAtMs = latestAssistant?.info.time.completed`。
   */
  restoreLastAssistantCompletedAtMs(atMs: number | undefined): void;
  /**
   * 读取当前 pending（不消费），供 resolveCacheMissCause 内部使用。
   * 与 consumePendingCacheMissCause 的区别：本方法不清空 pending。
   */
  peekPendingCacheMissCause(): PromptCacheMissCause | undefined;
  /** 读取当前 lastRequestModelId（不修改），供 resolveCacheMissCause 归因使用。 */
  peekLastRequestModelId(): string | undefined;
  /** 读取当前 lastAssistantCompletedAtMs（不修改），供 resolveCacheMissCause 归因使用。 */
  peekLastAssistantCompletedAtMs(): number | undefined;
}

class RuntimeCacheDiagnosticsOwner {
  #mainTurnCacheHitAggregate: MainTurnCacheHitAggregate = {
    requestCount: 0,
    totalInputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
  };
  #pendingCacheMissCause?: PromptCacheMissCause;
  #cacheMissCauseCounts: Partial<Record<PromptCacheMissCause, number>> = {};
  #autoCompactConsecutiveFailures = 0;
  #lastRequestModelId?: string;
  #lastAssistantCompletedAtMs?: number;

  get mainTurnCacheHitAggregate(): MainTurnCacheHitAggregate {
    return this.#mainTurnCacheHitAggregate;
  }

  get pendingCacheMissCause(): PromptCacheMissCause | undefined {
    return this.#pendingCacheMissCause;
  }

  get cacheMissCauseCounts(): Partial<Record<PromptCacheMissCause, number>> {
    return this.#cacheMissCauseCounts;
  }

  get autoCompactConsecutiveFailures(): number {
    return this.#autoCompactConsecutiveFailures;
  }

  get lastRequestModelId(): string | undefined {
    return this.#lastRequestModelId;
  }

  get lastAssistantCompletedAtMs(): number | undefined {
    return this.#lastAssistantCompletedAtMs;
  }

  readonly port: RuntimeCacheDiagnosticsPort = Object.freeze({
    recordAssistantCompleted: (atMs: number): void => {
      this.#lastAssistantCompletedAtMs = atMs;
    },
    recordMainTurnUsage: (input: {
      inputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
      isMiss: boolean;
      cause?: PromptCacheMissCause;
      modelId?: string;
    }): {
      aggregate: MainTurnCacheHitAggregate;
      missCauses?: Partial<Record<PromptCacheMissCause, number>>;
    } => {
      // ① 主聚合累计
      this.#mainTurnCacheHitAggregate = {
        requestCount: this.#mainTurnCacheHitAggregate.requestCount + 1,
        totalInputTokens: this.#mainTurnCacheHitAggregate.totalInputTokens + input.inputTokens,
        totalCacheReadTokens:
          this.#mainTurnCacheHitAggregate.totalCacheReadTokens + input.cacheReadTokens,
        totalCacheWriteTokens:
          this.#mainTurnCacheHitAggregate.totalCacheWriteTokens + input.cacheWriteTokens,
      };
      // ② miss-cause 累计（仅当 isMiss 且提供了 cause）
      if (input.isMiss && input.cause !== undefined) {
        const cause: PromptCacheMissCause = input.cause;
        this.#cacheMissCauseCounts = {
          ...this.#cacheMissCauseCounts,
          [cause]: (this.#cacheMissCauseCounts[cause] ?? 0) + 1,
        };
      }
      // ③ pending 消费即清（无论命中或 miss）
      this.#pendingCacheMissCause = undefined;
      // ④ lastRequestModelId 更新
      if (input.modelId !== undefined) {
        this.#lastRequestModelId = input.modelId;
      }
      // 返回派生快照（与迁移前逐行等价）
      const hasMissCauses = Object.keys(this.#cacheMissCauseCounts).length > 0;
      return {
        aggregate: this.#mainTurnCacheHitAggregate,
        ...(hasMissCauses ? { missCauses: { ...this.#cacheMissCauseCounts } } : {}),
      };
    },
    setPendingCacheMissCause: (cause: PromptCacheMissCause): void => {
      this.#pendingCacheMissCause = cause;
    },
    clearPendingCacheMissCause: (): void => {
      this.#pendingCacheMissCause = undefined;
    },
    consumePendingCacheMissCause: (): PromptCacheMissCause | undefined => {
      const value = this.#pendingCacheMissCause;
      this.#pendingCacheMissCause = undefined;
      return value;
    },
    resetCacheMissCauseCounts: (): void => {
      this.#cacheMissCauseCounts = {};
    },
    resetMainTurnCacheHitAggregate: (aggregate: MainTurnCacheHitAggregate): void => {
      this.#mainTurnCacheHitAggregate = aggregate;
    },
    resetAutoCompactFailures: (): void => {
      this.#autoCompactConsecutiveFailures = 0;
    },
    recordAutoCompactFailure: (): number => {
      this.#autoCompactConsecutiveFailures += 1;
      return this.#autoCompactConsecutiveFailures;
    },
    restoreLastAssistantCompletedAtMs: (atMs: number | undefined): void => {
      this.#lastAssistantCompletedAtMs = atMs;
    },
    peekPendingCacheMissCause: (): PromptCacheMissCause | undefined => {
      return this.#pendingCacheMissCause;
    },
    peekLastRequestModelId: (): string | undefined => {
      return this.#lastRequestModelId;
    },
    peekLastAssistantCompletedAtMs: (): number | undefined => {
      return this.#lastAssistantCompletedAtMs;
    },
  });
}

const owners = new WeakMap<object, RuntimeCacheDiagnosticsOwner>();

/**
 * 构造期绑定一次；重复初始化不能替换已有 owner 或 getter（与其余 owner 同款幂等）。
 * 只读 getter 无 setter、configurable:false——原型注入 method 经 `this.X` 只读，
 * 任何 `this.X = ...` 在运行时抛 TypeError、在 tsc 下报 readonly 违例。
 */
export function initializeRuntimeCacheDiagnostics(runtime: object): void {
  if (owners.has(runtime)) return;
  const owner = new RuntimeCacheDiagnosticsOwner();
  Object.defineProperties(runtime, {
    mainTurnCacheHitAggregate: {
      configurable: false,
      enumerable: true,
      get: () => owner.mainTurnCacheHitAggregate,
    },
    pendingCacheMissCause: {
      configurable: false,
      enumerable: true,
      get: () => owner.pendingCacheMissCause,
    },
    cacheMissCauseCounts: {
      configurable: false,
      enumerable: true,
      get: () => owner.cacheMissCauseCounts,
    },
    autoCompactConsecutiveFailures: {
      configurable: false,
      enumerable: true,
      get: () => owner.autoCompactConsecutiveFailures,
    },
    lastRequestModelId: {
      configurable: false,
      enumerable: true,
      get: () => owner.lastRequestModelId,
    },
    lastAssistantCompletedAtMs: {
      configurable: false,
      enumerable: true,
      get: () => owner.lastAssistantCompletedAtMs,
    },
  });
  owners.set(runtime, owner);
}

export function getRuntimeCacheDiagnosticsPort(runtime: object): RuntimeCacheDiagnosticsPort {
  const owner = owners.get(runtime);
  if (!owner) throw new Error("Runtime cache diagnostics has not been initialized");
  return owner.port;
}
