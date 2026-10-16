// print() 假死守卫（specs/main-stall-diagnostics.md R12）：window.print() 的原生
// 对话框会同步阻塞 renderer 主线程，Chromium 随后判 unresponsive——这是预期行为
// 不是故障。renderer 在执行前/后经 IPC 上报 printing=true/false，main 按
// webContentsId 记账，unresponsive 聚合时给出 print_call 归因。
//
// 守卫只影响归因与日志级别，不执行任何 kill（本波诊断-only 裁决）；10min 信任
// 上限防「print 结束上报丢失」造成永久护身。纯 Node 状态机，node:test 可驱动。
import type { DiagnosticsIpcEventLike, DiagnosticsIpcMainLike } from "./contentBreadcrumb.js";
import { isTrustedRendererSenderFrame, type SenderFrameLike } from "./rendererFrameTrust.js";

// TODO(接线): 通道常量待上移 packages/shared/src/channels.ts（PlatformChannels，
// W1-5 所有）；上移前 main 侧以本常量为事实源，preload/ui 接线使用同值字符串。
export const PRINT_CALL_IPC_CHANNEL = "acode:print-call";

/** print 状态的最大信任年龄：超过即 too_old（结束上报可能丢失，不能永久护身）。 */
export const PRINT_CALL_MAX_TRUSTED_AGE_MS = 600_000;

/** print_call 归因闭集（spec R12）。 */
export type PrintCallAttribution =
  | "none"
  | "in_progress"
  | "too_old"
  | "window_focused"
  | "switch_off";

export interface PrintCallEvaluation {
  /** true = 归因 print 假死，不判卡顿（聚合日志降 info）。 */
  skipStallVerdict: boolean;
  printCall: PrintCallAttribution;
  printCallAgeMs: number | null;
}

/** renderer 上报的 sender 结构面（接线从 IpcMainEvent 折算）。 */
export interface PrintCallSender {
  webContentsId: number;
  frame: SenderFrameLike | null | undefined;
}

export interface PrintCallGuard {
  /**
   * 记账一次 print 前/后上报；返回是否采纳（false = sender 校验拒绝，状态不变）。
   * 重复的开始上报覆盖起点（以最近一次为准）。
   */
  reportPrintCall(sender: PrintCallSender, printing: boolean): boolean;
  /** unresponsive 到达时的归因裁决（纯读 + too_old 自愈清理）。 */
  evaluate(webContentsId: number, context: { windowFocused: boolean }): PrintCallEvaluation;
  /** 主帧导航或 webContents 销毁时清状态（打印对话框不可能跨导航存活）。 */
  clearForWebContents(webContentsId: number): void;
  /** 诊断/测试用只读视图。 */
  isInProgress(webContentsId: number, nowMs?: number): boolean;
}

export interface CreatePrintCallGuardOptions {
  /** 单调时钟注入（默认 performance.now）；假时钟单测用。 */
  now?: () => number;
  maxTrustedAgeMs?: number;
  /** 运行时开关（缺省恒开）；关闭时归因 switch_off、照常判卡顿。 */
  guardEnabled?: () => boolean;
  isTrustedSenderFrame?: (frame: SenderFrameLike | null | undefined) => boolean;
}

