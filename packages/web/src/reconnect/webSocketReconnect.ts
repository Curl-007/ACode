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
  /**
   * 连接已 resolve 但控制器在此期间被 `cancel()`（手动重试换代 / 真卸载丢弃）时回调：
   * 调用方据此释放这条**孤儿连接**（dispose WebSocket + ChannelClient），而非静默丢弃。
   * 修复依据：此前 `if (cancelled) return` 直接丢掉已建立的活连接，无任何处置路径 → 泄漏 socket。
   */
  onDiscard?: (result: T) => void;
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
  /**
   * 终态取消：清理挂起 timer + 置终态标志（此后 start/pause/resume 均 no-op），并清延迟意图。
   * **仅真卸载调用**（pagehide 且 persisted=false），防定时器泄漏。
   */
  cancel(): void;
  /**
   * 非终态暂停（bfcache 进入用）：清挂起 timer（避免冻结期以陈旧退避立即触发）、记「循环在途」意图，
   * 但**不置终态**，可被 resume() 唤醒。幂等；cancel 后 no-op。
   */
  pause(): void;
  /**
   * 唤醒 pause() 冻结的循环（bfcache 恢复用）：按当前 attempt 重新武装退避，或（若冻结期收到 start()）
   * 推进到下一次退避。幂等；未暂停或已 cancel 时 no-op。
   */
  resume(): void;
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
  /**
   * 「重连意图」的唯一真源：true 表示当前想要一条连接（退避等待 / 正在 connect / 冻结待恢复）。
   * start() 置真、成功或 cancel() 置假。bfcache 暂停不清它——恢复后据此判断是否重新武装退避。
   */
  let looping = false;
  /**
   * bfcache 暂停态（非终态）：`paused` 冻结退避循环、等待 resume()。冻结期不排/不触发 timer
   *（避免以陈旧退避时长立即重连），但保留 `looping` 意图；resume() 据 looping 决定是否重新武装。
   */
  let paused = false;
  /**
   * 是否有 connect() 正在 await 中（connecting 阶段）。resume() 据此避免重复武装：
   * 若在途 connect 之上再排一个 timer，timer 到期会发起**第二个** connect，两个都 resolve 就会
   * 双发 onReconnected（重挂 Root 两次）+ 泄漏一条孤儿 socket。in-flight 时由 runAttempt 自身
   * 的成功/失败分支驱动下一步，resume() 不补排。
   */
  let inFlight = false;

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
    if (cancelled || paused) {
      return;
    }
    // 防御性清理：arm 前统一 clearTimer()，杜绝任何交叠路径下覆盖并泄漏前一个 timer。
    clearTimer();
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
      // `!looping` 守卫：在途 connect 已成功（looping 复位）后，任何 stale timer 都不得再发起多余连接。
      if (cancelled || paused || !looping) {
        return;
      }
      void runAttempt();
    }, retryInMs);
  }

  async function runAttempt(): Promise<void> {
    emit({ phase: "connecting", attempt });
    inFlight = true;
    try {
      const result = await options.connect();
      inFlight = false;
      if (cancelled) {
        // 控制器已终态取消（换代/真卸载）后 connect 才 resolve：这是孤儿连接，交回调用方释放，
        // 不静默丢弃（否则泄漏已打开的 WebSocket + ChannelClient）。
        options.onDiscard?.(result);
        return;
      }
      // 成功：复位计数、退出循环、清可能残留的 timer、通知调用方重新渲染。成功的连接始终胜出，
      // 不受 pause 影响（bfcache 冻结期 JS 挂起，connect resolve 只在恢复后继续）。
      attempt = 0;
      looping = false;
      clearTimer();
      emit({ phase: "reconnected" });
      options.onReconnected(result);
    } catch {
      inFlight = false;
      if (cancelled) {
        return;
      }
      // 失败：继续下一次退避（attempt 已在 scheduleNext 递增）。paused 时 scheduleNext 自身 no-op，
      // looping 意图保留，resume() 再武装。
      scheduleNext();
    }
  }

  return {
    start(): void {
      if (cancelled || looping) {
        return;
      }
      looping = true;
      if (paused) {
        // 冻结期收到 close（socket 后台被回收）：记下重连意图，resume() 时再武装退避。
        return;
      }
      scheduleNext();
    },
    cancel(): void {
      cancelled = true;
      looping = false;
      paused = false;
      clearTimer();
    },
    pause(): void {
      if (cancelled || paused) {
        return;
      }
      paused = true;
      // 清挂起 timer：避免冻结期/解冻瞬间以陈旧退避时长立即触发；resume() 会按当前 attempt 重新武装。
      // looping 意图保留——恢复后据此判断是否需要继续重连。
      clearTimer();
    },
    resume(): void {
      if (cancelled || !paused) {
        return;
      }
      paused = false;
      // 只有「想重连且没有 connect 在途」才补排 timer。若冻结时有 connect 在途（inFlight），
      // 该 connect 的 resolve/reject 会在解冻后驱动下一步（成功→onReconnected，失败→scheduleNext），
      // 此刻补排会多开一条 socket + 双发 onReconnected（见 inFlight 注释）。
      if (looping && !inFlight) {
        // 按当前 attempt 重新武装（scheduleNext 内 attempt+=1 推进到下一次），恢复退避节奏。
        scheduleNext();
      }
    },
    get attempt(): number {
      return attempt;
    },
  };
}

/**
 * 连接代际守卫（specs/web-reconnect.md R5.4 / 验收 11）。
 *
 * 修复依据：每次 `establish()` 注册 `onClose: () => controller?.start()`，闭包引用同一个可变 controller。
 * `retryNow()` 换代后，旧（孤儿）socket 的迟到 close 会驱动**当前**健康控制器 → 在正常会话上误弹断线
 * overlay + 多开 socket + 重挂 Root。代际 token 让每个连接的 onClose 只在自己那代仍是当前代时才驱动。
 *
 * 唯一所有者是本闭包内的 `current` 计数器；`next()` 换代（前移 current），`capture()` 在建立连接时
 * 记录当时代并返回一个「是否仍是当前代」的判定闭包。
 */
export interface WebConnectionGenerationGuard {
  /** 换代：作废当前代（前移计数器）。retryNow 建新控制器前调用。 */
  next(): void;
  /** 建立一次连接时调用：捕获当时代，返回判定「该代是否仍是当前代」的谓词。 */
  capture(): () => boolean;
  /** 当前代 id（测试用）。 */
  readonly current: number;
}

export function createWebConnectionGenerationGuard(
  initialGeneration = 1,
): WebConnectionGenerationGuard {
  let current = initialGeneration;
  return {
    next(): void {
      current += 1;
    },
    capture(): () => boolean {
      const myGeneration = current;
      return () => myGeneration === current;
    },
    get current(): number {
      return current;
    },
  };
}
