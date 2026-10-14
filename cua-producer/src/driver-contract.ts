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

/** code 封闭集的运行时镜像（classifyNativeError 的未知 code 判据；与上类型同源维护）。 */
export const KNOWN_NATIVE_CODES: ReadonlySet<string> = new Set<NativeErrorCode>([
  "foreground_lost",
  "non_interactive_desktop",
  "target_changed",
  "capture_minimized",
  "capture_failed",
  "budget_exceeded",
  "clipboard_busy",
  "clipboard_denied",
  "injection_rejected",
  "uia_timeout",
  "stale",
  "not_settable",
  "not_selectable",
  "action_unavailable",
  "canceled",
  "internal_native",
]);

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

// ── A3：UIA 面（specs/windows-helper-producer.md §11）──────────────────────────

/** §11.1 钉死预算：观察类 8s、单 pattern 调用 3s（native 侧强制；JS 仅测试可覆写）。 */
export const UIA_OBSERVE_DEADLINE_MS = 8_000;
export const UIA_PATTERN_DEADLINE_MS = 3_000;
/** §11.1 卡死隔离：poisoned 累计 ≥3 → Helper internal-helper-failure + exit 1 自终结。 */
export const UIA_POISON_SELF_TERMINATE_THRESHOLD = 3;
/** §11.4 树预算：≤3000 行 ∧ ≤256 KiB 文本（native 遍历预算感知，JS 渲染同值断言）。 */
export const TREE_MAX_ELEMENTS = 3_000;
export const TREE_MAX_TEXT_BYTES = 256 * 1024;

export interface UiaAppFact {
  pid: number;
  /** canonical exe 全路径（QueryFullProcessImageName）；身份字段永远 canonical（§11.3）。 */
  exePath: string;
  /** AUMID（packaged app）；无则 null。 */
  aumid: string | null;
  /** AUMID display name best-effort（oQ11：A3 v1 恒 null，name 落 exe basename）。 */
  displayName: string | null;
  windowCount: number;
  /** 前台 pid 归属（AFH 承载的 packaged app 经 AUMID 修正，§11.3）。 */
  active: boolean;
}

export interface UiaWindowFact {
  /** native 窗口注册表不透明 token（Helper 代内单调、不复用；失效 → element_unavailable，§11.2）。 */
  windowId: number;
  /** 用户内容：只进 wire 结果（产品面），绝不进日志/stderr/IPC/错误消息。 */
  title: string;
  pid: number;
  exePath: string;
  bounds: CaptureRect;
  minimized: boolean;
}

export interface UiaElementFact {
  /** 遍历序（document order，确定性；观察即冻结，§11.4 索引稳定性契约）。 */
  index: number;
  /** 树文本渲染用缩进深度。 */
  depth: number;
  /** UIA ControlType 的稳定英文名（封闭映射，绝不本地化，§11.4）。 */
  role: string;
  name: string;
  /** 截断至 512 code units 的采集值；无 value 面则 null。 */
  value: string | null;
  /** 完整 value 长度（select_text 的 start 越界预检用，§11.2）。 */
  valueLength: number;
  bounds: CaptureRect | null;
  /** 元素广告的动作词汇（§11.4 patterns 注记；只广告真实存在的动作）。 */
  patterns: string[];
}

export interface UiaTreeBudget {
  maxElements: number;
  maxTextBytes: number;
}

export interface UiaTreeResult {
  /** native 冻结域 token（COM 引用不出 worker，JS 只持不透明 token，§11.1/§11.5）。 */
  stateToken: number;
  /** 选定窗口事实；进程存活但 0 可观察窗口 → null（JS → noObservableWindow 字面量）。 */
  window: { windowId: number; title: string; bounds: CaptureRect } | null;
  elements: UiaElementFact[];
  truncated: boolean;
  /** 全量元素数 M（截断时如实报告总量，§11.4）。 */
  totalElements: number;
}

export type UiaActionName = "invoke" | "toggle" | "expand" | "collapse" | "select" | "focus";

/**
 * UIA driver 接口（fake/real 同接口，§10.11 规则③同律）。COM 接口指针绝不过线程/模块
 * 边界——进出全是不透明 token 与纯数据（A3-AC-1 静态断言面）。错误只经
 * NativeRejectedError / NativeAmbiguousError 两个类型化出口（§10.3 二分契约）。
 */
export interface CuaUiaDriver {
  /** UIA 导出在场性（capabilities.uia 与 6 handler 注册的两面同源事实，§13 不变量②）。 */
  readonly presence: boolean;

  /**
   * 协作式停止 UIA worker（同步、幂等；cancelOperations 的退出收口同族，spec §19 第 14 条
   * ——CUA-A3-SHUTDOWN-CRASH 评审修复）。只许 entry 的统一退出收口点调用；停止后本
   * addon 实例不再复活（进程正在退出）。
   */
  shutdownWorker(): void;

