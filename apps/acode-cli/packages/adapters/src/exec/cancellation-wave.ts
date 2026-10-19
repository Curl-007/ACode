// Mechanism ported from oh-my-pi (MIT) docs/natives-shell-pty-process.md 与 crates/pi-shell — 语义参照，Copyright (c) 2025 Mario Zechner & Stencil Labs
// ============================================================
// 进程树取消波次（specs/fs-hotpath-mechanisms.md R4）
//
// 结构化取消契约（三因）与 TERM→KILL 波次：
//   timeout      → timedOut=true, cancelled=false
//   user/signal  → timedOut=false, cancelled=true（abort 信号 = 用户停止）
//   output_limit → cancelled=true + output_limit failure
// 波次：wave1 优雅终止（POSIX SIGTERM 组+树；Windows taskkill /T 不带 /F）
//       → 宽限（POSIX 2s / Windows 5s，对齐 omp）→ wave2 强制（SIGKILL / taskkill /T /F）。
// per-run 实例化；spawn/kill/timer 全部可注入，供桩进程树的波次单测。
// ============================================================

import type { StopReason } from "./execution-adapter-types.js";

/** POSIX wave1→wave2 宽限（对齐 omp 2 秒）。 */
export const CANCEL_WAVE_GRACE_MS = 2_000;
/** Windows wave1→wave2 宽限（对齐 omp 5 秒）。 */
export const CANCEL_WAVE_GRACE_MS_WINDOWS = 5_000;

/** 结构化取消原因：Timeout / User(含 abort 信号) / OutputLimit 三因。 */
export type CancellationCause = "timeout" | "user" | "output_limit";

/** run 层 StopReason → 结构化取消原因（Timeout / User / OutputLimit 三因映射）。 */
export function cancellationCauseFromStopReason(reason: StopReason): CancellationCause {
  if (reason === "timeout") return "timeout";
  if (reason === "output_limit") return "output_limit";
  return "user";
}

/** run 层运行态标志 → 结构化取消原因（供取消波次随波下发，三因可区分）。 */
export function cancelCauseFor(timedOut: boolean, outputLimitExceeded: boolean): CancellationCause {
  if (timedOut) return "timeout";
  if (outputLimitExceeded) return "output_limit";
  return "user";
}

export function cancellationGraceMs(platform: NodeJS.Platform | string): number {
  return platform === "win32" ? CANCEL_WAVE_GRACE_MS_WINDOWS : CANCEL_WAVE_GRACE_MS;
}

export interface CancellationWaveDeps {
  /** wave1：优雅终止尝试（best effort，允许失败）。 */
  gracefulStop: () => Promise<void> | void;
  /** wave2：宽限到期后的强制终止。 */
  forceStop: () => Promise<void> | void;
  /** 波次间定时器；默认 setTimeout，测试注入虚拟时钟。 */
  scheduleTimer?: (callback: () => void, ms: number) => { cancel: () => void };
}

export interface CancellationWaveHandle {
  readonly cause: CancellationCause;
  /** wave2（含 forceStop settle）完成；进程在 wave1 后自然退出时也会 resolve。 */
  readonly completion: Promise<void>;
  /** 子进程在波次间自然退出时调用：撤销未到的 wave2，completion 立即 resolve。 */
  dispose: () => void;
}

/**
 * 启动 per-run 取消波次。wave1 立即触发；宽限到期触发 wave2。
 * forceStop 仅触发一次；重复 dispose 幂等。
 */
export function startCancellationWave(
  deps: CancellationWaveDeps,
  options: { cause: CancellationCause; graceMs: number },
): CancellationWaveHandle {
  const schedule =
    deps.scheduleTimer ??
    ((callback, ms) => {
      const timer = setTimeout(callback, ms);
      timer.unref?.();
      return { cancel: () => clearTimeout(timer) };
    });

  let wave2Started = false;
  let resolveCompletion: () => void = () => undefined;
  const completion = new Promise<void>((resolve) => {
    resolveCompletion = resolve;
  });

  const runForceStop = async (): Promise<void> => {
    if (wave2Started) return;
    wave2Started = true;
    try {
      await deps.forceStop();
    } catch {
      // forceStop 失败不阻断 completion：调用方的 FORCE_EXIT 兜底仍会结算。
    }
    resolveCompletion();
  };

  const gracefulResult = deps.gracefulStop();
  void Promise.resolve(gracefulResult).catch(() => undefined);

  const timer = schedule(() => void runForceStop(), options.graceMs);

  return {
    cause: options.cause,
    completion,
    dispose: () => {
      timer.cancel();
      resolveCompletion();
    },
  };
}
