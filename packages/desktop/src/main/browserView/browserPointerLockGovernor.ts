/**
 * pointer-lock 强制退出链 + 准入台账（host 侧等价实现）。
 *
 * 机制来源见 specs/embedded-browser-pane-governance.md 件 5。ACode 静态矩阵对任意
 * 网页 session 无条件放行 pointerLock；持锁期间鼠标被劫持、CDP 坐标输入失真，
 * agent 操作链可被页面劫持。本模块提供：
 * 1. 准入判定 `canAdmitPointerLock`——真实用户在场（pane 可见 + 无近期合成派发 +
 *    合成激活窗不活跃）才允许页面拿锁；agent 操作期间页面请求锁应被拒（掐断
 *    「借合成输入自触发权限升级」）。权限请求侧接线登记于 spec。
 * 2. 强制退出链——`Input.*` 派发前对已准入 guest 遍历全部 frame（含主 frame，
 *    ACode 适配：整页皆不可信内容）下发 exitPointerLock，15×10ms 轮询确认，
 *    waiter 等实际退出；超时走结构化 warn（非保留键），任何结果都不阻塞主链路。
 * 3. 节流探测兜底——权限侧接线前，未准入 guest 以 2s 节流探测持锁事实，发现即
 *    隐式准入并走退出链，使机制在接线前仍有防御价值。
 *
 * 零 electron 导入：frame 访问器由调用方（guest manager）构造注入，可单测。
 */

/** 退出链/探测的结果闭集。 */
type BrowserPointerLockExitOutcome =
  | "not-admitted"
  | "no-frames"
  | "exited"
  | "timeout"
  | "guest-unavailable"
  | "probe-skipped";

/** 单个 frame 的最小访问面（guest manager 用 WebFrameMain 适配）。 */
export interface BrowserPointerLockFrameHandle {
  /** destroyed/detached 的 frame 按「已退出」收敛，绝不因个别 frame 异常挂死。 */
  isUnavailable(): boolean;
  /** 在 frame 主世界执行脚本；实现必须自行 try/catch 并以 rejection 表达失败。 */
  run(script: string): Promise<unknown>;
}

interface BrowserPointerLockGovernorOptions {
  /** 注入时钟供单测；缺省 Date.now。 */
  now?: () => number;
  /** 注入睡眠供单测；缺省 setTimeout promise。 */
  sleep?: (ms: number) => Promise<void>;
  /** 确认轮询间隔（参考机制 10ms）。 */
  pollIntervalMs?: number;
  /** 确认轮询轮次上限（参考机制 15 次）。 */
  maxPolls?: number;
  /** 单次 frame 脚本调用的竞态超时：冻结 renderer 不得挂死整链。 */
  frameCallTimeoutMs?: number;
  /** 未准入 guest 的持锁探测节流窗。 */
  probeThrottleMs?: number;
  warn?: (message: string) => void;
}

interface GovernorTabState {
  /** 准入时记录的 guest id；guest 换代后旧准入自然失效。 */
  admittedGuestId: number | null;
  lastProbeAt: number;
  flight: Promise<BrowserPointerLockExitOutcome> | null;
}

const DEFAULT_POLL_INTERVAL_MS = 10;
const DEFAULT_MAX_POLLS = 15;
const DEFAULT_FRAME_CALL_TIMEOUT_MS = 25;
const DEFAULT_PROBE_THROTTLE_MS = 2_000;

const EXIT_SCRIPT = "try{if(document.pointerLockElement){document.exitPointerLock()}}catch(e){}";
const PROBE_SCRIPT =
  "(()=>{try{return document.pointerLockElement!==null}catch(e){return false}})()";
const CONFIRM_SCRIPT =
  "(()=>{try{return document.pointerLockElement===null}catch(e){return true}})()";

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 单次 frame 调用的竞态超时；超时/异常按 fallback 收敛（探测=false 未持锁，
 * 确认=true 已退出）。invoke 用 thunk 包裹：frame 访问器同步抛错也不上抛。
 */