  // ── 观察类（8s 预算；只读，取消 → Rejected(canceled)）──
  listApplications(): Promise<UiaAppFact[]>;
  listWindows(pid: number | null): Promise<UiaWindowFact[]>;
  captureUiTree(
    target: { pid: number; windowId?: number },
    budget: UiaTreeBudget,
    deadlineMs?: number,
  ): Promise<UiaTreeResult>;
  /** LRU 逐出/观察覆盖时释放 native 冻结 COM 引用（best-effort，失败静默）。 */
  releaseState(stateToken: number): Promise<void>;
  /** 卡死隔离事实（poison 计数；≥3 → entry 自终结，§11.1）。 */
  workerStats(): Promise<{ poisoned: number; generation: number }>;

  // ── pattern 调用（3s 预算；变更类——派发后失败 → Ambiguous → possibly_sent）──
  elementSetValue(stateToken: number, index: number, value: string): Promise<{ verified: boolean }>;
  elementSelectText(
    stateToken: number,
    index: number,
    start: number,
    length: number,
  ): Promise<{ outcome: "selected" | "range-invalid" }>;
  elementPerformAction(stateToken: number, index: number, action: UiaActionName): Promise<void>;
  /** 指针三工具 element 路径（§11.2）：InvokePattern 优先、clickable point 兜底。 */
  elementInvoke(stateToken: number, index: number): Promise<{ invoked: boolean }>;
  elementClickablePoint(
    stateToken: number,
    index: number,
  ): Promise<{ x: number; y: number } | null>;
  elementScroll(
    stateToken: number,
    index: number,
    deltaX: number,
    deltaY: number,
  ): Promise<{ scrolled: boolean }>;
}

/**
 * 指针三工具的 element-target 动作面（§11.2「AX element → visual fallback → verify」的
 * producer 落地 seam）：backend-a2 经本接口消费 UIA 能力而不 import uia-driver（模块
 * 规则①）；由 backend-a3 的 createElementActionSurface 实现、entry 组装注入。
 * 全部以 pid + index 表达（内部解析「该 app scope 最新观察」的冻结 token）；索引不可解析
 * → NativeRejectedError("stale")（wire → element_unavailable，fail-closed）。
 */
export interface ElementActionSurface {
  /** left_click(element) ①：语义等价条件下 InvokePattern 优先（后台安全，不抢焦点）。 */
  invokeElement(pid: number, index: number): Promise<{ invoked: boolean }>;
  /** left_click/scroll ②：GetClickablePoint；无 → null（JS → action_unavailable）。 */
  elementPoint(pid: number, index: number): Promise<{ x: number; y: number } | null>;
  /** scroll(element)：ScrollPattern 在 → ScrollByAmount；不在 → false（JS 走 point 兜底）。 */
  scrollElement(
    pid: number,
    index: number,
    deltaX: number,
    deltaY: number,
  ): Promise<{ scrolled: boolean }>;
  /** left_click_drag(element)：两端 clickable point；任一端无 → null（→ action_unavailable）。 */
  dragElementPoints(
    pid: number,
    fromIndex: number,
    toIndex: number,
  ): Promise<{ from: { x: number; y: number }; to: { x: number; y: number } } | null>;
}

interface NativeTypedErrorShape {
  code?: unknown;
  dispatchStarted?: unknown;
}

/**
 * native 错误 → 二分契约归类（§10.3 判据；纯函数——fake driver 直接抛两个错误类，
 * 真 driver 经本函数由 code + dispatchStarted 决定归类）。A3 起住 driver-contract：
 * native-driver 与 uia-driver 两个真 driver 共用（模块规则②禁止 uia-driver import
 * native-driver，故归类函数落契约面；native-driver 保留再导出兼容既有深导入测试）。
 */
export function classifyNativeError(error: unknown, mutating: boolean): Error {
  const shape = (error && typeof error === "object" ? error : {}) as NativeTypedErrorShape;
  const code = typeof shape.code === "string" && KNOWN_NATIVE_CODES.has(shape.code)
    ? (shape.code as NativeErrorCode)
    : undefined;
  const dispatchStarted = shape.dispatchStarted === true;
  if (code === undefined) {
    // 无 code/未知 code：变更类保守 → Ambiguous（结果不可证）；只读 → Rejected。
    return mutating
      ? new NativeAmbiguousError("internal_native", "native-dispatch-outcome-unknown")
      : new NativeRejectedError("internal_native");
  }
  if (code === "injection_rejected") {
    // 恒 Ambiguous：SendInput 报告 0 条注入也可能是 UIPI 静默丢弃——注入面不可证（§10.3）。
    return new NativeAmbiguousError(code, "native-dispatch-outcome-unknown");
  }
  if (code === "uia_timeout") {
    // §10.3/§11.1 分流：只读 → timeout ok:false；变更类 → possibly_sent。
    return mutating
      ? new NativeAmbiguousError(code, "native-timeout")
      : new NativeRejectedError(code);
  }
  if (code === "canceled") {
    // 取消经结果字段（canceled:true）为常态；抛错形态只出现在只读观察面 → Rejected。
    return new NativeRejectedError(code);
  }
  if (mutating && dispatchStarted) {
    // 派发已启动的任何失败（如 chord 主体注入后前台丢失）→ 结果不可证，保守 Ambiguous。
    return new NativeAmbiguousError(code, "native-dispatch-outcome-unknown");
  }
  return new NativeRejectedError(code);
}
