// MCP 自动重连预算（specs/mcp-lifecycle-ttl-approval.md R1）。
//
// 机制形态参照外部成熟实现公开行为（懒重连 + singleflight + 每 server 崩溃预算 +
// 最小重试间隔），实现自撰。为什么需要预算：反复崩溃的 stdio server 若不设限，
// 每次工具调用都会触发一轮完整 spawn+握手（慢、刷日志、可能雪崩），而模型侧只会
// 看到裸的 "not connected" 并倾向于循环重试。预算耗尽后挂起（suspended），把恢复
// 手段显式交回用户（设置页重连 / session 重启 / 配置变更），错误文案同时给模型
// 「不要在循环里重试」的指引（见 index.ts 的 buildReconnectRefusalError）。
//
// 双计数器（R1）：「连续连接失败」与「连续中途崩溃」（callTool 执行中途 transport
// 断开）并列计数，任一达到 crashBudget 即挂起。中途崩溃计数的复位点是一次工具
// 调用完整成功——连接成功**不**复位它，否则「连接必成功、每次 tools/call 都崩溃」
// 的 server 每轮懒重连的连接成功都会清零计数，永远到不了阈值（2026-10-16 真实
// 模型 E2E fixture B 实证的缝）。
//
// 状态所有者：本类实例（NodeMcpAdapter 私有字段）。pool 的多 entry 各自持有
// adapter，预算按连接实例隔离；跨实例共享预算会把「一个 lease 的连接失败」误伤到
// 另一个 workspace 的独立连接，方向上更糟。

export const DEFAULT_MCP_RECONNECT_CRASH_BUDGET = 3;
export const DEFAULT_MCP_RECONNECT_MIN_RETRY_INTERVAL_MS = 30_000;

/** 挂起来源维度（spec R1）。附加字段，wire fail-safe：旧消费者可忽略。 */
export type McpReconnectSuspensionSource = "connect_failures" | "in_call_crashes";

export interface McpReconnectBudgetOptions {
  /** 连续失败预算（两个计数器共用同一阈值）；耗尽即挂起。缺省 3。 */
  crashBudget?: number;
  /** 两次自动重连的最小间隔（ms）。缺省 30s。 */
  minRetryIntervalMs?: number;
  now?: () => number;
}

/** 挂起事实的对外投影（进 McpServerStatus.reconnectSuspension 与状态事件）。 */
export interface McpReconnectSuspensionState {
  consecutiveFailures: number;
  /** 连续中途崩溃数；仅该维度计数 > 0 时附加（附加字段，wire fail-safe）。 */
  consecutiveInCallCrashes?: number;
  /** ISO 8601。 */
  suspendedAt: string;
  /** 挂起来源维度；仅挂起时附加（附加字段，wire fail-safe）。 */
  suspendedBy?: McpReconnectSuspensionSource;
}

export type McpReconnectGateVerdict =
  | { allowed: true }
  | {
      allowed: false;
      reason: "suspended";
      consecutiveFailures: number;
      suspendedBy: McpReconnectSuspensionSource;
      suspension: McpReconnectSuspensionState;
    }
  | {
      allowed: false;
      reason: "cooldown";
      retryAfterMs: number;
      consecutiveFailures: number;
    };

interface ServerBudgetState {
  consecutiveFailures: number;
  consecutiveInCallCrashes: number;
  lastAttemptAt?: number;
  suspendedAt?: number;
  suspendedBy?: McpReconnectSuspensionSource;
}

export class McpReconnectBudget {
  private readonly crashBudget: number;
  private readonly minRetryIntervalMs: number;
  private readonly now: () => number;
  private readonly states = new Map<string, ServerBudgetState>();

  constructor(options: McpReconnectBudgetOptions = {}) {
    this.crashBudget = Math.max(1, options.crashBudget ?? DEFAULT_MCP_RECONNECT_CRASH_BUDGET);
    this.minRetryIntervalMs = Math.max(
      0,
      options.minRetryIntervalMs ?? DEFAULT_MCP_RECONNECT_MIN_RETRY_INTERVAL_MS,
    );
    this.now = options.now ?? Date.now;
  }

  /**
   * 自动重连门禁（只读判定，不改状态）。显式连接流程**不经过本门禁**——用户必须
   * 永远保有恢复手段（spec R1）。
   */
  check(serverName: string): McpReconnectGateVerdict {
    const state = this.states.get(serverName);
    if (!state) return { allowed: true };
    if (state.suspendedAt !== undefined) {
      return {
        allowed: false,
        reason: "suspended",
        consecutiveFailures: state.consecutiveFailures,
        suspendedBy: state.suspendedBy ?? "connect_failures",
        suspension: this.toSuspensionState(state),
      };
    }
    if (state.lastAttemptAt !== undefined) {
      const elapsed = this.now() - state.lastAttemptAt;
      if (elapsed < this.minRetryIntervalMs) {
        return {
          allowed: false,
          reason: "cooldown",
          retryAfterMs: this.minRetryIntervalMs - elapsed,
          consecutiveFailures: state.consecutiveFailures,
        };
      }
    }
    return { allowed: true };
  }