function raceFrameCall<T>(
  invoke: () => Promise<T>,
  timeoutMs: number,
  fallback: T,
  sleep: (ms: number) => Promise<void>,
): Promise<T> {
  let call: Promise<T>;
  try {
    call = Promise.resolve(invoke());
  } catch {
    return Promise.resolve(fallback);
  }
  const timeout = sleep(timeoutMs).then(() => fallback);
  return Promise.race([call.catch(() => fallback), timeout]);
}

export class BrowserPointerLockGovernor {
  private readonly states = new Map<string, GovernorTabState>();
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly pollIntervalMs: number;
  private readonly maxPolls: number;
  private readonly frameCallTimeoutMs: number;
  private readonly probeThrottleMs: number;
  private readonly warn?: (message: string) => void;

  constructor(options: BrowserPointerLockGovernorOptions = {}) {
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.maxPolls = options.maxPolls ?? DEFAULT_MAX_POLLS;
    this.frameCallTimeoutMs = options.frameCallTimeoutMs ?? DEFAULT_FRAME_CALL_TIMEOUT_MS;
    this.probeThrottleMs = options.probeThrottleMs ?? DEFAULT_PROBE_THROTTLE_MS;
    this.warn = options.warn;
  }

  /** 权限侧接线：pointerLock 请求经 canAdmitPointerLock 放行后标记准入。 */
  markAdmitted(tabId: string, guestId: number): void {
    const state = this.ensure(tabId);
    state.admittedGuestId = guestId;
  }

  clearAdmitted(tabId: string): void {
    const state = this.states.get(tabId);
    if (state) state.admittedGuestId = null;
  }

  isAdmitted(tabId: string, guestId: number): boolean {
    return this.states.get(tabId)?.admittedGuestId === guestId;
  }

  /** 主 frame 导航：新文档不继承旧文档的锁准入（对齐参考机制 did-navigate 清理）。 */
  noteMainFrameNavigation(tabId: string): void {
    const state = this.states.get(tabId);
    if (!state) return;
    state.admittedGuestId = null;
    state.lastProbeAt = 0;
  }

  /**
   * 准入纯判定（参考机制 admitArtifactPointerLock 语义）：
   * pane 可见 且 35s 内无 CDP 派发 且 合成激活窗不活跃。
   */
  canAdmitPointerLock(input: {
    paneVisible: boolean;
    syntheticActivationLive: boolean;
    recentSyntheticDispatch: boolean;
  }): boolean {
    return input.paneVisible && !input.recentSyntheticDispatch && !input.syntheticActivationLive;
  }

  /**
   * `Input.*` 派发前的唯一入口：已准入 → 每次走退出链；未准入 → 节流探测，发现
   * 持锁即隐式准入并退出。**永不 reject**——防御纵深件不能反噬输入主链路。
   */
  async ensureUnlockedBeforeSyntheticInput(
    tabId: string,
    guestId: number,
    readFrames: () => BrowserPointerLockFrameHandle[],
  ): Promise<BrowserPointerLockExitOutcome> {
    const state = this.ensure(tabId);
    if (state.flight) return state.flight;
    const flight = this.runEnsure(tabId, guestId, state, readFrames).catch(
      (): BrowserPointerLockExitOutcome => {
        // 链内任何未预期异常都收敛为 guest-unavailable，绝不上抛。
        return "guest-unavailable";
      },
    );
    state.flight = flight;
    try {
      return await flight;
    } finally {
      const current = this.states.get(tabId);
      if (current && current.flight === flight) current.flight = null;
    }
  }

  dropTab(tabId: string): void {
    this.states.delete(tabId);
  }

  private async runEnsure(
    tabId: string,
    guestId: number,
    state: GovernorTabState,
    readFrames: () => BrowserPointerLockFrameHandle[],
  ): Promise<BrowserPointerLockExitOutcome> {
    const admitted = state.admittedGuestId === guestId;
    if (!admitted) {
      const now = this.now();
      if (now - state.lastProbeAt < this.probeThrottleMs) return "probe-skipped";
      state.lastProbeAt = now;
      const frames = this.readAvailableFrames(readFrames);
      if (frames === null) return "guest-unavailable";
      if (frames.length === 0) return "no-frames";
      const locked = await this.anyFrameLocked(frames);
      if (!locked) return "not-admitted";
      // 持锁事实即准入事实（权限矩阵现状无条件放行 pointerLock）：标记后走退出链，
      // 链内并发派发共享同一 flight，退出成功后清除。
      state.admittedGuestId = guestId;
    }
    return this.runExitChain(tabId, guestId, state, readFrames);
  }

