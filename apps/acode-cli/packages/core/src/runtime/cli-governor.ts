// ============================================================
// CliGovernor - 内存压力会话治理机制（WI-E4）
// (apps/acode-cli/specs/cli-governor.md R1-R7)
// ============================================================
// 机制移植自蓝本 CliGovernor 状态机（价值提取第三轮 A3；证据行号见 spec 头）。
// 本文件是**纯机制**：全部事实源（cap/计数/LRU 受害者/驱逐动作）经注入端口
// 消费，零 fleet 依赖——舰队组合面在 fleet/governor.ts（依赖方向：fleet →
// runtime，镜像 fleet → runtime-task 既有先例）。cap 公式与压力源实现在
// runtime/memory-pressure.ts，端口/事件类型在 runtime/cli-governor-types.ts
// （本文件 re-export，消费方导入面不变）。
//
// 核心不变量（spec R2/R4）：
// - user spawn 永不阻塞：at-cap 放行并记 governor_soft_cap_exceeded（记因）。
// - warm spawn 让路：at-cap 且无可驱逐受害者 → yield（不占 inFlight）；
//   恰好 at-cap 且有 idle≥60s 受害者且驱逐端口在位 → 驱逐后放行；over-cap
//   一律 yield 不叠加驱逐。
// - 驱逐 = 暂停而非杀：机制只调用注入的 evictVictim 端口（组合面接
//   stopTask——舰队记录/会话 JSONL/恢复面全部保留），端口缺席时
//   evictionOn=false，只发 would_evict 语义事件（fail-safe）。

import {
  createPollingMemoryPressureSource,
  type MemoryPressureLevel,
  type MemoryPressureSource,
} from "./memory-pressure.js";
import type {
  CliGovernorConfig,
  CliGovernorEvent,
  CliGovernorEventBaseCounts,
  GovernorEvictTrigger,
  GovernorLruVictim,
  GovernorSpawnReason,
  SlotAcquisition,
} from "./cli-governor-types.js";

export type {
  CliGovernorConfig,
  CliGovernorEvent,
  CliGovernorEventBaseCounts,
  CliGovernorLogger,
  GovernorEvictTrigger,
  GovernorLruVictim,
  GovernorSpawnReason,
  SlotAcquisition,
} from "./cli-governor-types.js";

// ── 常量（spec R3/R6；蓝本同款数值） ───────────────────────────────

/** LRU 受害者 idle guard：空闲 ≥60s 才够格被驱逐（蓝本 Zf）。 */
const MIN_VICTIM_IDLE_MS = 60_000;
/** 压力清扫 per-level 限速窗：同 level 60s 内只 sweep 一次（蓝本 Qf）。 */
const PRESSURE_SWEEP_INTERVAL_MS = 60_000;
/** repeat 抑制的再发射窗：同因重复压力 ≥5min 才重新发射（蓝本 ep）。 */
const PRESSURE_REPEAT_REEMIT_MS = 300_000;

/** 蓝本 t.D8 (async-mutex) 的最小等价：promise 链串行化 at-cap 判定段。 */
class SerialMutex {
  #tail: Promise<void> = Promise.resolve();

