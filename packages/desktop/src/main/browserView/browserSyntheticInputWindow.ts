/**
 * 合成输入抑制窗口 + 真实输入激活戳（per-tab）。
 *
 * 机制来源见 specs/embedded-browser-pane-governance.md 件 4。ACode 的 agent 输入
 * 100% 经 CDP 合成，且 CDP 输入以 isTrusted 抵达页面、会触发 webContents 的
 * `input-event`——没有本模块时宿主无法区分真实用户手势与 agent 合成输入。
 *
 * 语义边界：抑制窗口防的是「页面内脚本借合成输入自触发权限升级/弹窗循环」，
 * 不是拦 agent 自己的驱动。CDP 下发路径不经过窗口判定；窗口只影响：
 * 1. `input-event` 的可信度标记（stampActivationFromInputEvent 窗口内一律 false）；
 * 2. pointer-lock 准入判定（syntheticActivationLive / hasRecentSyntheticDispatch）。
 *
 * 双窗分工（对齐参考机制）：
 * - 输入抑制窗口：per-send token，35s cap + 台账清空后 200ms 尾缘，过滤输入归因；
 * - 合成激活窗口：覆盖 Chromium ~5s transient activation 尾巴（+1s 裕量），
 *   供权限准入判定「页面此刻的 user activation 是否来自合成输入」。
 */

/** 单次 CDP 下发的抑制上限：覆盖卡死下发；正常路径由 end 提前收窗。 */
const SYNTHETIC_INPUT_DISPATCH_CAP_MS = 35_000;
/** 台账清空后的短尾缘：覆盖输入事件在 renderer 侧的在途传播。 */
const SYNTHETIC_INPUT_RELEASE_TAIL_MS = 200;
/** transient activation 存活尾（5s）+ 判定裕量（1s）。 */
const SYNTHETIC_ACTIVATION_LIVE_TAIL_MS = 5_000 + 1_000;
/** 「近期有合成派发」的准入判定窗（对齐参考机制 cdpDispatchBegins 的 35s 判定）。 */
const SYNTHETIC_DISPATCH_RECENCY_MS = 35_000;

/**
 * 真实手势事件类型闭集（webContents input-event 的 Input.type）：只有这三类能
 * 铸造页面侧 user activation / 表达用户意图；mouseUp、char、mouseWheel 等不计。
 */
const REAL_GESTURE_EVENT_TYPES: ReadonlySet<string> = new Set([
  "mouseDown",
  "rawKeyDown",
  "keyDown",
]);

interface WindowState {
  /** 在途输入派发 token → begin 时刻。 */
  inputBegins: Map<symbol, number>;
  inputSuppressedUntil: number;
  /** 在途激活铸造 token → begin 时刻。 */
  activationBegins: Map<symbol, number>;
  activationUntil: number;
  /** 最近一次合成派发 begin 时刻（准入判定用，不随 end 清除）。 */
  lastDispatchBeganAt: number;
  lastRealGestureAt: number | null;
}

interface BrowserSyntheticInputWindowOptions {
  /** 注入时钟供单测；缺省 Date.now。 */
  now?: () => number;
}

export class BrowserSyntheticInputWindow {
  private readonly states = new Map<string, WindowState>();
  private readonly now: () => number;

  constructor(options: BrowserSyntheticInputWindowOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  /** `Input.*` CDP 下发开始：开 token 并把抑制窗推至 now+cap。 */
  beginInputDispatch(tabId: string): symbol {
    const state = this.ensure(tabId);
    const token = Symbol("cdp-input-dispatch");
    const now = this.now();
    state.inputBegins.set(token, now);
    state.inputSuppressedUntil = now + SYNTHETIC_INPUT_DISPATCH_CAP_MS;
    state.lastDispatchBeganAt = now;
    return token;
  }

  /**
   * 下发 settle（含 rejection；调用方必须放 finally）：台账空 → now+200ms 尾缘；
   * 非空 → min(原 until, 最晚 begin + cap)。同时惰性 GC begin 超 cap 的僵尸 token
   * （下发 promise 永不 settle 的极端路径不至于把窗口钉死在 cap 之外）。
   */
  endInputDispatch(tabId: string, token: symbol): void {
    const state = this.states.get(tabId);
    if (!state) return;
    state.inputBegins.delete(token);
    state.inputSuppressedUntil = this.recomputeUntil(
      state.inputBegins,
      state.inputSuppressedUntil,
      true,
    );
  }

  /** 铸造页面侧 user activation 的下发（Input.* / userGesture:true 的 evaluate）。 */
  beginActivation(tabId: string): symbol {
    const state = this.ensure(tabId);
    const token = Symbol("cdp-activation");
    const now = this.now();
    state.activationBegins.set(token, now);
    state.activationUntil = now + SYNTHETIC_INPUT_DISPATCH_CAP_MS;
    return token;
  }

  endActivation(tabId: string, token: symbol): void {
    const state = this.states.get(tabId);
    if (!state) return;
    state.activationBegins.delete(token);
    // 激活窗不做僵尸 GC（false 传入）：宁可让激活尾巴多活到 cap，也不能在页面
    // transient activation 仍可能存活时提前放行权限准入（fail-closed 方向）。
    state.activationUntil = this.recomputeUntil(
      state.activationBegins,
      state.activationUntil,
      false,
    );
  }

  /** 输入抑制窗是否活跃（input-event 归因过滤）。 */
  isInputSuppressed(tabId: string): boolean {
    const state = this.states.get(tabId);
    return state !== undefined && this.now() < state.inputSuppressedUntil;
  }

  /** 合成激活是否仍可能存活（在途 token 或 activationUntil+6s 尾巴内）。 */
  syntheticActivationLive(tabId: string): boolean {
    const state = this.states.get(tabId);
    if (!state) return false;
    return (
      state.activationBegins.size > 0 ||
      this.now() < state.activationUntil + SYNTHETIC_ACTIVATION_LIVE_TAIL_MS
    );
  }

  /** 近期（默认 35s 判定窗）是否有过合成派发 begin。 */
  hasRecentSyntheticDispatch(tabId: string, withinMs = SYNTHETIC_DISPATCH_RECENCY_MS): boolean {
    const state = this.states.get(tabId);
    if (!state) return false;
    if (state.inputBegins.size > 0) return true;
    return state.lastDispatchBeganAt > 0 && this.now() - state.lastDispatchBeganAt < withinMs;
  }

  /**
   * 任意 CDP 派发（含只读命令）都会更新「最近派发时刻」：准入判定的语义是
   * 「agent 正在驱动这个页面」，不限于输入类命令（对齐参考机制 cdpDispatchBegins
   * 对全部工具操作记账的语义）。
   */
  noteDispatch(tabId: string): void {
    this.ensure(tabId).lastDispatchBeganAt = this.now();
  }

  /**
   * 真实输入激活戳：窗口活跃 → false（该「手势」按合成来源处理，不落任何账目）；
   * 窗口外且事件类型在闭集 → 记 lastRealGestureAt 并返回 true。
   */
  stampActivationFromInputEvent(tabId: string, eventType: string): boolean {
    if (this.isInputSuppressed(tabId)) return false;
    if (!REAL_GESTURE_EVENT_TYPES.has(eventType)) return false;
    const state = this.ensure(tabId);
    state.lastRealGestureAt = this.now();
    return true;
  }

  lastRealGestureAt(tabId: string): number | null {
    return this.states.get(tabId)?.lastRealGestureAt ?? null;
  }

  /** tab 关闭：清理全部窗口状态（token 台账随 promise settle 自清，这里兜底）。 */
  dropTab(tabId: string): void {
    this.states.delete(tabId);
  }

  private ensure(tabId: string): WindowState {
    let state = this.states.get(tabId);
    if (!state) {
      state = {
        inputBegins: new Map(),
        inputSuppressedUntil: 0,
        activationBegins: new Map(),
        activationUntil: 0,
        lastDispatchBeganAt: 0,
        lastRealGestureAt: null,
      };
      this.states.set(tabId, state);
    }
    return state;
  }

  private recomputeUntil(begins: Map<symbol, number>, previousUntil: number, gcStale: boolean) {
    const now = this.now();
    let latestBegin = 0;
    for (const [token, beganAt] of begins) {
      if (gcStale && now - beganAt >= SYNTHETIC_INPUT_DISPATCH_CAP_MS) {
        begins.delete(token);
        continue;
      }
      if (beganAt > latestBegin) latestBegin = beganAt;
    }
    if (begins.size === 0) return now + SYNTHETIC_INPUT_RELEASE_TAIL_MS;
    return Math.min(previousUntil, latestBegin + SYNTHETIC_INPUT_DISPATCH_CAP_MS);
  }
}