  private async runExitChain(
    tabId: string,
    guestId: number,
    state: GovernorTabState,
    readFrames: () => BrowserPointerLockFrameHandle[],
  ): Promise<BrowserPointerLockExitOutcome> {
    const startedAt = this.now();
    const frames = this.readAvailableFrames(readFrames);
    if (frames === null) return "guest-unavailable";
    if (frames.length === 0) {
      state.admittedGuestId = null;
      return "no-frames";
    }
    const frameCount = frames.length;
    // 广播退出：单 frame 失败不中断（等价参考机制的 host 广播 + preload 遍历语义）。
    for (const frame of frames) {
      void raceFrameCall(
        () => frame.run(EXIT_SCRIPT),
        this.frameCallTimeoutMs,
        undefined,
        this.sleep,
      );
    }
    // waiter：15×10ms 轮询确认全部 frame 实际退出（destroyed/detached 按已退出收敛）。
    let pending = new Set(frames);
    for (let poll = 0; poll < this.maxPolls && pending.size > 0; poll += 1) {
      if (poll > 0) await this.sleep(this.pollIntervalMs);
      const candidates = [...pending];
      const confirmed = await Promise.all(
        candidates.map((frame) =>
          frame.isUnavailable()
            ? Promise.resolve(true)
            : raceFrameCall(
                () => frame.run(CONFIRM_SCRIPT),
                this.frameCallTimeoutMs,
                false,
                this.sleep,
              ),
        ),
      );
      const next = new Set<BrowserPointerLockFrameHandle>();
      candidates.forEach((frame, index) => {
        // 已确认退出或 frame 已不可用 → 离开 pending；其余进入下一轮。
        if (confirmed[index] === true || frame.isUnavailable()) return;
        next.add(frame);
      });
      pending = next;
    }
    const elapsedMs = this.now() - startedAt;
    if (pending.size === 0) {
      // 退出成功后清准入：稳态输入派发零成本；页面再次拿锁经权限接线或探测重新准入。
      state.admittedGuestId = null;
      return "exited";
    }
    // 超时：结构化 warn（key=value 非保留键；不落 URL/用户数据）。
    this.warn?.(
      `[browser-governance] pointer-lock exit incomplete outcome=timeout tabId=${tabId} guestId=${guestId} frameCount=${frameCount} pendingCount=${pending.size} elapsedMs=${elapsedMs}`,
    );
    return "timeout";
  }

  /** null = frame 树不可读（guest 已销毁/访问抛错）；[] = 无可用 frame。 */
  private readAvailableFrames(
    readFrames: () => BrowserPointerLockFrameHandle[],
  ): BrowserPointerLockFrameHandle[] | null {
    let frames: BrowserPointerLockFrameHandle[];
    try {
      frames = readFrames();
    } catch {
      return null;
    }
    return frames.filter((frame) => {
      try {
        return !frame.isUnavailable();
      } catch {
        return false;
      }
    });
  }

  private async anyFrameLocked(frames: BrowserPointerLockFrameHandle[]): Promise<boolean> {
    const results = await Promise.all(
      frames.map((frame) =>
        raceFrameCall(
          () => frame.run(PROBE_SCRIPT),
          this.frameCallTimeoutMs,
          false,
          this.sleep,
        ).then((locked) => locked === true),
      ),
    );
    return results.some((locked) => locked);
  }

  private ensure(tabId: string): GovernorTabState {
    let state = this.states.get(tabId);
    if (!state) {
      state = { admittedGuestId: null, lastProbeAt: 0, flight: null };
      this.states.set(tabId, state);
    }
    return state;
  }
}
