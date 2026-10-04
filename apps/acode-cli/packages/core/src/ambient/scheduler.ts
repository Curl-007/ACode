// 机制参照 jcode (MIT)：crates/jcode-app-core/src/ambient/scheduler.rs（AdaptiveScheduler
// 预算反推 interval、指数退避），自撰 TypeScript 实现
// （apps/acode-cli/specs/ambient-budget-scheduler.md R3）。
//
// 预算公式（spec 常量表）：
//   budget = (窗口剩余额度 − 用户1h速率 × 窗口剩余小时) × (1 − AMBIENT_USER_BUDGET_RESERVE)
//   cycles = ceil(budget / 近5cycle均值 || fallback 10000)
//   interval = 窗口剩余 / cycles，clamp [5min, 120min]
// 额度估计不可得时（配额面探测失败/未接线）：额度 = +∞，公式退化为「只按速率余量
// 约束」——账本读坏（速率=∞）时 headroom 为负 → 不跑；正常时取 MAX（120min）最保守
// 节奏。降级不静默：calculateBaseIntervalMs 的 degraded 标记让 runner 启动 warn 一次。
import {
  AMBIENT_CYCLE_TOKEN_FALLBACK,
  AMBIENT_MAX_INTERVAL_MS,
  AMBIENT_MIN_INTERVAL_MS,
  AMBIENT_USER_BUDGET_RESERVE,
} from "./constants.js";

/** 配额快照：当前计费/限流窗口的剩余额度。null = 配额面不可得（降级模式）。 */
export interface AmbientQuotaSnapshot {
  /** 窗口内还可用的 token 估计（套餐余额的 token 折算）。 */
  remainingTokens: number;
  /** 窗口还剩多久（ms）——interval 的分母。 */
  windowRemainingMs: number;
}

export interface AdaptiveSchedulerDeps {
  /** tokens/hour；账本损坏时实现方返回 Infinity（fail-closed，R1）。 */
  getHourlyRate(nowMs: number): number;
  /** 近 n cycle 平均消耗；无历史返回 null（fallback 10000）。 */
  getRecentCycles(n: number): number | null;
  /**
   * 配额面端口（bootstrap 绑定；探测结论见 spec 附录）。未绑定/查询失败 → null。
   * 不做缓存：runner 只在每个唤醒边界调用一次，频率可忽略。
   */
  getQuotaSnapshot?(): Promise<AmbientQuotaSnapshot | null>;
  now?(): number;
}

export interface AmbientIntervalDecision {
  /** 基础 interval（未乘退避倍率）。Infinity = 预算判定「本轮不可跑」。 */
  intervalMs: number;
  /** 配额面不可得的降级模式（runner 启动 warn 一次用）。 */
  degraded: boolean;
  /** 判定依据快照（日志/测试断言面）。 */
  detail: {
    hourlyRate: number;
    avgCycleTokens: number;
    quota: AmbientQuotaSnapshot | null;
    budgetTokens: number;
    cyclesAvailable: number;
  };
}

const HOUR_MS = 3_600_000;

export class AdaptiveScheduler {
  private readonly deps: AdaptiveSchedulerDeps;
  private backoffMultiplier = 1;

  constructor(deps: AdaptiveSchedulerDeps) {
    this.deps = deps;
  }

  /** 当前退避倍率（1 = 无退避；cap AMBIENT_BACKOFF_CAP）。 */
  currentBackoff(): number {
    return this.backoffMultiplier;
  }

  /** cycle 成功 → 退避重置 1（R3）。 */
  reportCycleSuccess(): void {
    this.backoffMultiplier = 1;
  }

  /** cycle 失败/限流 → ×2，cap 64。返回新倍率。 */
  reportCycleFailure(): number {
    this.backoffMultiplier = Math.min(this.backoffMultiplier * 2, 64);
    return this.backoffMultiplier;
  }

