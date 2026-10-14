/**
 * 输入 admission 会话层（specs/windows-helper-producer.md §10.5/§10.6/§10.8 + §10.4 规则 3
 * 的退出收口原语）。
 *
 * 状态所有权（§1.3）：输入 admission 队列与 held-input JS 镜像归本模块（Helper 进程内
 * 会话层）；held 事实的**权威**在 native 注册表（addon），JS 镜像只服务 watchdog 自适应
 * 间隔（§10.8：held 非空 → 250ms）与「收据产出时点 held 为空」的可测不变量（§10.4 规则 5）。
 *
 * admission 裁决（§10.5）：所有派发 native 的操作经单一 FIFO 队列串行（并发=1）；
 * 队列深度上限 8（入队即满 → SessionBusyError → wire controller_busy）；排队等待 >5s →
 * 放弃执行（同 busy——在角色 B MUTATING_CALL_TIMEOUT_MS=10s 内给出确定 not_sent 应答，
 * 而不是让客户端超时进入传输层 possiblySent 歧义）；broker_info/request_access/
 * stop_computer_control 旁路不入队。
 *
 * stop 编排（§10.6 钉死时序）：先阻断出队 → ① cancelOperations（同步置旗）→ ② await
 * 在途 settle → ③ releaseAllHeldInputs → ④ 清空队列（每个被清的请求以 SessionBusyError
 * 收口 = 排队未派发、确定 not_sent）→ ⑤ stop 自身收据由 backend 构造。
 * 「先阻断出队再置旗」排除竞态：否则 ② settle 后 admission 会立刻出队下一项，令 stop
 * 的取消旗被新 Execute 入口清零吃掉（native 旗标清零语义见 addon pointer.cc 注释）。
 *
 * 纯 TS + 注入 driver（§10.11 模块规则①：不得 import native-driver）。
 */
import type { CuaNativeDriver } from "./driver-contract.js";

/** 队列拒绝（队满 / 排队超时 / 被 stop 清空）——wire 层映射 controller_busy（§10.5/§10.6）。 */
export class SessionBusyError extends Error {
  constructor(readonly reason: "queue-full" | "queue-timeout" | "stopped") {
    super(`input session busy: ${reason}`);
    this.name = "SessionBusyError";
  }
}

/** 队列深度上限（§10.5 钉死）。 */
export const MAX_QUEUE_DEPTH = 8;
/** 排队超时（§10.5 钉死：>5s 放弃入队执行）。 */
export const QUEUE_TIMEOUT_MS = 5_000;
/** watchdog 间隔（§10.8 钉死：held 空 2000ms / 非空 250ms）。 */
export const WATCHDOG_IDLE_INTERVAL_MS = 2_000;
export const WATCHDOG_HELD_INTERVAL_MS = 250;
/** 退出路径 held 释放预算（§10.4 规则 3：≤300ms，宿主 shutdownTimeoutMs=1s 地板内）。 */
export const EXIT_RELEASE_BUDGET_MS = 300;

/** 在途即视为「可能持有输入」的操作类别（watchdog 收紧判据的一部分，§10.8）。 */
const HOLD_CAPABLE_KINDS: ReadonlySet<string> = new Set(["drag", "keys-hold", "mouse-hold"]);

export interface InputSessionOptions {
  maxQueueDepth?: number;
  queueTimeoutMs?: number;
  /** held 镜像 0↔非空 迁移回调（entry 的 watchdog 重臂用，§10.8）。 */
  onHeldChange?: () => void;
}

export interface InputSession {
  /** 经 admission 串行执行 fn（并发=1；队满/排队超时/被 stop 清空 → SessionBusyError）。 */
  submit<T>(kind: string, fn: () => Promise<T>): Promise<T>;
  /** stop_computer_control 的五步编排（§10.6）；返回释放计数供 stop 收据携带。 */
  stop(): Promise<{ released: number }>;
  /** held JS 镜像（§10.8 watchdog 判据；权威事实在 native 注册表）。 */
  hasHeldInput(): boolean;
  noteHeld(token: string): void;
  noteReleased(token: string): void;
  readonly heldMirrorSize: number;
  readonly queuedCount: number;
  readonly running: boolean;
}