export function createPrintCallGuard(options: CreatePrintCallGuardOptions = {}): PrintCallGuard {
  const now = options.now ?? (() => performance.now());
  const maxTrustedAgeMs = options.maxTrustedAgeMs ?? PRINT_CALL_MAX_TRUSTED_AGE_MS;
  const guardEnabled = options.guardEnabled ?? (() => true);
  const isTrusted = options.isTrustedSenderFrame ?? isTrustedRendererSenderFrame;
  /** print 进行中状态按 wc 记账（多窗口各自独立），非全局单槽。 */
  const inProgress = new Map<number, { startedAtMs: number }>();

  const ageOf = (startedAtMs: number, atMs: number): number | null => {
    const age = atMs - startedAtMs;
    return Number.isFinite(age) && age >= 0 ? age : null;
  };

  return {
    reportPrintCall(sender, printing) {
      // sender 校验（spec R12）：主帧 + 应用自身 origin；guest 远程页与子帧一律拒绝。
      if (!sender || !Number.isInteger(sender.webContentsId)) return false;
      if (!isTrusted(sender.frame)) return false;
      if (printing) {
        inProgress.set(sender.webContentsId, { startedAtMs: now() });
      } else {
        inProgress.delete(sender.webContentsId);
      }
      return true;
    },
    evaluate(webContentsId, context) {
      const state = inProgress.get(webContentsId);
      if (!state) return { skipStallVerdict: false, printCall: "none", printCallAgeMs: null };
      const at = now();
      const age = ageOf(state.startedAtMs, at);
      if (age === null || age >= maxTrustedAgeMs) {
        // 超信任上限（或时钟异常）：视为已结束并清账，照常判卡顿。
        inProgress.delete(webContentsId);
        return {
          skipStallVerdict: false,
          printCall: "too_old",
          printCallAgeMs: age === null ? null : Math.round(age),
        };
      }
      const roundedAge = Math.round(age);
      // 原生打印对话框必然抢走窗口焦点：窗口仍聚焦 ⇒ 阻塞另有原因，照常判卡顿。
      if (context.windowFocused) {
        return { skipStallVerdict: false, printCall: "window_focused", printCallAgeMs: roundedAge };
      }
      if (!guardEnabled()) {
        return { skipStallVerdict: false, printCall: "switch_off", printCallAgeMs: roundedAge };
      }
      return { skipStallVerdict: true, printCall: "in_progress", printCallAgeMs: roundedAge };
    },
    clearForWebContents(webContentsId) {
      inProgress.delete(webContentsId);
    },
    isInProgress(webContentsId, nowMs) {
      const state = inProgress.get(webContentsId);
      if (!state) return false;
      const age = ageOf(state.startedAtMs, nowMs ?? now());
      return age !== null && age < maxTrustedAgeMs;
    },
  };
}

export interface RegisterPrintCallIpcOptions {
  ipcMain: DiagnosticsIpcMainLike;
  guard: PrintCallGuard;
  logger: { warn: (...args: unknown[]) => void };
  channel?: string;
}

/**
 * 注册 print-call send-only 通道；返回注销函数。sender 校验失败只 warn 事件名
 * 不回显帧 URL（日志纪律）；payload 必须是 boolean（畸形载荷静默丢弃——send-only
 * 诊断通道不回错，避免给 renderer 增加可探测的应答面）。
 */
export function registerPrintCallIpc(options: RegisterPrintCallIpcOptions): () => void {
  const channel = options.channel ?? PRINT_CALL_IPC_CHANNEL;
  const listener = (event: DiagnosticsIpcEventLike, payload: unknown): void => {
    const webContentsId = event?.sender?.id;
    if (typeof webContentsId !== "number" || !Number.isInteger(webContentsId)) return;
    // payload 先校验后记账：畸形载荷不得触碰守卫状态（否则 "yes" 之类会被当成
    // printing=false 误清账）。send-only 诊断通道不回错，避免给 renderer 增加
    // 可探测的应答面。
    if (payload !== true && payload !== false) {
      options.logger.warn("[renderer-diag] print-call payload ignored", {
        event: "print_call_payload_invalid",
      });
      return;
    }
    const adopted = options.guard.reportPrintCall(
      { webContentsId, frame: event?.senderFrame },
      payload,
    );
    if (!adopted) {
      options.logger.warn("[renderer-diag] print-call sender rejected", {
        event: "print_call_sender_rejected",
      });
    }
  };
  options.ipcMain.on(channel, listener);
  return () => {
    options.ipcMain.removeListener(channel, listener);
  };
}
