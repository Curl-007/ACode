/**
 * Driver 接口与类型化错误二分契约（specs/windows-helper-producer.md §10.1/§10.3/§10.11）。
 *
 * 本模块是 backend-a2/input-session（纯逻辑，CI 常驻单测）与 native-driver（真 driver，
 * 只被 windows-helper.ts 组装路径 import）之间的共享契约面——§10.11 模块规则①禁止纯逻辑
 * 模块 import native-driver，故接口与错误类型独立成文件（fake/real 同接口，规则③）。
 *
 * 二分判据（§10.3，C08 注入面）：
 * - NativeRejectedError  = 确定未产生副作用（校验/预检/前台拒绝/0 注入前的失败）
 *   → 允许 ok:false（「确定未派发」安全区，§10.12 铁律 1）；
 * - NativeAmbiguousError = 派发已启动、结果不可证（注入中途异常、超时、部分注入后状态
 *   未知）→ 必须 possibly_sent 收据，禁止 ok:false。
 */

/** native 类型化错误 code 封闭集（§10.3；A3 码位已预留，实现不得新增）。 */
export type NativeErrorCode =
  | "foreground_lost"
  | "non_interactive_desktop"
  | "target_changed"
  | "capture_minimized"
  | "capture_failed"
  | "budget_exceeded"
  | "clipboard_busy"
  | "clipboard_denied"
  | "injection_rejected"
  | "uia_timeout"
  | "stale"
  | "not_settable"
  | "not_selectable"
  | "action_unavailable"
  | "canceled"
  | "internal_native";

/** 确定未产生副作用的类型化失败（→ wire ok:false，§10.3/§10.12）。 */
export class NativeRejectedError extends Error {
  constructor(
    readonly code: NativeErrorCode,
    message?: string,
  ) {
    super(message ?? `native rejected: ${code}`);
    this.name = "NativeRejectedError";
  }
}

/** 派发已启动、结果不可证的类型化失败（→ possibly_sent 收据；禁止 ok:false，§10.12 铁律 1）。 */
export class NativeAmbiguousError extends Error {
  constructor(
    readonly code: NativeErrorCode,
    readonly reason: "native-dispatch-outcome-unknown" | "native-timeout",
    message?: string,
  ) {
    super(message ?? `native dispatch outcome unknown: ${code}`);
    this.name = "NativeAmbiguousError";
  }
}

export type MouseButtonName = "left" | "right" | "middle";

export interface EnvironmentProbeResult {
  interactiveDesktop: boolean;
  sessionZero: boolean;
  dpiAware: boolean;
}

export interface CaptureRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** §10.7 钉死取值：maxDimension=2000（宿主模型图像上限同值）、inline 200 KiB。 */
export interface CaptureBudget {
  maxDimension: number;
  inlineBase64BudgetBytes: number;
}

/** §10.7 预算阶梯的 producer 侧常量（单一来源；smoke/native 测试同值断言）。 */
export const CAPTURE_MAX_DIMENSION = 2000;
export const CAPTURE_INLINE_BASE64_BUDGET_BYTES = 200 * 1024;

export interface CaptureResult {
  image: Uint8Array;
  encoding: "png" | "jpeg";
  width: number;
  height: number;
  bounds: CaptureRect;
  scaled: boolean;
  budgetFit: boolean;
  /**
   * 显示器拓扑指纹（EnumDisplayMonitors 集合 + 各 bounds；§10.7 世代对照事实源）。
   * A2 实现批次按 §10.7「捕获时指纹」机制补进 CaptureResult（additive，spec 同批回写）；
   * frame-registry 以其换代判定 stale。A1 形态 addon 无此字段 → undefined。
   */
  topologyFingerprint?: string;
}

export interface PressKeysEntry {
  vk: number;
  up: boolean;
}

export interface ExpectedForegroundOptions {
  expectedForegroundPid: number;
}

/** 能力在场性（§10.9：broker_info capabilities 与 handler 注册的两面同源事实）。 */
export interface CapabilityPresence {
  readonly input: boolean;
  readonly capture: boolean;
  readonly clipboard: boolean;
}

/**
 * driver 接口 = §10.3 二分错误契约 + §10.1 签名（fake/real 同接口，§10.11 规则③）。
 * 全部方法（除 cancelOperations）返回 Promise；错误只经 NativeRejectedError /
 * NativeAmbiguousError 两个类型化出口上抛。
 */
export interface CuaNativeDriver {
  readonly capabilityPresence: CapabilityPresence;

  // ── 预检与环境事实 ──
  environmentProbe(): Promise<EnvironmentProbeResult>;
  foregroundPid(): Promise<{ pid: number | null }>;
  heldInputSnapshot(): Promise<{ buttons: string[]; keys: number[] }>;
  asyncKeyState(vk: number): Promise<{ down: boolean }>;
  cursorPosition(): Promise<{ x: number; y: number }>;
  /** §10.9 app_ref 校验：存活且可读 → {path}；死亡/不可读 → {path:null}。路径值绝不进日志/wire。 */
  processExecutablePath(pid: number): Promise<{ path: string | null }>;

  // ── 指针（expectedForegroundPid 必现，§10.4 规则 1）──
  moveTo(x: number, y: number, opts: ExpectedForegroundOptions): Promise<void>;
  scrollAt(
    x: number,
    y: number,
    deltaX: number,
    deltaY: number,
    opts: ExpectedForegroundOptions,
  ): Promise<void>;
  drag(
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    opts: ExpectedForegroundOptions & { button?: MouseButtonName },
  ): Promise<{ injectedPoints: number; canceled: boolean }>;
  mouseDown(button: MouseButtonName, opts: ExpectedForegroundOptions): Promise<void>;
  mouseUp(
    button: MouseButtonName,
    opts: { mode: "action"; expectedForegroundPid: number } | { mode: "cleanup" },
  ): Promise<void>;

  // ── 键盘 ──
  sendText(
    text: string,
    opts: ExpectedForegroundOptions,
  ): Promise<{ injected: number; total: number; canceled: boolean }>;
  pressKeys(
    keys: PressKeysEntry[],
    opts: ExpectedForegroundOptions & { holdMs?: number },
  ): Promise<{ canceled: boolean }>;

  // ── held 清理与全局取消 ──
  releaseAllHeldInputs(): Promise<{ released: number }>;
  /** 同步（停止信号不被任何异步队列延迟，§10.1 注记 3）。 */
  cancelOperations(): void;

  // ── 剪贴板 ──
  clipboardWriteText(text: string): Promise<void>;

  // ── 截图 ──
  captureDisplay(
    target: { monitorIndex: number } | { bounds: CaptureRect },
    budget: CaptureBudget,
  ): Promise<CaptureResult>;
  captureWindow(windowToken: number, budget: CaptureBudget): Promise<CaptureResult>;
}
