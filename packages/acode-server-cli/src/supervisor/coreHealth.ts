export const CORE_HEALTH_VALUES = ["unknown", "healthy", "degraded", "unresponsive"] as const;

export type CoreHealth = (typeof CORE_HEALTH_VALUES)[number];

export interface CoreHealthSnapshot {
  health: CoreHealth;
  lastHeartbeatAt: number | null;
}

export interface CoreHealthOptions {
  timeoutMs: number;
  now?: () => number;
}

/**
 * Tracks liveness separately from the lifecycle state.
 *
 * A stale heartbeat is observable through status and does not implicitly stop
 * the Core: a running task may still be making progress while its IPC heartbeat
 * is delayed. Restart remains an explicit lifecycle operation or follows the
 * existing exit/crash budget path.
 */
export class CoreHealthMonitor {
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private lastHeartbeatAt: number | null = null;
  private health: CoreHealth = "unknown";

  public constructor(options: CoreHealthOptions) {
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
      throw new Error("Core heartbeat timeout must be a positive finite number");
    }
    this.timeoutMs = options.timeoutMs;
    this.now = options.now ?? Date.now;
  }

  public reset(): void {
    this.lastHeartbeatAt = null;
    this.health = "unknown";
  }

  public markReady(at = this.now()): CoreHealthSnapshot {
    this.lastHeartbeatAt = at;
    this.health = "healthy";
    return this.snapshot(at);
  }

  public markHeartbeat(at = this.now()): CoreHealthSnapshot {
    this.lastHeartbeatAt = at;
    this.health = "healthy";
    return this.snapshot(at);
  }

  public evaluate(at = this.now()): CoreHealthSnapshot {
    this.health = this.healthAt(at);
    return this.snapshot();
  }

  private healthAt(at: number): CoreHealth {
    if (this.lastHeartbeatAt === null) {
      return "unknown";
    }
    const age = Math.max(0, at - this.lastHeartbeatAt);
    return age > this.timeoutMs
      ? "unresponsive"
      : age > this.timeoutMs / 2
        ? "degraded"
        : "healthy";
  }

  public snapshot(at?: number): CoreHealthSnapshot {
    // 查询计算当前新鲜度但不消费监控器的状态变化，否则 status 查询可能抢先
    // 更新 health，使下一次定时检查漏掉应持久化的 degraded/unresponsive 变化。
    return {
      health: at === undefined ? this.health : this.healthAt(at),
      lastHeartbeatAt: this.lastHeartbeatAt,
    };
  }

  public currentHealth(): CoreHealth {
    return this.health;
  }
}