export function createInputSession(
  driver: CuaNativeDriver,
  options: InputSessionOptions = {},
): InputSession {
  const maxQueueDepth = options.maxQueueDepth ?? MAX_QUEUE_DEPTH;
  const queueTimeoutMs = options.queueTimeoutMs ?? QUEUE_TIMEOUT_MS;
  const onHeldChange = options.onHeldChange;

  interface QueueItem {
    kind: string;
    fn: () => Promise<unknown>;
    resolve(value: unknown): void;
    reject(error: unknown): void;
    timer: ReturnType<typeof setTimeout>;
  }

  const queue: QueueItem[] = [];
  const heldMirror = new Set<string>();
  let runningItem: QueueItem | undefined;
  let stopping = false;
  let lastHeldState = false;

  const notifyHeldChange = (): void => {
    const next = heldMirror.size > 0 || (runningItem !== undefined && HOLD_CAPABLE_KINDS.has(runningItem.kind));
    if (next !== lastHeldState) {
      lastHeldState = next;
      onHeldChange?.();
    }
  };

  const pump = (): void => {
    if (runningItem !== undefined || stopping || queue.length === 0) return;
    const item = queue.shift() as QueueItem;
    clearTimeout(item.timer);
    runningItem = item;
    notifyHeldChange();  // hold-capable 在途 → watchdog 收紧（§10.8）
    void Promise.resolve()
      .then(item.fn)
      .then(
        (value) => {
          runningItem = undefined;
          notifyHeldChange();
          item.resolve(value);
          pump();
        },
        (error: unknown) => {
          runningItem = undefined;
          notifyHeldChange();
          item.reject(error);
          pump();
        },
      );
  };

  return {
    submit<T>(kind: string, fn: () => Promise<T>): Promise<T> {
      if (stopping) {
        // stop 编排进行中：新入队一律 busy（④ 清空语义的同窗口对偶；未入队 = 确定未派发）。
        return Promise.reject(new SessionBusyError("stopped"));
      }
      if (queue.length >= maxQueueDepth) {
        return Promise.reject(new SessionBusyError("queue-full"));
      }
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          // 排队超时（§10.5）：放弃入队执行——比让客户端超时进入传输层歧义更诚实。
          const index = queue.findIndex((entry) => entry.timer === timer);
          if (index === -1) return;  // 已被出队/清空，settle 由对应路径负责
          queue.splice(index, 1);
          reject(new SessionBusyError("queue-timeout"));
        }, queueTimeoutMs);
        queue.push({
          kind,
          fn: fn as () => Promise<unknown>,
          resolve: resolve as (value: unknown) => void,
          reject,
          timer,
        });
        pump();
      });
    },

    async stop(): Promise<{ released: number }> {
      // §10.6 钉死时序。stopping 先行阻断出队与新入队（竞态排除见文件头注释）。
      stopping = true;
      try {
        // ① 同步置取消旗（在途循环 ≤500ms 内以 canceled 收口）。
        driver.cancelOperations();
        // ② await 当前 admission 在途操作 settle（不要求它必然被取消——尚未进入 native
        // Execute 的操作会以 accepted 完整收口，stop 只保证等它落地）。
        if (runningItem !== undefined) {
          await new Promise<void>((resolveSettled) => {
            const check = (): void => {
              if (runningItem === undefined) {
                resolveSettled();
                return;
              }
              setTimeout(check, 10);
            };
            check();
          });
        }
        // ③ 幂等释放全部 held（native 注册表是权威；JS 镜像同步清空）。
        //    释放失败（Ambiguous）向上传播 → stop 自身 possibly_sent 收据（§10.6/C08 case 10 同型）。
        const outcome = await driver.releaseAllHeldInputs();
        heldMirror.clear();
        notifyHeldChange();
        // ④ 清空队列：每个被清的请求以 SessionBusyError("stopped") 收口
        //    （排队未派发 = 确定 not_sent → wire ok:false controller_busy，诚实）。
        const pending = queue.splice(0, queue.length);
        for (const item of pending) {
          clearTimeout(item.timer);
          item.reject(new SessionBusyError("stopped"));
        }
        // ⑤ 收据事实（stop 自身收据由 backend 构造，含固定 message 字面量）。
        return { released: outcome.released };
      } finally {
        // stop 非会话闩锁（§10.6）：stop 后的新动作正常受理。
        stopping = false;
        pump();
      }
    },

    hasHeldInput(): boolean {
      return (
        heldMirror.size > 0 || (runningItem !== undefined && HOLD_CAPABLE_KINDS.has(runningItem.kind))
      );
    },

    noteHeld(token: string): void {
      heldMirror.add(token);
      notifyHeldChange();
    },

    noteReleased(token: string): void {
      heldMirror.delete(token);
      notifyHeldChange();
    },

    get heldMirrorSize(): number {
      return heldMirror.size;
    },

    get queuedCount(): number {
      return queue.length;
    },

    get running(): boolean {
      return runningItem !== undefined;
    },
  };
}

