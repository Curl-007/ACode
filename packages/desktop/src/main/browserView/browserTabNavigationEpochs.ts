/**
 * 内嵌浏览器 tab 的导航 epoch 分轨计数（mainFrame vs subframe vs 外来 subframe）。
 *
 * 机制来源见 specs/embedded-browser-pane-governance.md 件 2：guestGeneration 是
 * per-tab 单轨且只在 webview 重建时递增，文档级导航对 main 不可见。分轨计数让
 * 宿主/工具层能区分「主 frame 换文档」「同源 subframe 变化」「外来内容进入 frame
 * 树」三类事实——外来 subframe 轨是外链劫持/广告注入的可见性信号，主 frame 轨是
 * 导航竞态检测（操作前后 epoch 不变才认账）的基础。
 *
 * 计数器按 tabId 存续：文档历史属于 logical tab，guest 替换（webview 重建恢复同一
 * tab）不清零；tab 关闭时 dropTab。
 */

export interface BrowserTabNavigationEpochSnapshot {
  /** 任何 frame 导航都递增：frame 树形态变化的粗粒度信号。 */
  frameTree: number;
  /** 主 frame 提交导航递增。 */
  mainFrame: number;
  /** 任意 subframe 导航递增。 */
  subframes: number;
  /** 外来（跨 origin / blob / filesystem / 不可判定）subframe 导航递增。 */
  foreignSubframes: number;
}

/** 计数器是可变累加态；快照读出时复制，避免调用方持有内部引用。 */
type EpochState = BrowserTabNavigationEpochSnapshot;

interface BrowserTabNavigationEpochTrackerOptions {
  /** 外来 subframe 导航的结构化通知（宿主落 debug 日志用）；不落 URL 全文。 */
  onForeignSubframeNavigation?: (
    tabId: string,
    snapshot: BrowserTabNavigationEpochSnapshot,
  ) => void;
}

const FOREIGN_NON_HTTP_PATTERN = /^(?:blob|filesystem):/i;

/**
 * 外来 subframe 判定（对齐参考机制语义）：
 * - http(s)：与主 frame 当前 URL 的 origin 不同即外来；
 * - 非 http(s)：仅 `blob:`/`filesystem:` 计外来（可承载远端内容）；about:/data: 等
 *   文档占位不计；
 * - 主 frame URL 缺失或任一侧解析失败：保守计为外来（宁可多报不可漏报）。
 */
export function isForeignSubframeNavigation(
  frameUrl: string | null,
  mainFrameUrl: string | null,
): boolean {
  if (!frameUrl) return false;
  let parsedFrame: URL;
  try {
    parsedFrame = new URL(frameUrl);
  } catch {
    return false;
  }
  if (parsedFrame.protocol !== "https:" && parsedFrame.protocol !== "http:") {
    return FOREIGN_NON_HTTP_PATTERN.test(frameUrl);
  }
  if (mainFrameUrl === null) return true;
  try {
    return parsedFrame.origin !== new URL(mainFrameUrl).origin;
  } catch {
    return true;
  }
}

export class BrowserTabNavigationEpochTracker {
  private readonly states = new Map<string, EpochState>();
  private readonly onForeignSubframeNavigation?: (
    tabId: string,
    snapshot: BrowserTabNavigationEpochSnapshot,
  ) => void;

  constructor(options: BrowserTabNavigationEpochTrackerOptions = {}) {
    this.onForeignSubframeNavigation = options.onForeignSubframeNavigation;
  }

  /**
   * 记录一次 `did-frame-navigate`。mainFrameUrl 必须是**导航发生时**主 frame 的当前
   * URL（外来判定以当下主文档为基准）；不可读时传 null（保守计外来）。
   */
  noteFrameNavigation(
    tabId: string,
    input: { isMainFrame: boolean; frameUrl: string | null; mainFrameUrl: string | null },
  ): { foreignSubframe: boolean } {
    const state = this.ensure(tabId);
    state.frameTree += 1;
    if (input.isMainFrame) {
      state.mainFrame += 1;
      return { foreignSubframe: false };
    }
    state.subframes += 1;
    const foreign = isForeignSubframeNavigation(input.frameUrl, input.mainFrameUrl);
    if (foreign) {
      state.foreignSubframes += 1;
      this.onForeignSubframeNavigation?.(tabId, this.snapshotOf(state));
    }
    return { foreignSubframe: foreign };
  }

  /** 未知 tab 返回 null（调用方据此区分「无导航事实」与「tab 不存在」）。 */
  snapshot(tabId: string): BrowserTabNavigationEpochSnapshot | null {
    const state = this.states.get(tabId);
    return state ? this.snapshotOf(state) : null;
  }

  dropTab(tabId: string): void {
    this.states.delete(tabId);
  }

  private ensure(tabId: string): EpochState {
    let state = this.states.get(tabId);
    if (!state) {
      state = { frameTree: 0, mainFrame: 0, subframes: 0, foreignSubframes: 0 };
      this.states.set(tabId, state);
    }
    return state;
  }

  private snapshotOf(state: EpochState): BrowserTabNavigationEpochSnapshot {
    return {
      frameTree: state.frameTree,
      mainFrame: state.mainFrame,
      subframes: state.subframes,
      foreignSubframes: state.foreignSubframes,
    };
  }
}
