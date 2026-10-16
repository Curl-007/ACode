// 同步 IPC worst-offender 归因（specs/main-stall-diagnostics.md R9）。
//
// 只测 ipcMain.handle handler 的**同步段**耗时：async handler 从调用到返回 promise
// 的同步前缀，sync handler 的整个函数体；await 之后的异步耗时不计入（那段时间
// main 线程并没有被阻塞，计入会污染归因）。
//
// 单一所有者纪律：worst-offender 只存在 tracker 闭包里，唯一读出路径是
// consumeWorst()（stall_report 到达时消费即清零），不存在第二份记账。
// 本文件纯 Node（performance.now），不 import electron，可被单测直接驱动。

/** label 白名单：小写字母与下划线，1-40 字符。非法 label 注册即抛错（spec R9）。 */
export const IPC_SYNC_LABEL_PATTERN = /^[a-z_]{1,40}$/;

export interface IpcSyncWorstOffender {
  label: string;
  /** 已四舍五入的同步段毫秒数。 */
  syncMs: number;
}

/**
 * `Symbol.dispose` 计时器的类型面。TS lib es2025 未含 esnext.disposable 类型
 * （`using` 关键字的静态检查面），这里用 symbol 索引签名做最小声明：运行时
 * Node ≥ 20 / Electron 内置 V8 均原生提供 Symbol.dispose，`using` / `await using`
 * 在 .mjs 与 esbuild 产物里都按语言规范触发 dispose。
 */
export type SyncSegmentTimer = { [disposeSymbol: symbol]: () => void };

/** Symbol.dispose 的最小值级读取（lib es2025 无该类型面，见 SyncSegmentTimer 注释）。 */
const SYMBOL_DISPOSE = (Symbol as unknown as { dispose: symbol }).dispose;

function defaultNowMs(): number {
  return performance.now();
}

/** label 合法性断言：注册路径共用；错误信息只回显钳制后的片段（日志纪律）。 */
export function assertValidIpcSyncLabel(label: unknown): asserts label is string {
  if (typeof label === "string" && IPC_SYNC_LABEL_PATTERN.test(label)) return;
  const echoed = typeof label === "string" ? JSON.stringify(label.slice(0, 64)) : typeof label;
  // 抛错而非静默降级：静默会让归因面变成死数据而无人察觉（spec R9）。
  throw new TypeError(`[ipc-sync-timing] invalid label ${echoed}: must match ^[a-z_]{1,40}$`);
}

/**
 * channel → label 的收敛派生（批量接线用）：剥 scheme 前缀（首个 `:` 之前）、
 * 小写、非 [a-z] 连续段折叠为单个 `_`、去首尾 `_`、截断 40 后再去尾部 `_`。
 * 派生结果仍必须过白名单，否则抛错（例如纯数字 channel）。
 */
export function deriveIpcSyncLabel(channel: string): string {
  const schemeEnd = channel.indexOf(":");
  const body = schemeEnd >= 0 ? channel.slice(schemeEnd + 1) : channel;
  const label = body
    .toLowerCase()
    .replace(/[^a-z]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 40)
    .replace(/_+$/gu, "");
  assertValidIpcSyncLabel(label);
  return label;
}

export interface IpcSyncTimingTracker {
  /**
   * 包装 ipcMain.handle 的 handler，只测同步段。接线形态：
   * `ipcMain.handle(channel, wrapIpcHandle(deriveIpcSyncLabel(channel), handler))`。
   * 泛型保持 handler 原始签名，接线处类型推断不受损。
   */
  wrapIpcHandle<Args extends unknown[], Result>(
    label: string,
    handler: (...args: Args) => Result,
  ): (...args: Args) => Result;
  /** `using` / `await using` 标注任意同步段；dispose 时记账到同一 worst-offender。 */
  createSyncSegmentTimer(label: string): SyncSegmentTimer;
  /** 手动记账（包装器与计时器共用入口）；NaN/负值忽略。 */
  record(label: string, syncMs: number): void;
  /** 消费即清零：返回窗口内最大值并重置（stall_report 到达时调用，spec R9/R13）。 */
  consumeWorst(): IpcSyncWorstOffender | null;
  /** 非破坏性读取（测试/诊断用）。 */
  peekWorst(): IpcSyncWorstOffender | null;
  /** 清空 worst-offender（不注销任何包装器）。 */
  reset(): void;
}

export interface CreateIpcSyncTimingTrackerOptions {
  /** 单调时钟注入（默认 performance.now）；假时钟单测用。 */
  now?: () => number;
}

export function createIpcSyncTimingTracker(
  options: CreateIpcSyncTimingTrackerOptions = {},
): IpcSyncTimingTracker {
  const now = options.now ?? defaultNowMs;
  let worst: { label: string; syncMs: number } | null = null;

  const record = (label: string, syncMs: number): void => {
    // NaN/负值忽略（时钟异常不污染归因）；严格大于才替换，并列时先到者保留。
    if (!(syncMs >= 0)) return;
    if (worst === null || syncMs > worst.syncMs) worst = { label, syncMs };
  };

  const consumeWorst = (): IpcSyncWorstOffender | null => {
    const current = worst;
    worst = null;
    return current ? { label: current.label, syncMs: Math.round(current.syncMs) } : null;
  };

  return {
    wrapIpcHandle(label, handler) {
      assertValidIpcSyncLabel(label);
      return (...args) => {
        const startedAt = now();
        try {
          return handler(...args);
        } finally {
          // finally 保证 handler 同步抛错时也记账（抛错前的同步段同样是阻塞）。
          record(label, now() - startedAt);
        }
      };
    },
    createSyncSegmentTimer(label) {
      assertValidIpcSyncLabel(label);
      const startedAt = now();
      return {
        [SYMBOL_DISPOSE]() {
          record(label, now() - startedAt);
        },
      };
    },
    record(label, syncMs) {
      assertValidIpcSyncLabel(label);
      record(label, syncMs);
    },
    consumeWorst,
    peekWorst() {
      return worst ? { label: worst.label, syncMs: Math.round(worst.syncMs) } : null;
    },
    reset() {
      worst = null;
    },
  };
}

/** 进程级默认 tracker：接线与 stallSampler 增强回调共用的单例面。 */
const defaultTracker = createIpcSyncTimingTracker();

export const wrapIpcHandle = defaultTracker.wrapIpcHandle;
export const createSyncSegmentTimer = defaultTracker.createSyncSegmentTimer;
export const consumeWorstIpcSyncOffender = defaultTracker.consumeWorst;
export const peekWorstIpcSyncOffender = defaultTracker.peekWorst;
export const resetIpcSyncWorstOffender = defaultTracker.reset;