  runExclusive<T>(fn: () => T): Promise<T> {
    const result = this.#tail.then(fn);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

const NOOP_RELEASE = () => undefined;

interface LastEmittedPressure {
  level: MemoryPressureLevel;
  cap: number;
  at: number;
}

export class CliGovernor {
  readonly #config: CliGovernorConfig;
  readonly #mutex = new SerialMutex();
  #inFlight = 0;
  #observedLevel: MemoryPressureLevel | null = null;
  #levelSubscribers = new Set<(level: MemoryPressureLevel | null) => void>();
  #lastSweepAt: Record<MemoryPressureLevel, number> = { warning: 0, critical: 0 };
  #lastEmitted: LastEmittedPressure | null = null;
  #sourceUnsubscribe: (() => void) | null = null;

  constructor(config: CliGovernorConfig) {
    this.#config = config;
  }

  // ── 只读投影 ─────────────────────────────────────────────────────

  get inFlight(): number {
    return this.#inFlight;
  }

  effective(): number {
    return this.#config.countActive() + this.#inFlight;
  }

  currentCap(): number {
    return this.#config.cap();
  }

  isAtCap(): boolean {
    return this.effective() >= this.currentCap();
  }

  isOverCap(): boolean {
    return this.effective() > this.currentCap();
  }

  headroom(): number {
    return Math.max(0, this.currentCap() - this.effective());
  }

  evictionOn(): boolean {
    return this.#config.evictionEnabled?.() ?? this.#config.evictVictim !== undefined;
  }

  currentLevel(): MemoryPressureLevel | null {
    return Number.isFinite(this.currentCap()) ? this.#observedLevel : null;
  }

  /** 订阅观测 level 变化（仅变化时通知；订阅者抛错吞掉不破坏状态机）。 */
  subscribe(listener: (level: MemoryPressureLevel | null) => void): () => void {
    this.#levelSubscribers.add(listener);
    return () => {
      this.#levelSubscribers.delete(listener);
    };
  }

  // ── spawn 槽位（spec R2） ────────────────────────────────────────

  async acquireSlot(reason: GovernorSpawnReason): Promise<SlotAcquisition> {
    return this.#mutex.runExclusive(() => {
      const cap = this.#config.cap();
      const countActive = this.#config.countActive();
      const inFlight = this.#inFlight;
      const effective = countActive + inFlight;
      const counts: CliGovernorEventBaseCounts = { cap, effective, countActive, inFlight };
      this.#config.logger?.debug?.(`[cli-governor] acquire(${reason})`, { effective, cap });

      if (effective >= cap) {
        const victim = this.#config.peekLruIdleVictim("warm");
        const hadEvictable = victim !== null && this.#passesIdleGuard(victim);
        // 蓝本同款：只在恰好 at-cap（=== cap）时 warm 才驱逐，over-cap 不叠加。
        const willEvict =
          reason === "warm" && effective === cap && hadEvictable && this.evictionOn();

        if (victim !== null) {
          this.#config.logger?.info?.(
            `[cli-governor] at cap=${cap}; ${willEvict ? "evicting" : "would evict"} ${victim.sessionId} (idle ${victim.idleSeconds}s) for ${reason} spawn`,
          );
          this.#emit({
            type: "governor_would_evict",
            trigger: "warm_spawn",
            reason,
            victimSessionId: victim.sessionId,
            victimIdleSeconds: victim.idleSeconds,
            evicted: willEvict,
            ...counts,
          });
        }

        if (reason === "user") {
          // user spawn 永不阻塞：放行 + 记因（spec R2 分类表）。
          this.#emit({ type: "governor_soft_cap_exceeded", hadEvictable, ...counts });
        } else if (willEvict && victim !== null) {
          this.#evict(victim, "warm_spawn");
        } else {
          this.#config.logger?.info?.(`[cli-governor] at cap; yielding ${reason} spawn`);
          this.#emit({ type: "governor_yielded", reason, hadEvictable, ...counts });
          return { yielded: true, release: NOOP_RELEASE };
        }
      }

