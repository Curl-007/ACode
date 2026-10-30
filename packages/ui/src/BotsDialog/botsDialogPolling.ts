/**
 * BotsDialog 轮询的取消语义与守卫决策（批次 7 外迁）。
 *
 * BotsDialog 的四组轮询（绑定码结果 / 运行态 / 微信激活态 / 飞书与微信扫码注册）原先各自
 * 手写 `let cancelled = false` + timer 清理 + `if (cancelled) return;` 写回闸门，四处重复且
 * 无法在无 DOM 环境下验证。本模块把「定时器生命周期 + 取消后不回写」收成一个可注入计时器的
 * 轮询原语，并把每组轮询的「该不该开」收成决策函数（纯输入 → 布尔）。
 *
 * 语义与迁移前逐条一致：
 * - `interval` 模式 = 固定节拍（绑定码 / 微信激活 / 扫码注册）：立即先跑一次，再按 `intervalMs` 重复；
 * - `serial` 模式 = 串行自调度（运行态 / 微信扫码）：上一次 `run` 落定后才排下一次，
 *   避免慢 RPC 在上一请求未返回时堆叠（原注释：接口会长等待，`setInterval` 会连续 timeout）；
 * - `stop()` 之后不再触发任何 `run`，**已在途的 `run` 通过 `isCancelled()` 自行放弃写回**——
 *   这就是原实现四处 `if (cancelled) return;` 的等价物，只是把闸门收成原语的一部分。
 */
import type {
  BindCodeState,
  FeishuRegistrationState,
  WeixinRegistrationState,
} from "@/BotsDialog/shared.js";

export interface PollTimers {
  setInterval: (callback: () => void, delayMs: number) => unknown;
  clearInterval: (handle: unknown) => void;
  setTimeout: (callback: () => void, delayMs: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

/** 默认计时器：浏览器里 `globalThis` 的定时器与迁移前用的 `window.*` 是同一批实现。 */
export const DEFAULT_POLL_TIMERS: PollTimers = {
  setInterval: (callback, delayMs) => globalThis.setInterval(callback, delayMs),
  clearInterval: (handle) => globalThis.clearInterval(handle as ReturnType<typeof setInterval>),
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export type PollLoopMode = "interval" | "serial";

export interface CancellablePollLoop {
  start: () => void;
  stop: () => void;
  /** 已取消（组件卸载 / 条件失效）时 `run` 应放弃写回。 */
  isCancelled: () => boolean;
}

export interface CancellablePollLoopOptions {
  mode: PollLoopMode;
  intervalMs: number;
  /** 一次轮询；`isCancelled` 是写回闸门，与迁移前的 `cancelled` 变量同义。 */
  run: (isCancelled: () => boolean) => Promise<void>;
  /** 默认 true：先立即跑一次再排定时器（四组轮询全部如此）。 */
  immediate?: boolean;
  timers?: PollTimers;
}

export function createCancellablePollLoop({
  mode,
  intervalMs,
  run,
  immediate = true,
  timers = DEFAULT_POLL_TIMERS,
}: CancellablePollLoopOptions): CancellablePollLoop {
  let cancelled = false;
  let intervalHandle: unknown;
  let timeoutHandle: unknown;

  const isCancelled = () => cancelled;

  const clearAll = () => {
    if (intervalHandle !== undefined) {
      timers.clearInterval(intervalHandle);
      intervalHandle = undefined;
    }
    if (timeoutHandle !== undefined) {
      timers.clearTimeout(timeoutHandle);
      timeoutHandle = undefined;
    }
  };

  const runOnce = () => {
    if (cancelled) return;
    void run(isCancelled);
  };

  const scheduleSerialNext = () => {
    if (cancelled) return;
    timeoutHandle = timers.setTimeout(() => {
      timeoutHandle = undefined;
      void run(isCancelled).finally(() => {
        scheduleSerialNext();
      });
    }, intervalMs);
  };

  return {
    isCancelled,
    start: () => {
      if (cancelled) return;
      if (mode === "interval") {
        if (immediate) runOnce();
        intervalHandle = timers.setInterval(runOnce, intervalMs);
        return;
      }
      if (immediate) {
        void run(isCancelled).finally(() => {
          scheduleSerialNext();
        });
        return;
      }
      scheduleSerialNext();
    },
    stop: () => {
      cancelled = true;
      clearAll();
    },
  };
}

// ---- 守卫决策（每组轮询「该不该开」） ----

export function shouldTickBindCountdown(input: {
  open: boolean;
  bindCode: BindCodeState | null;
}): boolean {
  return input.open && input.bindCode !== null;
}

export function shouldPollBindResult(input: {
  open: boolean;
  bindCode: BindCodeState | null;
  bindExpired: boolean;
}): boolean {
  return input.open && input.bindCode !== null && !input.bindExpired;
}

/** 绑定码在轮询/刷新后已经落到「当前 Bot 已带 providerUserId」时立即收起（与服务层回写解耦）。 */
export function shouldCollapseBindCode(input: {
  bindCode: BindCodeState | null;
  selectedBotId: string | undefined;
  selectedBotProviderUserId: string | undefined;
}): boolean {
  return (
    input.bindCode !== null &&
    input.bindCode.botId === input.selectedBotId &&
    Boolean(input.selectedBotProviderUserId)
  );
}

export function shouldPollWeixinActivation(input: {
  open: boolean;
  provider: string | undefined;
  credentialRef: string | undefined;
  weixinActivatedAt: number | undefined;
}): boolean {
  return (
    input.open &&
    input.provider === "weixin" &&
    Boolean(input.credentialRef) &&
    !input.weixinActivatedAt
  );
}

export function shouldPollFeishuRegistration(input: {
  open: boolean;
  hasSelectedBot: boolean;
  isFeishuProvider: boolean;
  registration: FeishuRegistrationState | null;
}): boolean {
  return (
    input.open &&
    input.hasSelectedBot &&
    input.isFeishuProvider &&
    input.registration !== null &&
    input.registration.status === "pending"
  );
}

export function shouldPollWeixinRegistration(input: {
  open: boolean;
  hasSelectedBot: boolean;
  provider: string | undefined;
  registration: WeixinRegistrationState | null;
}): boolean {
  if (!input.open || !input.hasSelectedBot || input.provider !== "weixin" || !input.registration) {
    return false;
  }
  return (
    input.registration.status === "pending" || input.registration.status === "scanned"
  );
}

/** 绑定码倒计时（秒级文案 + 进度条共用同一份读数）。 */
export interface BindCountdown {
  remainingMs: number;
  expired: boolean;
  progress: number;
}

export function resolveBindCountdown(
  bindCode: BindCodeState | null,
  nowMs: number,
): BindCountdown {
  if (!bindCode) {
    return { remainingMs: 0, expired: false, progress: 0 };
  }
  const remainingMs = Math.max(0, bindCode.expiresAt - nowMs);
  return {
    remainingMs,
    expired: remainingMs <= 0,
    progress: Math.max(0, Math.min(100, (remainingMs / bindCode.ttlMs) * 100)),
  };
}