  /** 预算公式（R3）。返回 clamp 后的基础 interval 与判定依据。 */
  async calculateBaseInterval(): Promise<AmbientIntervalDecision> {
    const nowMs = this.deps.now?.() ?? Date.now();
    const hourlyRate = this.deps.getHourlyRate(nowMs);
    const avgCycleTokens = this.deps.getRecentCycles(5) ?? AMBIENT_CYCLE_TOKEN_FALLBACK;
    const quota = (await this.deps.getQuotaSnapshot?.()) ?? null;

    // 速率无穷大（账本损坏的 fail-closed 值）→ 用户余量被吃满 → ambient 不跑。
    // 这里刻意先判速率再谈额度：即使配额充裕，读坏账本意味着我们不知道用户花了
    // 多少，「宁可不振醒」（spec R1）优先于任何可用性。
    if (!Number.isFinite(hourlyRate)) {
      return {
        intervalMs: Number.POSITIVE_INFINITY,
        degraded: quota === null,
        detail: {
          hourlyRate,
          avgCycleTokens,
          quota,
          budgetTokens: Number.NEGATIVE_INFINITY,
          cyclesAvailable: 0,
        },
      };
    }

    if (!quota) {
      // 降级模式：额度 +∞。公式数学上会推出 interval→MIN（cycles=∞），方向激进，
      // 必须显式钉在 MAX——降级的含义就是「只知道不能跑多勤，不知道能跑多勤」。
      return {
        intervalMs: AMBIENT_MAX_INTERVAL_MS,
        degraded: true,
        detail: {
          hourlyRate,
          avgCycleTokens,
          quota: null,
          budgetTokens: Number.POSITIVE_INFINITY,
          cyclesAvailable: Number.POSITIVE_INFINITY,
        },
      };
    }

    // F12（批次C）：窗口非正（或非有限）→ 不可跑。原实现落入下方公式后经 clamp 钉到
    // MIN（最激进方向）——窗口已收口时额度不可兑现，正确方向是保守：「宁可不振醒」。
    // 配额端口的「窗口已收口 → null」判定在上游，此处是对注入端口的独立防御。
    if (!(quota.windowRemainingMs > 0) || !Number.isFinite(quota.windowRemainingMs)) {
      return {
        intervalMs: Number.POSITIVE_INFINITY,
        degraded: false,
        detail: {
          hourlyRate,
          avgCycleTokens,
          quota,
          budgetTokens: 0,
          cyclesAvailable: 0,
        },
      };
    }

    const windowHours = quota.windowRemainingMs / HOUR_MS;
    const reservedForUser = hourlyRate * windowHours;
    const headroom = quota.remainingTokens - reservedForUser;
    const budgetTokens = headroom * (1 - AMBIENT_USER_BUDGET_RESERVE);

    if (budgetTokens <= 0 || !Number.isFinite(budgetTokens)) {
      // 余量已被用户速率占满（或额度本身异常）：预算为零 → 本轮不可跑。
      // interval=Infinity 表示「没有可推导的唤醒节奏」；runner 仍会在 direct 项
      // 到期或 tick 边界醒来重算（速率窗口是滚动的，判定可恢复）。
      return {
        intervalMs: Number.POSITIVE_INFINITY,
        degraded: false,
        detail: {
          hourlyRate,
          avgCycleTokens,
          quota,
          budgetTokens,
          cyclesAvailable: 0,
        },
      };
    }

    // ceil 而不是 floor：spec 验收场景 2 的手工对照（100k/10k·h/2h/0.8/5k → 4 cycle
    // → 30min）按向上取整；剩余额度在 cycle 边界上的零头不构成少跑一整个 cycle 的理由。
    const cyclesAvailable = Math.ceil(budgetTokens / avgCycleTokens);
    const raw = quota.windowRemainingMs / cyclesAvailable;
    return {
      intervalMs: Math.min(AMBIENT_MAX_INTERVAL_MS, Math.max(AMBIENT_MIN_INTERVAL_MS, raw)),
      degraded: false,
      detail: {
        hourlyRate,
        avgCycleTokens,
        quota,
        budgetTokens,
        cyclesAvailable,
      },
    };
  }

  /** 当前生效 interval：基础 × 退避倍率（退避可越过 MAX——限流时拉长间隔正是目的）。 */
  async currentIntervalMs(): Promise<number> {
    const base = await this.calculateBaseInterval();
    if (!Number.isFinite(base.intervalMs)) return base.intervalMs;
    return base.intervalMs * this.backoffMultiplier;
  }
}
