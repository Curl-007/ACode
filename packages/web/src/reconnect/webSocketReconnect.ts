/**
 * Web 入口 WebSocket 断线重连控制器（specs/web-reconnect.md）。
 *
 * 根因：`connectViaWebSocket(wsUrl, { onClose: () => {} })` 的 onClose 是空实现——WS 一旦断开
 *（server 重启 / 网络抖动 / 手机切后台），Web 入口既不重连也不提示，用户停在死界面。services 侧
 * `web-remote-replayable` 的 snapshot/resume 语义已齐备，缺的是入口层的重连编排与断线态 UI。
 *
 * 设计（AGENTS.md：不用超时掩盖同步问题）：本控制器**不**用定时器去猜测连接健康，只在收到明确的
 * close 事件后编排「指数退避 → 重连」；重连成功由 connect() 的 resolve 明确驱动。定时器仅用于退避
 * 间隔，且有界（capped）、可被 cancel() 清理，杜绝泄漏。
 *
 * 纯编排 + 可注入 timer/connect，便于用假 timer/socket 单测（无真实墙钟依赖）。
 */

/** 重连状态机：驱动断线态 UI（overlay）渲染。 */
export type WebReconnectState =
  | { phase: "idle" }
  /** 退避等待中：attempt 为即将发起的第几次尝试（1-based），retryInMs 为剩余退避时长。 */
  | { phase: "waiting"; attempt: number; retryInMs: number }
  /** 正在发起第 attempt 次连接。 */
  | { phase: "connecting"; attempt: number }
  /** 重连成功（随后由调用方切换到正常 UI 并隐藏 overlay）。 */
  | { phase: "reconnected" }
  /** 达到 maxAttempts 上限，放弃自动重连（overlay 提供手动重试）。 */
  | { phase: "exhausted"; attempts: number };

export interface WebReconnectBackoffOptions {
  /** 首次退避基数（ms）。默认 500。 */
  baseDelayMs?: number;
  /** 退避上限（ms）——「有上限」的指数退避。默认 15000。 */
  maxDelayMs?: number;
  /**
   * 自动重连尝试次数上限。默认 `Number.POSITIVE_INFINITY`（持续重试，退避已封顶）；
   * 传入有限值后达上限转 `exhausted`，overlay 交回手动重试。
   */
  maxAttempts?: number;
  /** 抖动源（[0,1)）。默认 Math.random；测试可注入固定值以消除随机性。 */
  random?: () => number;
}

/**
 * 计算第 attempt 次（1-based）尝试前的退避时长：指数增长、封顶、叠加 full jitter。
 * full jitter（delay * random[0,1)）避免大量客户端在同一时刻齐步重连打爆刚恢复的 server。
 */
export function computeReconnectBackoffMs(
  attempt: number,
  options: WebReconnectBackoffOptions = {},
): number {
  const baseDelayMs = options.baseDelayMs ?? 500;
  const maxDelayMs = options.maxDelayMs ?? 15_000;
  const random = options.random ?? Math.random;
  const normalizedAttempt = Math.max(1, Math.floor(attempt));
  // 2**(attempt-1) 在 attempt 较大时溢出到 Infinity，Math.min 封顶后再抖动，天然安全。
  const exponential = baseDelayMs * 2 ** (normalizedAttempt - 1);
  const capped = Math.min(exponential, maxDelayMs);
  // full jitter：实际等待落在 [0, capped]，期望 capped/2，仍是指数级增长且封顶。
  return Math.round(capped * random());
}

type DefaultTimerHandle = ReturnType<typeof setTimeout>;

export interface WebReconnectControllerOptions<T, H = DefaultTimerHandle>
  extends WebReconnectBackoffOptions {
  /** 实际发起一次连接（通常是 connectViaWebSocket 的封装）。resolve = 成功，reject = 失败。 */
  connect: () => Promise<T>;
  /** 重连成功回调：调用方据此用新 services 重新渲染 app 并隐藏 overlay。 */
  onReconnected: (result: T) => void;
  /** 状态变更回调：驱动断线态 overlay。 */
  onStateChange?: (state: WebReconnectState) => void;
  /**
   * 注入 timer（测试用假 timer；默认全局 setTimeout/clearTimeout）。
   * 句柄类型 H 由调用方决定：生产为 `ReturnType<typeof setTimeout>`，假 timer 可用 number。
   */
  setTimeoutFn?: (handler: () => void, ms: number) => H;
  clearTimeoutFn?: (handle: H) => void;
}

export interface WebReconnectController {
  /** 收到 close 事件后调用：启动退避重连循环（幂等，已在进行中的循环不重复启动）。 */
  start(): void;
  /** 取消并清理挂起 timer（卸载/页面销毁时调用，防定时器泄漏）。 */
  cancel(): void;
  /** 当前尝试次数（0 = 尚未开始或已成功复位）。 */
  readonly attempt: number;
}

export function createWebReconnectController<T, H = DefaultTimerHandle>(
  options: WebReconnectControllerOptions<T, H>,
): WebReconnectController {
  const setTimeoutFn =
    options.setTimeoutFn ?? (((handler, ms) => setTimeout(handler, ms) as unknown as H));
  const clearTimeoutFn =
    options.clearTimeoutFn ?? (((handle) => clearTimeout(handle as unknown as DefaultTimerHandle)));
  const maxAttempts = options.maxAttempts ?? Number.POSITIVE_INFINITY;

  let attempt = 0;
  let timer: H | null = null;
  let cancelled = false;
  let looping = false;

  const emit = (state: WebReconnectState): void => {
    options.onStateChange?.(state);
  };

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeoutFn(timer);
      timer = null;
    }
  }

  function scheduleNext(): void {
    if (cancelled) {
      return;
    }
    if (attempt >= maxAttempts) {
      looping = false;
      emit({ phase: "exhausted", attempts: attempt });
      return;
    }
    attempt += 1;
    const retryInMs = computeReconnectBackoffMs(attempt, {
      ...(options.baseDelayMs !== undefined ? { baseDelayMs: options.baseDelayMs } : {}),
      ...(options.maxDelayMs !== undefined ? { maxDelayMs: options.maxDelayMs } : {}),
      ...(options.random ? { random: options.random } : {}),
    });
    emit({ phase: "waiting", attempt, retryInMs });
    timer = setTimeoutFn(() => {
      timer = null;
      if (cancelled) {
        return;
      }
      void runAttempt();
    }, retryInMs);
  }

  async function runAttempt(): Promise<void> {
    emit({ phase: "connecting", attempt });
    try {
      const result = await options.connect();
      if (cancelled) {
        return;
      }
      // 成功：复位计数、退出循环、通知调用方重新渲染。
      attempt = 0;
      looping = false;
      emit({ phase: "reconnected" });
      options.onReconnected(result);
    } catch {
      if (cancelled) {
        return;
      }
      // 失败：继续下一次退避（attempt 已在 scheduleNext 递增）。
      scheduleNext();
    }
  }

  return {
    start(): void {
      if (cancelled || looping) {
        return;
      }
      looping = true;
      scheduleNext();
    },
    cancel(): void {
      cancelled = true;
      looping = false;
      clearTimer();
    },
    get attempt(): number {
      return attempt;
    },
  };
}