  /** 自动重连真正发起时登记尝试时刻（冷却窗口的锚点）。 */
  beginAttempt(serverName: string): void {
    const state = this.ensureState(serverName);
    state.lastAttemptAt = this.now();
  }

  /**
   * 登记一次连接失败（显式与自动路径都累积——连续失败是 server 的客观事实；
   * 但只有自动路径被 check 门禁，见 spec R1）。返回是否刚刚挂起。
   */
  recordFailure(serverName: string): { suspended: boolean; consecutiveFailures: number } {
    const state = this.ensureState(serverName);
    state.consecutiveFailures += 1;
    if (state.suspendedAt === undefined && state.consecutiveFailures >= this.crashBudget) {
      state.suspendedAt = this.now();
      state.suspendedBy = "connect_failures";
      return { suspended: true, consecutiveFailures: state.consecutiveFailures };
    }
    return { suspended: false, consecutiveFailures: state.consecutiveFailures };
  }

  /**
   * 登记一次中途崩溃（callTool 执行中途 transport 断开，spec R1 第二计数器）。
   * 复位点是一次工具调用完整成功（recordToolCallSuccess），**连接成功不复位**——
   * 否则「连接必成功、每次 tools/call 都崩溃」的 server 永远到不了阈值。
   * 返回是否刚刚挂起。
   */
  recordInCallCrash(serverName: string): {
    suspended: boolean;
    consecutiveInCallCrashes: number;
  } {
    const state = this.ensureState(serverName);
    state.consecutiveInCallCrashes += 1;
    if (state.suspendedAt === undefined && state.consecutiveInCallCrashes >= this.crashBudget) {
      state.suspendedAt = this.now();
      state.suspendedBy = "in_call_crashes";
      return { suspended: true, consecutiveInCallCrashes: state.consecutiveInCallCrashes };
    }
    return { suspended: false, consecutiveInCallCrashes: state.consecutiveInCallCrashes };
  }

  /**
   * 一次工具调用完整成功（transport 往返完成且非 in-band isError）：清零中途崩溃
   * 计数。in-band isError 不清零——server 半可用不等于恢复了调用能力，交替
   * 「崩溃 / in-band 报错」的形态同样构成 spawn 风暴。
   */
  recordToolCallSuccess(serverName: string): void {
    const state = this.states.get(serverName);
    if (!state) return;
    state.consecutiveInCallCrashes = 0;
  }

  /**
   * 连接成功：连续**连接失败**计数清零、冷却锚点清除、connect_failures 挂起解除
   * （连接成功是连接维度最强的恢复证据）。中途崩溃计数刻意**不**清零，
   * in_call_crashes 挂起也不在此解除（spec R1「成功即清零（分维度）」）。
   */
  recordSuccess(serverName: string): void {
    const state = this.states.get(serverName);
    if (!state) return;
    state.consecutiveFailures = 0;
    state.lastAttemptAt = undefined;
    if (state.suspendedBy !== "in_call_crashes") {
      state.suspendedAt = undefined;
      state.suspendedBy = undefined;
    }
  }

  /**
   * 显式操作复位：设置页重连、session 启动、配置变更下发的全量收敛。
   * 挂起、冷却与两个计数器全部清零——「需人工/下次显式操作」的落点。
   */
  reset(serverName: string): void {
    this.states.delete(serverName);
  }

  suspension(serverName: string): McpReconnectSuspensionState | undefined {
    const state = this.states.get(serverName);
    if (!state || state.suspendedAt === undefined) return undefined;
    return this.toSuspensionState(state);
  }

  private ensureState(serverName: string): ServerBudgetState {
    let state = this.states.get(serverName);
    if (!state) {
      state = { consecutiveFailures: 0, consecutiveInCallCrashes: 0 };
      this.states.set(serverName, state);
    }
    return state;
  }

  private toSuspensionState(state: ServerBudgetState): McpReconnectSuspensionState {
    return {
      consecutiveFailures: state.consecutiveFailures,
      ...(state.consecutiveInCallCrashes > 0
        ? { consecutiveInCallCrashes: state.consecutiveInCallCrashes }
        : {}),
      suspendedAt: new Date(state.suspendedAt ?? this.now()).toISOString(),
      ...(state.suspendedBy ? { suspendedBy: state.suspendedBy } : {}),
    };
  }
}

/**
 * 通用 singleflight：同一 key 的并发执行共享一个 in-flight promise，后到者等待
 * 同一结果（spec R1「同一 server 并发自动重连只发起一次」）。settle 后自动清表；
 * 失败结果原样共享给所有等待者——去重的是执行，不是错误。
 */
export function createSingleflightRunner<K, T>(): (
  key: K,
  run: () => Promise<T>,
) => Promise<T> {
  const inflight = new Map<K, Promise<T>>();
  return (key, run) => {
    const existing = inflight.get(key);
    if (existing) return existing;
    const promise = run().finally(() => {
      if (inflight.get(key) === promise) inflight.delete(key);
    });
    inflight.set(key, promise);
    return promise;
  };
}
