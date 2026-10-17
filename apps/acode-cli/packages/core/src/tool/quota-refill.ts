// ============================================================
// 通用 refill 式配额（quota-refill）
// ============================================================
//
// 机制形态参照外部成熟实现的公开行为（桶容量上限 + 随时间连续回补 + 惰性结算，
// 不用定时器）；实现、命名与文案全部自撰。与「一次性总量配额」的区别：窗口内
// 至多消费 limit 个名额，用掉的名额按 refillPerWindow 速率随时间连续回补；
// 超限拒绝时 retryAfterMs 告知下一个名额何时就绪，调用方可以把恢复时间写进
// 面向用户的解释里。
//
// 通用件定位（specs/websearch-refill-budget.md）：当前由 WebSearch 会话级搜索
// 预算消费；ambient 配额、cron/off-peak 派发限速等同为「每窗口 N 次 + 随时间
// 回补」形态的预算面可直接复用本模块。状态是实例私有的（无模块级可变态），
// 每个消费面各自持有实例、各自决定实例的键（如按 session）。
//
// 算法要点（推导见 spec「常量与算法」）：
// - 惰性结算：回补只在 tryConsume / peekRetryAfterMs 被调用时结算，无后台定时器，
//   进程空闲不消耗资源；
// - 桶空不攒信用（consumed === 0 时清零 credit）：空闲时间不能兑换成未来的突发
//   额度，长期闲置后的第一次消费永远从满桶开始；
// - 速率热调整取保守值：一段结算区间内的信用按 min(新速率, 旧速率) 累积，防止
//   调高速率时把上一段低速率区间按新速率兑现；
// - 时钟可注入（now），测试无需真实等待；配置经 resolveConfig 每次结算时重读，
//   env 热调整即时生效，limit <= 0 即完全关闭预算（恒放行、不计数）。

/** 一份配额配置快照。resolveConfig 在每次结算时被调用（支持热调整）。 */
export interface RefillQuotaConfig {
  /**
   * 窗口内可消费的名额上限（桶容量）。<= 0 或非有限数 = 预算关闭：恒放行、
   * 不计数、不产生拒绝。
   */
  limitPerWindow: number;
  /** 回补窗口长度（ms）。非法值（<= 0 / 非有限数）按缺省窗口处理。 */
  windowMs: number;
  /**
   * 每窗口回补的名额数。缺省 = limitPerWindow（桶以「每窗口补满一整桶」的速率
   * 连续回补）。0 = 不回补（退化为一次性总量配额）。
   */
  refillPerWindow?: number;
}

export interface RefillQuotaVerdict {
  allowed: boolean;
  /**
   * 仅拒绝时携带：距下一个名额就绪的毫秒数（>= 1）。不回补（refillPerWindow=0）
   * 时为 Infinity——调用方应表述为「本配置下不会自行恢复」而不是给一个假时间。
   */
  retryAfterMs?: number;
}

export interface RefillQuota {
  /** 尝试消费一个名额；放行时计数 +1，拒绝时不计数。 */
  tryConsume(): RefillQuotaVerdict;
  /** 只读探测：现在消费会被拒绝吗？拒绝时返回距下一个名额的毫秒数。 */
  peekRetryAfterMs(): number;
}

export const DEFAULT_REFILL_QUOTA_WINDOW_MS = 3_600_000;

interface RefillQuotaState {
  /** 当前窗口内尚未被回补抵消的已消费名额数。 */
  consumed: number;
  /**
   * 回补信用累积器，单位 = ms × (名额/窗口)。攒满一个 windowMs 兑换一个名额。
   * 用「时间×速率」而不是「小数名额」累积，避免浮点误差在长区间里放大。
   */
  creditMs: number;
  /** 上一次结算时刻。 */
  lastSettledAt: number;
  /** 上一次结算采用的回补速率（热调整保守夹取的另一端）。 */
  lastRefillRate: number;
}

export interface CreateRefillQuotaOptions {
  resolveConfig: () => RefillQuotaConfig;
  now?: () => number;
}

export function createRefillQuota(options: CreateRefillQuotaOptions): RefillQuota {
  const now = options.now ?? Date.now;
  const state: RefillQuotaState = {
    consumed: 0,
    creditMs: 0,
    lastSettledAt: now(),
    lastRefillRate: normalizeRefillRate(options.resolveConfig()),
  };

  function settle(): RefillQuotaConfig {
    const config = options.resolveConfig();
    const windowMs = normalizeWindowMs(config.windowMs);
    const rate = normalizeRefillRate(config);
    // 速率热调整取保守值：本段区间按 min(新, 旧) 累积，调高不能追溯兑现旧区间。
    const effectiveRate = Math.min(rate, state.lastRefillRate);
    state.lastRefillRate = rate;

    const elapsedMs = Math.max(0, now() - state.lastSettledAt);
    state.lastSettledAt = now();
    if (state.consumed === 0) {
      // 桶满时不攒信用：空闲时间不兑换突发额度。
      state.creditMs = 0;
      return config;
    }
    state.creditMs += elapsedMs * effectiveRate;
    const refilled = Math.floor(state.creditMs / windowMs);
    if (refilled >= state.consumed) {
      state.consumed = 0;
      state.creditMs = 0;
      return config;
    }
    state.consumed -= refilled;
    state.creditMs -= refilled * windowMs;
    return config;
  }

  function retryAfterMs(config: RefillQuotaConfig): number {
    const overflow = state.consumed - normalizeLimit(config.limitPerWindow);
    if (overflow < 0) return 0;
    const rate = state.lastRefillRate;
    if (rate <= 0) return Number.POSITIVE_INFINITY;
    const windowMs = normalizeWindowMs(config.windowMs);
    // 还差 overflow + 1 个名额才轮到下一次消费；已攒信用按当前速率折回时间。
    const remainingCreditMs = (overflow + 1) * windowMs - state.creditMs;
    return Math.max(1, Math.ceil(remainingCreditMs / rate));
  }

  return {
    tryConsume(): RefillQuotaVerdict {
      const config = settle();
      const limit = normalizeLimit(config.limitPerWindow);
      if (limit <= 0) return { allowed: true };
      if (state.consumed >= limit) {
        return { allowed: false, retryAfterMs: retryAfterMs(config) };
      }
      state.consumed += 1;
      return { allowed: true };
    },
    peekRetryAfterMs(): number {
      const config = settle();
      if (normalizeLimit(config.limitPerWindow) <= 0) return 0;
      return retryAfterMs(config);
    },
  };
}

function normalizeLimit(value: number): number {
  return Number.isFinite(value) ? Math.floor(value) : 0;
}

function normalizeWindowMs(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_REFILL_QUOTA_WINDOW_MS;
}

function normalizeRefillRate(config: RefillQuotaConfig): number {
  const rate = config.refillPerWindow ?? config.limitPerWindow;
  if (!Number.isFinite(rate) || rate < 0) return 0;
  return rate;
}
