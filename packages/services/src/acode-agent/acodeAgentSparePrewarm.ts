// agent 备用进程预热(spare prewarm)的纯状态机与闭集词表。
// spec: packages/services/specs/agent-process-prewarm.md
// 机制移植自 2.37337 价值提取清册 T2-5 / T1-1 第 7 件(sparePrewarm + SpareMissReason 闭集),
// 只搬机制设计。进程 spawn/认领的执行面在 ACodeAgentProcessManager(单一 spawn 路径纪律);
// 本模块只做:①miss 词表与收窄函数 ②env 配置解析 ③补位调度状态机(反风暴)。

/**
 * session start timing 日志的 outcome 封闭词表(spec R3)。
 * 写入侧唯一工厂:任何进入日志的 outcome 都必须经 narrowAgentSpareStartOutcome 收窄,
 * 对齐波次 1 error-taxonomy-injection-defense 的「写入侧工厂 + 上报侧收窄」双收窄纪律。
 */
export const AGENT_SPARE_START_OUTCOMES = [
  "spare_hit",
  "spare_miss_not_warmed",
  "spare_miss_consumed_race",
  "spare_miss_spawn_failed",
  "spare_miss_disabled",
  "spare_miss_ineligible",
] as const;

export type AgentSpareStartOutcome = (typeof AGENT_SPARE_START_OUTCOMES)[number];

const SPARE_OUTCOME_SET: ReadonlySet<string> = new Set(AGENT_SPARE_START_OUTCOMES);

/** 只认闭集字面量;非法值返回 null,调用方必须省略字段而不是透传(spec R3)。 */
export function narrowAgentSpareStartOutcome(value: unknown): AgentSpareStartOutcome | null {
  if (typeof value !== "string" || !SPARE_OUTCOME_SET.has(value)) {
    return null;
  }
  return value as AgentSpareStartOutcome;
}

/**
 * 自由文本(如 spawn 失败的 error name)进 timing/warn 日志前的白名单收窄(spec R3)。
 * 参考 2.37337 拒绝 token 白名单纪律:标识符形态才放行,其余一律 unknown_error;
 * 错误 message/stack 永不进该字段。
 */
const SPARE_ERROR_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{2,63}$/;

export function narrowAgentSpareErrorName(value: unknown): string {
  return typeof value === "string" && SPARE_ERROR_NAME_PATTERN.test(value)
    ? value
    : "unknown_error";
}

/** kill switch:1=强制启用(任意 authority mode),0=强制关闭,其他值视同未设置(spec R6)。 */
export const ACODE_AGENT_SPARE_PREWARM_ENV_KEY = "ACODE_AGENT_SPARE_PREWARM";
/** 池大小:十进制整数,clamp [0,4];0=关闭;非法值 fail-safe 关闭(spec R6)。 */
export const ACODE_AGENT_SPARE_POOL_SIZE_ENV_KEY = "ACODE_AGENT_SPARE_POOL_SIZE";

export const AGENT_SPARE_POOL_SIZE_MAX = 4;
export const AGENT_SPARE_POOL_SIZE_DEFAULT = 1;

export type AgentSparePrewarmDisabledReason =
  | "kill_switch"
  | "size_zero"
  | "invalid_size"
  | "policy_default_off";

export interface AgentSparePrewarmConfig {
  enabled: boolean;
  poolSize: number;
  disabledReason?: AgentSparePrewarmDisabledReason;
}

/**
 * env → 池配置的纯函数(spec R6)。缺省策略:仅 desktop-local host 启用;
 * 远程 SSH/WSL server host 内存敏感,不默认常驻备件。env key 只有 host 侧消费,
 * 不进 @acode/shared(CLI 不读)。
 */