/** watchdog 间隔映射（§10.8：held 非空收紧至 250ms；纯函数供 entry 与单测共用）。 */
export function watchdogIntervalMs(hasHeld: boolean): number {
  return hasHeld ? WATCHDOG_HELD_INTERVAL_MS : WATCHDOG_IDLE_INTERVAL_MS;
}

/**
 * 退出收口原语（§10.4 规则 3 的「统一收口点」）：一切退出路径——IPC shutdown、watchdog
 * 父进程消失、scheduleFailure（含 uncaughtException/unhandledRejection）、A3 poisoned≥3
 * 自终结——在 process.exit 前经本收口幂等执行「取消在途 + 释放 held」，预算 ≤300ms；
 * 超时/失败不阻断退出（兜底后仍退出）。释放挂接在收口点而非散落各退出调用点——
 * 枚举会漏、收口点不会，后续切片新增退出路径自动被覆盖。
 * 如实登记残余风险（§10.4）：宿主 kill -9 / 蓝屏等硬终止无法执行释放，按键遗留至系统
 * 下一次输入状态复位——软件不可消除，已接受。
 */
export interface ExitConvergence {
  /** 幂等：并发/重复调用只有第一次执行释放，其余立即返回。 */
  converge(): Promise<void>;
}

export function createExitConvergence(deps: {
  cancel: () => void;
  release: () => Promise<unknown>;
  budgetMs?: number;
}): ExitConvergence {
  const budgetMs = deps.budgetMs ?? EXIT_RELEASE_BUDGET_MS;
  let done: Promise<void> | undefined;
  return {
    converge(): Promise<void> {
      if (done) return done;
      done = (async () => {
        try {
          // 取消先行：在途注入循环 ≤500ms 内退出；释放不等它（预算封顶），
          // native 注册表保证「凡 JS 发起的 held 都被释放」与在途动作自身的
          // cleanup 幂等重叠（重复 UP 对 OS 是无害 no-op）。
          deps.cancel();
        } catch {
          // cancel 是同步旗标操作，理论不抛；防御性吞掉（退出路径不阻断）。
        }
        try {
          await Promise.race([
            Promise.resolve()
              .then(deps.release)
              .then(() => undefined),
            new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, budgetMs)),
          ]);
        } catch {
          // 释放失败不阻断退出（§10.4 规则 3：超时兜底后仍退出）。
        }
      })();
      return done;
    },
  };
}
