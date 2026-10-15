// MCP 自动重连预算（specs/mcp-lifecycle-ttl-approval.md R1）。
//
// 机制形态参照外部成熟实现公开行为（懒重连 + singleflight + 每 server 崩溃预算 +
// 最小重试间隔），实现自撰。为什么需要预算：反复崩溃的 stdio server 若不设限，
// 每次工具调用都会触发一轮完整 spawn+握手（慢、刷日志、可能雪崩），而模型侧只会
// 看到裸的 "not connected" 并倾向于循环重试。预算耗尽后挂起（suspended），把恢复
// 手段显式交回用户（设置页重连 / session 重启 / 配置变更），错误文案同时给模型
// 「不要在循环里重试」的指引（见 index.ts 的 buildReconnectRefusalError）。
//
// 状态所有者：本类实例（NodeMcpAdapter 私有字段）。pool 的多 entry 各自持有
// adapter，预算按连接实例隔离；跨实例共享预算会把「一个 lease 的连接失败」误伤到
// 另一个 workspace 的独立连接，方向上更糟。

export const DEFAULT_MCP_RECONNECT_CRASH_BUDGET = 3;
export const DEFAULT_MCP_RECONNECT_MIN_RETRY_INTERVAL_MS = 30_000;

export interface McpReconnectBudgetOptions {
  /** 连续失败预算；耗尽即挂起。缺省 3。 */
  crashBudget?: number;
  /** 两次自动重连的最小间隔（ms）。缺省 30s。 */
  minRetryIntervalMs?: number;
  now?: () => number;
}

/** 挂起事实的对外投影（进 McpServerStatus.reconnectSuspension 与状态事件）。 */
export interface McpReconnectSuspensionState {
  consecutiveFailures: number;
  /** ISO 8601。 */
  suspendedAt: string;
}

export type McpReconnectGateVerdict =
  | { allowed: true }
  | {
      allowed: false;
      reason: "suspended";
      consecutiveFailures: number;
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
  lastAttemptAt?: number;
  suspendedAt?: number;
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
      return { suspended: true, consecutiveFailures: state.consecutiveFailures };
    }
    return { suspended: false, consecutiveFailures: state.consecutiveFailures };
  }

  /** 连接成功：计数清零，挂起解除（成功本身就是最强的恢复证据）。 */
  recordSuccess(serverName: string): void {
    this.states.delete(serverName);
  }

  /**
   * 显式操作复位：设置页重连、session 启动、配置变更下发的全量收敛。
   * 挂起与冷却全部清零——「需人工/下次显式操作」的落点。
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
      state = { consecutiveFailures: 0 };
      this.states.set(serverName, state);
    }
    return state;
  }

  private toSuspensionState(state: ServerBudgetState): McpReconnectSuspensionState {
    return {
      consecutiveFailures: state.consecutiveFailures,
      suspendedAt: new Date(state.suspendedAt ?? this.now()).toISOString(),
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
