/**
 * 真 UIA driver（specs/windows-helper-producer.md §5.3/§11.1；模块规则②同 native-driver：
 * 只被 windows-helper.ts 组装路径 import）。包装 addon 的 UIA 导出面：
 * - 错误归类走 driver-contract 的 classifyNativeError（§10.3 二分契约；uia_timeout 的
 *   只读/变更分流已在归类函数内钉死）；
 * - 卡死隔离监督（§11.1）：任何 uia_timeout 拒绝后读 workerStats，poisoned 累计 ≥3 →
 *   onPoisonExhausted 回调（entry 接 scheduleFailure("internal-helper-failure", 1)——
 *   自终结同样先经 §10.4 规则 3 的统一释放收口，held 零遗留对该路径同样成立）。
 *   poison-detach-rebuild 本体在 native（COM 挂死线程不可安全 kill，泄漏并如实登记）；
 * - COM 接口指针绝不过边界：本模块进出全是不透明 token 与纯数据（A3-AC-1 静态断言面）。
 */
import {
  classifyNativeError,
  type CaptureRect,
  type CuaUiaDriver,
  type UiaActionName,
  type UiaAppFact,
  type UiaElementFact,
  type UiaTreeBudget,
  type UiaTreeResult,
  type UiaWindowFact,
} from "./driver-contract.js";

type AddonSurface = Record<string, unknown>;

/** UIA 导出在场性清单（capabilities.uia 与 6 handler 注册的两面同源事实，§13 不变量②）。 */
export const UIA_EXPORTS = [
  "listApplications",
  "listWindows",
  "captureUiTree",
  "releaseStateToken",
  "uiaWorkerStats",
  "elementSetValue",
  "elementSelectText",
  "elementPerformAction",
  "elementClickablePoint",
  "elementInvoke",
  "elementScroll",
  "uiaWorkerShutdown",
] as const;

export interface UiaDriverOptions {
  /** poisoned ≥3 的自终结回调（entry 注入；幂等由 scheduleFailure 保证）。 */
  onPoisonExhausted?: () => void;
  /** 自终结阈值（§11.1 钉死 3；测试可注入更小值）。 */
  poisonThreshold?: number;
}

function hasFunctions(addon: AddonSurface, names: readonly string[]): boolean {
  return names.every((name) => typeof addon[name] === "function");
}

