/**
 * 真 driver（specs/windows-helper-producer.md §10.3/§10.11 模块规则②）：包装 addon 导出面，
 * 把 native 类型化错误（{code, dispatchStarted}）归类为二分契约——
 *   NativeRejectedError  = 确定未产生副作用 → wire ok:false 安全区；
 *   NativeAmbiguousError = 派发已启动、结果不可证 → possibly_sent 收据（禁止 ok:false）。
 * 归类事实源 = §10.3 表「wire 结果」列：
 *   - injection_rejected 恒 Ambiguous（SendInput 报告 0 条注入也可能是 UIPI 静默丢弃——
 *     注入面不可证，保守方向）；
 *   - 变更类 + dispatchStarted=true 的任何 code → Ambiguous（如 chord 主体已注入后
 *     前台丢失——副作用已发生，绝不谎称「确定未派发」）；
 *   - canceled → Rejected（mutating 的取消经结果字段 canceled:true 上报，抛错形态只
 *     出现在只读捕获面）；
 *   - uia_timeout（A3）：只读 → Rejected；变更类 → Ambiguous(native-timeout)；
 *   - 无 code 的 rejection：变更类 → Ambiguous（保守）；只读 → Rejected(internal_native)；
 *   - 同步 throw（参数校验类，派发前）→ 恒 Rejected(internal_native)——worker 未入队，
 *     结构性零副作用。
 *
 * 本模块**只允许 windows-helper.ts 组装路径 import**（§10.11 规则②；纯逻辑模块以
 * driver-contract.ts 的接口 + 错误类型对接 fake driver）。
 */
import {
  NativeRejectedError,
  classifyNativeError,
  type CapabilityPresence,
  type CaptureBudget,
  type CaptureRect,
  type CaptureResult,
  type CuaNativeDriver,
  type EnvironmentProbeResult,
  type ExpectedForegroundOptions,
  type MouseButtonName,
  type PressKeysEntry,
} from "./driver-contract.js";

// A3 起归类函数住 driver-contract（native-driver 与 uia-driver 共用；模块规则②禁止
// uia-driver import 本文件）。再导出保持既有深导入面兼容（a2 测试/评审引用）。
export { classifyNativeError } from "./driver-contract.js";

/** addon 加载面形状（native-loader 的 AxNativeAddon + A2 导出经 typeof 检查取用）。 */
type AddonSurface = Record<string, unknown>;

/** 导出在场性检查（§10.9：capabilities 与 handler 注册的两面同源事实，typeof 判定）。 */
function hasFunctions(addon: AddonSurface, names: readonly string[]): boolean {
  return names.every((name) => typeof addon[name] === "function");
}

const INPUT_EXPORTS = [
  "moveTo",
  "scrollAt",
  "drag",
  "mouseDown",
  "mouseUp",
  "sendText",
  "pressKeys",
  "releaseAllHeldInputs",
  "cancelOperations",
  "environmentProbe",
  "foregroundPid",
  "processExecutablePath",
] as const;

const CAPTURE_EXPORTS = ["captureDisplay", "captureWindow", "environmentProbe"] as const;
const CLIPBOARD_EXPORTS = ["clipboardWriteText", "environmentProbe"] as const;