export function resolveAgentSparePrewarmConfig(
  env: Record<string, string | undefined>,
  context: { isDesktopLocalAuthority?: boolean },
): AgentSparePrewarmConfig {
  const switchRaw = env[ACODE_AGENT_SPARE_PREWARM_ENV_KEY]?.trim();
  const forced = switchRaw === "1" ? true : switchRaw === "0" ? false : undefined;

  const sizeRaw = env[ACODE_AGENT_SPARE_POOL_SIZE_ENV_KEY]?.trim();
  let poolSize = AGENT_SPARE_POOL_SIZE_DEFAULT;
  if (sizeRaw !== undefined && sizeRaw !== "") {
    // 与 resolveACodeAgentIdleExitConfig 同纪律:只认纯十进制整数,非法值 fail-safe 关闭。
    if (!/^\d+$/.test(sizeRaw)) {
      return { enabled: false, poolSize: 0, disabledReason: "invalid_size" };
    }
    poolSize = Math.min(Number(sizeRaw), AGENT_SPARE_POOL_SIZE_MAX);
  }
  if (poolSize === 0) {
    return { enabled: false, poolSize: 0, disabledReason: "size_zero" };
  }

  const enabled = forced ?? context.isDesktopLocalAuthority === true;
  return enabled
    ? { enabled: true, poolSize }
    : {
        enabled: false,
        poolSize,
        disabledReason: forced === false ? "kill_switch" : "policy_default_off",
      };
}

/** 补位调度参数;全部可注入供测试收窄(spec R4)。 */
export interface AgentSparePoolTiming {
  /** 首暖延迟:避开 host 装配峰值,unref。 */
  warmDelayMs: number;
  /** 认领后补位延迟。 */
  replenishDelayMs: number;
  /** 长寿备件丢失(含 CLI idle-exit TTL)后的补位冷却。 */
  lossCooldownMs: number;
  /** spawn 失败/短寿丢失的指数退避基数与上限。 */
  failureBackoffBaseMs: number;
  failureBackoffMaxMs: number;
  /** 连续失败达到该值熔断:停止补位,warn 一次(spec R4)。 */
  circuitFailureThreshold: number;
  /** 存活低于该值的丢失按失败计(反崩溃循环风暴)。 */
  minSpareLifetimeMs: number;
}

export const AGENT_SPARE_POOL_TIMING_DEFAULTS: AgentSparePoolTiming = {
  warmDelayMs: 1_500,
  replenishDelayMs: 250,
  lossCooldownMs: 30_000,
  failureBackoffBaseMs: 5_000,
  failureBackoffMaxMs: 300_000,
  circuitFailureThreshold: 3,
  minSpareLifetimeMs: 60_000,
};

type ReplenishTrigger = "initial" | "consumed" | "loss" | "failure";

export interface AgentSparePoolLogger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
}

export interface AgentSparePoolHost<T> {
  /** 复用 manager 的 startClient 装配面;reject 计为一次 spawn 失败(spec R4)。 */
  spawnSpare(): Promise<T>;
  logger: AgentSparePoolLogger;
}

export interface AgentSpareLossFacts {
  /** spawn 成功到丢失的存活时长;短寿(< minSpareLifetimeMs)按失败计。 */
  lifetimeMs: number;
  errorName?: unknown;
}

/**
 * spare 池状态机:待命索引 + 补位调度 + 反风暴(spec R1/R4)。
 * 单一所有者纪律:进程 OS 生命周期归 manager(ownedProcesses/cleanup)所有,
 * 池只索引「哪些 handle 处于待命态」并决定何时补位;不另建 kill 路径。
 * T 对池不透明(manager 侧是 ManagedACodeAgentProcess 的备件包装)。
 */
export class AgentSparePrewarmPool<T> {
  private readonly entries: T[] = [];
  private readonly host: AgentSparePoolHost<T>;
  private readonly poolSize: number;
  private readonly timing: AgentSparePoolTiming;
  private readonly now: () => number;
  private pendingTrigger: ReplenishTrigger | undefined;
  private pendingTimer: ReturnType<typeof setTimeout> | undefined;
  private spawnInFlight = false;
  private consecutiveFailures = 0;
  private circuitOpen = false;
  private circuitWarned = false;
  private disposed = false;
  private started = false;