      this.#inFlight += 1;
      let released = false;
      return {
        yielded: false,
        release: () => {
          // 幂等：登记完成/失败路径可能双触达，只减一次（spec R1）。
          if (released) return;
          released = true;
          this.#inFlight -= 1;
        },
      };
    });
  }

  // ── 压力信号（spec R5/R6） ───────────────────────────────────────

  /** 压力源统一入口：level=null 解除（清 lastEmitted，下次压力必发）。 */
  onSignal(level: MemoryPressureLevel | null): void {
    this.#setObservedLevel(level);
    if (level === null) {
      this.#lastEmitted = null;
      return;
    }
    this.#handlePressure(level);
  }

  #handlePressure(level: MemoryPressureLevel): void {
    const cap = this.#config.cap();
    const now = (this.#config.now ?? Date.now)();
    // per-level 60s 限速（spec R6）：warning/critical 各自独立计时。
    if (now - this.#lastSweepAt[level] < PRESSURE_SWEEP_INTERVAL_MS) return;
    this.#lastSweepAt[level] = now;

    const countActive = this.#config.countActive();
    const inFlight = this.#inFlight;
    const effective = countActive + inFlight;
    // 蓝本 demand = max(0, effective − 0)：压力期最多清扫 effective 个空闲受害
    // 者（空闲会话是纯内存成本，够格即收；上限防 peek 异常时死转）。
    const demand = Math.max(0, effective);
    const first = this.#config.peekLruIdleVictim("pressure");
    const hadEvictable = first !== null && this.#passesIdleGuard(first);
    const wouldEvict = demand > 0 && first !== null ? demand : 0;

    let evicted = 0;
    if (this.evictionOn()) {
      let lastEvictedId: string | null = null;
      for (;;) {
        const victim = this.#config.peekLruIdleVictim("pressure");
        // 驱逐是异步收口：peek 粘住同一受害者说明清单未更新，break 防死循环
        // （蓝本 lastEvicted 守卫同款）。
        if (lastEvictedId !== null && victim?.sessionId === lastEvictedId) break;
        if (evicted >= demand || victim === null || !this.#passesIdleGuard(victim)) break;
        this.#evict(victim, "pressure");
        evicted += 1;
        lastEvictedId = victim.sessionId;
      }
    }

    // repeat 抑制（spec R6）：同 level 同 cap 且无可驱逐 → 压制到 ≥5min 再发。
    const isRepeat =
      wouldEvict === 0 && this.#lastEmitted?.level === level && this.#lastEmitted.cap === cap;
    if (
      isRepeat &&
      this.#lastEmitted !== null &&
      now - this.#lastEmitted.at < PRESSURE_REPEAT_REEMIT_MS
    ) {
      return;
    }
    this.#lastEmitted = { level, cap, at: now };
    this.#config.logger?.warn?.(
      `[cli-governor] memory pressure (${level}): ${this.evictionOn() ? `evicted ${evicted} of` : "would evict"} ${wouldEvict} idle session(s), ${effective} effective`,
    );
    this.#emit({
      type: "governor_pressure",
      level,
      wouldEvict,
      evicted,
      demand,
      hadEvictable,
      isRepeat,
      cap,
      effective,
      countActive,
      inFlight,
    });
  }

  // ── 生命周期 ─────────────────────────────────────────────────────

  /**
   * 订阅压力源（spec R5）：注入源优先，缺省建轮询源。重复 start 幂等
   * （蓝本 pollTimer/nativeUnsubscribe 在位即早退同款）。
   */
  start(source?: MemoryPressureSource): void {
    if (this.#sourceUnsubscribe !== null) return;
    const pressureSource =
      source ?? createPollingMemoryPressureSource({ logger: this.#config.logger });
    this.#sourceUnsubscribe = pressureSource.subscribe((level) => {
      this.onSignal(level);
    });
  }

  stop(): void {
    this.#sourceUnsubscribe?.();
    this.#sourceUnsubscribe = null;
    this.#setObservedLevel(null);
    this.#lastEmitted = null;
  }

  // ── 内部 ─────────────────────────────────────────────────────────

  #passesIdleGuard(victim: GovernorLruVictim): boolean {
    const minVictimIdleMs = this.#config.minVictimIdleMs ?? MIN_VICTIM_IDLE_MS;
    return victim.idleSeconds * 1000 >= minVictimIdleMs;
  }

  /**
   * pause-not-kill（spec R4）：只调用注入端口（组合面 = stopTask best-effort），
   * 机制不触碰任何删除/归档面；随后发 governor_evict 事件（可恢复语义的观测点）。
   */
  #evict(victim: GovernorLruVictim, trigger: GovernorEvictTrigger): void {
    this.#config.logger?.info?.(
      `[cli-governor] ${trigger} evicting ${victim.sessionId} (idle ${victim.idleSeconds}s)`,
    );
    try {
      this.#config.evictVictim?.(victim.sessionId, {
        trigger,
        idleSeconds: victim.idleSeconds,
      });
    } catch (error) {
      // 驱逐失败不破坏状态机（蓝本 .catch(log) 同款）；记 error 后继续。
      this.#config.logger?.error?.("[cli-governor] evictVictim threw", {
        sessionId: victim.sessionId,
        error: String(error),
      });
    }
    this.#emit({
      type: "governor_evict",
      sessionId: victim.sessionId,
      trigger,
      idleSeconds: victim.idleSeconds,
    });
  }

  #setObservedLevel(level: MemoryPressureLevel | null): void {
    if (level === this.#observedLevel) return;
    this.#observedLevel = level;
    for (const listener of this.#levelSubscribers) {
      try {
        listener(level);
      } catch (error) {
        this.#config.logger?.warn?.("[cli-governor] level subscriber threw", {
          error: String(error),
        });
      }
    }
  }

  #emit(event: CliGovernorEvent): void {
    try {
      this.#config.onEvent?.(event);
    } catch (error) {
      // 事件订阅者绝不允许反噬状态机（同 level 订阅者纪律）。
      this.#config.logger?.warn?.("[cli-governor] event subscriber threw", {
        type: event.type,
        error: String(error),
      });
    }
  }
}
