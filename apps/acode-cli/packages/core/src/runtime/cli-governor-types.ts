// ============================================================
// CliGovernor 类型面 - 端口、事件闭集与槽位契约（WI-E4）
// (apps/acode-cli/specs/cli-governor.md R2/R3/R4/R7)
// ============================================================
// 状态机实现在 runtime/cli-governor.ts（re-export 本文件类型，消费方导入面
// 不变）；类型独立成文件以满足 max-file-lines 纪律。

import type { MemoryPressureLevel } from "./memory-pressure.js";

export type GovernorSpawnReason = "user" | "warm";

export interface GovernorLruVictim {
  sessionId: string;
  idleSeconds: number;
}

export type GovernorEvictTrigger = "warm_spawn" | "pressure";

export interface CliGovernorEventBaseCounts {
  cap: number;
  effective: number;
  countActive: number;
  inFlight: number;
}

/** 事件闭集（spec R7）：governor_* 五种，无厂商面名字。 */
export type CliGovernorEvent =
  | ({
      type: "governor_would_evict";
      trigger: GovernorEvictTrigger;
      reason?: GovernorSpawnReason;
      victimSessionId: string;
      victimIdleSeconds: number;
      /** false = 端口缺席/条件不满足的「只记不杀」观测。 */
      evicted: boolean;
    } & CliGovernorEventBaseCounts)
  | ({
      type: "governor_soft_cap_exceeded";
      hadEvictable: boolean;
    } & CliGovernorEventBaseCounts)
  | ({
      type: "governor_yielded";
      reason: GovernorSpawnReason;
      hadEvictable: boolean;
    } & CliGovernorEventBaseCounts)
  | ({
      type: "governor_pressure";
      level: MemoryPressureLevel;
      wouldEvict: number;
      evicted: number;
      demand: number;
      hadEvictable: boolean;
      isRepeat: boolean;
    } & CliGovernorEventBaseCounts)
  | {
      type: "governor_evict";
      sessionId: string;
      trigger: GovernorEvictTrigger;
      idleSeconds: number;
    };

export interface CliGovernorLogger {
  debug?(message: string, meta?: Record<string, unknown>): void;
  info?(message: string, meta?: Record<string, unknown>): void;
  warn?(message: string, meta?: Record<string, unknown>): void;
  error?(message: string, meta?: Record<string, unknown>): void;
}

export interface CliGovernorConfig {
  /** spec R1：cap 事实源（组合面构造期算一次；端口保持函数形以对齐蓝本）。 */
  cap: () => number;
  /** spec R1：在册会话计数（舰队口径 = 非归档记录数）。 */
  countActive: () => number;
  /** spec R3：LRU 受害者 peek（idle guard 由 governor 侧统一判定）。 */
  peekLruIdleVictim: (
    reason: GovernorEvictTrigger | GovernorSpawnReason,
  ) => GovernorLruVictim | null;
  /** spec R4：可恢复暂停动作（组合面接 stopTask）。缺席 → evictionOn=false。 */
  evictVictim?: (
    sessionId: string,
    context: { trigger: GovernorEvictTrigger; idleSeconds: number },
  ) => void;
  /**
   * 驱逐可用性动态判定（spec R4 fail-safe）：缺省 = evictVictim 是否在位。
   * 组合面的端口是懒接的（首个 fleet launch 才 attach），故需动态口径而非
   * 构造期快照。
   */
  evictionEnabled?: () => boolean;
  minVictimIdleMs?: number;
  onEvent?: (event: CliGovernorEvent) => void;
  logger?: CliGovernorLogger;
  /** 测试注入时钟（限速/抑制窗判定）。 */
  now?: () => number;
}

export interface SlotAcquisition {
  /** true = warm spawn 让路：调用方不得 spawn，release 为 no-op。 */
  yielded: boolean;
  /** 幂等释放（双调用只减一次 inFlight）。 */
  release: () => void;
}