  constructor(
    host: AgentSparePoolHost<T>,
    options: {
      poolSize: number;
      timing?: Partial<AgentSparePoolTiming>;
      now?: () => number;
    },
  ) {
    this.host = host;
    this.poolSize = Math.max(1, options.poolSize);
    this.timing = { ...AGENT_SPARE_POOL_TIMING_DEFAULTS, ...options.timing };
    this.now = options.now ?? Date.now;
  }

  /** host 装配后调用一次:排程首暖(unref timer,不钉事件循环)。 */
  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    this.scheduleReplenish("initial", this.timing.warmDelayMs);
  }

  get standbyCount(): number {
    return this.entries.length;
  }

  /** 最老备件优先(FIFO:最接近 idle-exit TTL 的先被认领)。 */
  peek(): T | undefined {
    return this.entries[0];
  }

  /** 待命索引快照(拷贝):认领方遍历时 onLost/take 变更原数组不会撕裂迭代。 */
  standbyEntries(): readonly T[] {
    return [...this.entries];
  }

  /** 同步认领取出(spec R2 全同步单飞);entry 不在池中时返回 false(幂等)。 */
  take(entry: T): boolean {
    const index = this.entries.indexOf(entry);
    if (index < 0) return false;
    this.entries.splice(index, 1);
    // 认领成功证明装配面健康:清零失败计数并立即补位。
    this.consecutiveFailures = 0;
    this.scheduleReplenish("consumed", this.timing.replenishDelayMs);
    return true;
  }

  /** 备件丢失(退出/关闭/认领前已死)。consumed 的 entry 不再走这里(take 已记账)。 */
  onLost(entry: T, facts: AgentSpareLossFacts): void {
    if (!this.take0(entry)) return;
    if (facts.lifetimeMs < this.timing.minSpareLifetimeMs) {
      // 短寿丢失 = spawn 成功但早夭/崩溃,与 spawn 失败同列退避,防崩溃循环风暴。
      this.handleFailure(facts.errorName, "short_lived");
      return;
    }
    this.consecutiveFailures = 0;
    this.scheduleReplenish("loss", this.timing.lossCooldownMs);
  }

  /** host.spawnSpare() reject 时由 manager 转达(spec R4 退避 + 熔断)。 */
  onSpawnFailed(errorName?: unknown): void {
    this.handleFailure(errorName, "spawn_failed");
  }

  /**
   * 当前无备件可认领时的 miss 归因(spec R3 闭集)。调用方保证池处于「无可认领备件」
   * 状态;eligible-but-present 的判定在 manager 侧(门禁知识不进池)。
   */
  missOutcome(): AgentSpareStartOutcome {
    if (this.circuitOpen || this.pendingTrigger === "failure") {
      return "spare_miss_spawn_failed";
    }
    if (this.pendingTrigger === "consumed") {
      return "spare_miss_consumed_race";
    }
    return "spare_miss_not_warmed";
  }

  /** 测试/诊断投影。 */
  snapshot(): {
    standbyCount: number;
    consecutiveFailures: number;
    circuitOpen: boolean;
    disposed: boolean;
    pendingTrigger: ReplenishTrigger | null;
    spawnInFlight: boolean;
  } {
    return {
      standbyCount: this.entries.length,
      consecutiveFailures: this.consecutiveFailures,
      circuitOpen: this.circuitOpen,
      disposed: this.disposed,
      pendingTrigger: this.pendingTrigger ?? null,
      spawnInFlight: this.spawnInFlight,
    };
  }

  dispose(): void {
    this.disposed = true;
    this.clearPending();
    this.entries.length = 0;
  }

  /** 内部:从索引移除但不触发补位记账(丢失分类由调用方决定)。 */
  private take0(entry: T): boolean {
    const index = this.entries.indexOf(entry);
    if (index < 0) return false;
    this.entries.splice(index, 1);
    return true;
  }

  private handleFailure(errorName: unknown, kind: "spawn_failed" | "short_lived"): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.timing.circuitFailureThreshold) {
      this.circuitOpen = true;
      this.clearPending();
      if (!this.circuitWarned) {
        this.circuitWarned = true;
        // 熔断只 warn 一次(spec R4);errorName 经白名单收窄,message/stack 不进日志。
        this.host.logger.warn("ACode agent spare prewarm disabled after consecutive failures", {
          consecutiveFailures: this.consecutiveFailures,
          failureKind: kind,
          errorName: narrowAgentSpareErrorName(errorName),
        });
      }
      return;
    }
    const backoffMs = Math.min(
      this.timing.failureBackoffBaseMs * 2 ** (this.consecutiveFailures - 1),
      this.timing.failureBackoffMaxMs,
    );
    this.scheduleReplenish("failure", backoffMs);
  }

  private scheduleReplenish(trigger: ReplenishTrigger, delayMs: number): void {
    if (this.disposed || this.circuitOpen || this.spawnInFlight) return;
    if (this.entries.length >= this.poolSize) return;
    // 后到的触发不覆盖在飞 spawn;同轮只保留一个待决排程,取更紧迫的语义
    // (consumed/failure 优先于 initial/loss,便于 missOutcome 精确归因)。
    if (this.pendingTimer !== undefined) {
      const priority: Record<ReplenishTrigger, number> = {
        failure: 0,
        consumed: 1,
        initial: 2,
        loss: 3,
      };
      if (this.pendingTrigger !== undefined && priority[trigger] > priority[this.pendingTrigger]) {
        return;
      }
      this.clearPending();
    }
    this.pendingTrigger = trigger;
    const timer = setTimeout(() => {
      // 只清 timer,保留 trigger:在飞 spawn 期间 missOutcome 仍按触发源归因
      // (consumed → consumed_race),trigger 在 runSpawn 终态清理。
      this.pendingTimer = undefined;
      void this.runSpawn();
    }, delayMs);
    timer.unref?.();
    this.pendingTimer = timer;
  }

  private clearPending(): void {
    if (this.pendingTimer !== undefined) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = undefined;
    }
    this.pendingTrigger = undefined;
  }

  private async runSpawn(): Promise<void> {
    if (this.disposed) {
      this.pendingTrigger = undefined;
      return;
    }
    if (this.spawnInFlight || this.entries.length >= this.poolSize) {
      this.pendingTrigger = undefined;
      return;
    }
    this.spawnInFlight = true;
    try {
      const entry = await this.host.spawnSpare();
      this.spawnInFlight = false;
      if (this.disposed) {
        // spawn 在飞期间 manager 被 dispose:manager 的 abort/dispose 面负责回收进程,
        // 池不再索引(避免 dispose 后残留可认领 entry)。
        this.pendingTrigger = undefined;
        return;
      }
      this.consecutiveFailures = 0;
      this.entries.push(entry);
      this.host.logger.info("ACode agent spare prewarm process ready", {
        standbyCount: this.entries.length,
        poolSize: this.poolSize,
      });
      this.pendingTrigger = undefined;
      // 池大小 >1 时继续补齐。
      this.scheduleReplenish("initial", this.timing.replenishDelayMs);
    } catch (error) {
      this.spawnInFlight = false;
      if (this.disposed) {
        this.pendingTrigger = undefined;
        return;
      }
      // handleFailure 内部会重排 failure 触发或熔断;trigger 由其接管。
      this.pendingTrigger = undefined;
      this.onSpawnFailed(error instanceof Error ? error.name : undefined);
    }
  }
}

/** disabled 池的空实现占位类型:manager 用同一个 missOutcome 词表面。 */
export const AGENT_SPARE_DISABLED_OUTCOME: AgentSpareStartOutcome = "spare_miss_disabled";