export function createUiaDriver(addon: object, options: UiaDriverOptions = {}): CuaUiaDriver {
  const surface = addon as AddonSurface;
  const presence = hasFunctions(surface, UIA_EXPORTS);
  const threshold = options.poisonThreshold ?? 3;
  let exhaustionSignaled = false;

  /** 变更类（pattern 派发面）调用包装：拒绝按二分归类；uia_timeout 触发 poison 监督。 */
  function callMutating<T>(name: string, ...args: unknown[]): Promise<T> {
    return invoke<T>(name, true, args);
  }

  /** 观察类调用包装（重试恒安全）。 */
  function callReadOnly<T>(name: string, ...args: unknown[]): Promise<T> {
    return invoke<T>(name, false, args);
  }

  function invoke<T>(name: string, mutating: boolean, args: unknown[]): Promise<T> {
    const target = surface[name];
    if (typeof target !== "function") {
      // 结构性不可达（handler 注册以 presence 为键）；防御 = 确定未派发。
      return Promise.reject(classifyNativeError({}, mutating));
    }
    let pending: unknown;
    try {
      pending = (target as (...callArgs: unknown[]) => unknown)(...args);
    } catch {
      // 同步 throw = native 参数校验（worker 未入队）→ 确定未派发（§18 第 7 条规则①）。
      return Promise.reject(classifyNativeError({}, false));
    }
    return Promise.resolve(pending as Promise<T>).catch(async (error: unknown) => {
      const classified = classifyNativeError(error, mutating);
      // 卡死隔离监督（§11.1）：uia_timeout = worker 被 poison 一次；累计 ≥3 → 自终结回调。
      const shape = (error && typeof error === "object" ? error : {}) as { code?: unknown };
      if (shape.code === "uia_timeout" && !exhaustionSignaled) {
        try {
          const statsTarget = surface.uiaWorkerStats;
          if (typeof statsTarget === "function") {
            const stats = (await (statsTarget as () => Promise<{ poisoned: number }>)()) ?? {
              poisoned: 0,
            };
            if (Number.isInteger(stats.poisoned) && stats.poisoned >= threshold) {
              exhaustionSignaled = true;
              options.onPoisonExhausted?.();
            }
          }
        } catch {
          // 统计读取失败不改变原始错误归类（自终结是兜底，不是主路径）。
        }
      }
      throw classified;
    });
  }

  return {
    presence,

    shutdownWorker(): void {
      // 同步直达（停止信号不经任何异步队列，cancelOperations 同族纪律）；防御性吞错——
      // 退出路径不因停止钩子失败而阻断（§10.4 规则 3 收口语义）。
      const target = surface.uiaWorkerShutdown;
      if (typeof target !== "function") return;
      try {
        (target as () => unknown)();
      } catch {
        // spawn-即-detach 已结构性消除 joinable 析构 terminate；钩子失败不改变退出。
      }
    },

    listApplications(): Promise<UiaAppFact[]> {
      return callReadOnly<{ apps: UiaAppFact[] }>("listApplications").then((r) => r.apps);
    },
    listWindows(pid: number | null): Promise<UiaWindowFact[]> {
      return callReadOnly<{ windows: UiaWindowFact[] }>("listWindows", pid).then((r) => r.windows);
    },
    captureUiTree(
      target: { pid: number; windowId?: number },
      budget: UiaTreeBudget,
      deadlineMs?: number,
    ): Promise<UiaTreeResult> {
      return callReadOnly<NativeTreeShape>("captureUiTree", target, budget, deadlineMs).then(
        fromNativeTree,
      );
    },
    releaseState(stateToken: number): Promise<void> {
      // best-effort：释放失败不向调用方传播（LRU 逐出路径吞错——代际清零兜底）。
      return callReadOnly<void>("releaseStateToken", stateToken).catch(() => undefined);
    },
    workerStats(): Promise<{ poisoned: number; generation: number }> {
      return callReadOnly<{ poisoned: number; generation: number }>("uiaWorkerStats");
    },

    elementSetValue(
      stateToken: number,
      index: number,
      value: string,
    ): Promise<{ verified: boolean }> {
      return callMutating<{ verified: boolean }>("elementSetValue", stateToken, index, value);
    },
    elementSelectText(
      stateToken: number,
      index: number,
      start: number,
      length: number,
    ): Promise<{ outcome: "selected" | "range-invalid" }> {
      return callMutating<{ outcome: "selected" | "range-invalid" }>(
        "elementSelectText",
        stateToken,
        index,
        start,
        length,
      );
    },
    elementPerformAction(stateToken: number, index: number, action: UiaActionName): Promise<void> {
      return callMutating<void>("elementPerformAction", stateToken, index, action);
    },
    elementInvoke(stateToken: number, index: number): Promise<{ invoked: boolean }> {
      return callMutating<{ invoked: boolean }>("elementInvoke", stateToken, index);
    },
    elementClickablePoint(
      stateToken: number,
      index: number,
    ): Promise<{ x: number; y: number } | null> {
      return callReadOnly<{ point: { x: number; y: number } | null }>(
        "elementClickablePoint",
        stateToken,
        index,
      ).then((r) => r.point);
    },
    elementScroll(
      stateToken: number,
      index: number,
      deltaX: number,
      deltaY: number,
    ): Promise<{ scrolled: boolean }> {
      return callMutating<{ scrolled: boolean }>("elementScroll", stateToken, index, deltaX, deltaY);
    },
  };
}

/** native captureUiTree 返回形态（window 为 null 时 JS 产 noObservableWindow 字面量）。 */
interface NativeTreeShape {
  stateToken: number;
  window: { windowId: number; title: string; bounds: CaptureRect } | null;
  elements: UiaElementFact[];
  truncated: boolean;
  totalElements: number;
}

function fromNativeTree(shape: NativeTreeShape): UiaTreeResult {
  return {
    stateToken: shape.stateToken,
    window: shape.window,
    elements: shape.elements,
    truncated: shape.truncated,
    totalElements: shape.totalElements,
  };
}