export function createNativeDriver(addon: object): CuaNativeDriver {
  const surface = addon as AddonSurface;
  const capabilityPresence: CapabilityPresence = Object.freeze({
    input: hasFunctions(surface, INPUT_EXPORTS),
    capture: hasFunctions(surface, CAPTURE_EXPORTS),
    clipboard: hasFunctions(surface, CLIPBOARD_EXPORTS),
  });

  /** 变更类（派发面）调用包装：同步 throw = 派发前 → Rejected；异步 rejection 按二分归类。 */
  function callMutating<T>(name: string, ...args: unknown[]): Promise<T> {
    return invoke<T>(name, true, args);
  }

  /** 只读调用包装：rejection 保守度更低（重试恒安全），无 code → Rejected(internal_native)。 */
  function callReadOnly<T>(name: string, ...args: unknown[]): Promise<T> {
    return invoke<T>(name, false, args);
  }

  function invoke<T>(name: string, mutating: boolean, args: unknown[]): Promise<T> {
    const target = surface[name];
    if (typeof target !== "function") {
      // 结构性不可达（handler 注册以在场性为键）；防御 = 确定未派发。
      return Promise.reject(new NativeRejectedError("internal_native", `missing export: ${name}`));
    }
    let pending: unknown;
    try {
      pending = (target as (...callArgs: unknown[]) => unknown)(...args);
    } catch {
      // 同步 throw = native 参数校验（worker 未入队）→ 确定未派发。
      return Promise.reject(new NativeRejectedError("internal_native"));
    }
    return Promise.resolve(pending as Promise<T>).catch((error: unknown) => {
      throw classifyNativeError(error, mutating);
    });
  }

  return {
    capabilityPresence,

    environmentProbe(): Promise<EnvironmentProbeResult> {
      return callReadOnly<EnvironmentProbeResult>("environmentProbe");
    },
    foregroundPid(): Promise<{ pid: number | null }> {
      return callReadOnly<{ pid: number | null }>("foregroundPid");
    },
    heldInputSnapshot(): Promise<{ buttons: string[]; keys: number[] }> {
      return callReadOnly<{ buttons: string[]; keys: number[] }>("heldInputSnapshot");
    },
    asyncKeyState(vk: number): Promise<{ down: boolean }> {
      return callReadOnly<{ down: boolean }>("asyncKeyState", vk);
    },
    cursorPosition(): Promise<{ x: number; y: number }> {
      return callReadOnly<{ x: number; y: number }>("cursorPosition");
    },
    processExecutablePath(pid: number): Promise<{ path: string | null }> {
      return callReadOnly<{ path: string | null }>("processExecutablePath", pid);
    },

    moveTo(x: number, y: number, opts: ExpectedForegroundOptions): Promise<void> {
      return callMutating<void>("moveTo", x, y, opts);
    },
    scrollAt(
      x: number,
      y: number,
      deltaX: number,
      deltaY: number,
      opts: ExpectedForegroundOptions,
    ): Promise<void> {
      return callMutating<void>("scrollAt", x, y, deltaX, deltaY, opts);
    },
    drag(
      fromX: number,
      fromY: number,
      toX: number,
      toY: number,
      opts: ExpectedForegroundOptions & { button?: MouseButtonName },
    ): Promise<{ injectedPoints: number; canceled: boolean }> {
      return callMutating<{ injectedPoints: number; canceled: boolean }>(
        "drag",
        fromX,
        fromY,
        toX,
        toY,
        opts,
      );
    },
    mouseDown(button: MouseButtonName, opts: ExpectedForegroundOptions): Promise<void> {
      return callMutating<void>("mouseDown", button, opts);
    },
    mouseUp(
      button: MouseButtonName,
      opts: { mode: "action"; expectedForegroundPid: number } | { mode: "cleanup" },
    ): Promise<void> {
      // cleanup 模式是释放原语（免前台校验）：仍按变更类归类——释放注入也可能不可证，
      // 保守方向对「释放是否完成」同样成立（stop 自身失败 → possibly_sent，§10.6）。
      return callMutating<void>("mouseUp", button, opts);
    },
    sendText(
      text: string,
      opts: ExpectedForegroundOptions,
    ): Promise<{ injected: number; total: number; canceled: boolean }> {
      return callMutating<{ injected: number; total: number; canceled: boolean }>(
        "sendText",
        text,
        opts,
      );
    },
    pressKeys(
      keys: PressKeysEntry[],
      opts: ExpectedForegroundOptions & { holdMs?: number },
    ): Promise<{ canceled: boolean }> {
      return callMutating<{ canceled: boolean }>("pressKeys", keys, opts);
    },

    releaseAllHeldInputs(): Promise<{ released: number }> {
      return callMutating<{ released: number }>("releaseAllHeldInputs");
    },
    cancelOperations(): void {
      const target = surface.cancelOperations;
      if (typeof target !== "function") return;  // A1 形态 addon：无在途可取消（防御 no-op）
      (target as () => void)();
    },

    clipboardWriteText(text: string): Promise<void> {
      return callMutating<void>("clipboardWriteText", text);
    },

    captureDisplay(
      target: { monitorIndex: number } | { bounds: CaptureRect },
      budget: CaptureBudget,
    ): Promise<CaptureResult> {
      return callReadOnly<CaptureResult>("captureDisplay", target, budget);
    },
    captureWindow(windowToken: number, budget: CaptureBudget): Promise<CaptureResult> {
      return callReadOnly<CaptureResult>("captureWindow", windowToken, budget);
    },
  };
}
