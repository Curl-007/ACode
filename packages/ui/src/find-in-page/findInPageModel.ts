/**
 * 页内查找纯规则（specs: packages/desktop/specs/find-in-page.md）。
 *
 * 无 DOM/React 依赖，node 可测；查找栏 hook 与组件共用这一份事实源。
 * main 侧 findInPageMain.ts 持有阈值函数的同构镜像（main 不能 import ui 包，
 * 两处各自单测锁定同一规则）。
 */

/** CJK 文字检测：Han/平假名/片假名/谚文任一命中即单字可搜。 */
const CJK_SCRIPT_PATTERN =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/** 增量搜索防抖窗口：连续输入停顿后才发起一轮查找。 */
export const FIND_IN_PAGE_DEBOUNCE_MS = 250;

/** 窗口 visibilitychange/focus 后重聚焦输入的延迟。 */
export const FIND_IN_PAGE_REFOCUS_DELAY_MS = 100;

/** 程序性聚焦距上次击键超过该间隔才 select()——不打断正在进行的输入。 */
export const FIND_IN_PAGE_SELECT_QUIET_MS = 400;

/**
 * CJK 感知起搜阈值：拉丁 3 字符起搜，CJK 单字即搜。
 * 低于阈值的查询不发起搜索，且应自动清理既有高亮（见 hook 的 stop 分支）。
 */
export function meetsFindInPageThreshold(query: string): boolean {
  return query.length > 2 || CJK_SCRIPT_PATTERN.test(query);
}

/** 计数是否显示：本轮结果已回（hasResult）且查询过阈值。 */
export function shouldShowFindCounter(query: string, hasResult: boolean): boolean {
  return hasResult && meetsFindInPageThreshold(query);
}

/**
 * 程序性聚焦时是否全选查询文本：距上次击键 >400ms 才 select()。
 * performance.now() 同一时间基（lastKeyAt 由击键时记录）。
 */
export function shouldSelectOnProgrammaticFocus(lastKeyAt: number, now: number): boolean {
  return now - lastKeyAt > FIND_IN_PAGE_SELECT_QUIET_MS;
}

/** Escape 关闭判定的事件结构（KeyboardEvent 子集，测试可构造）。 */
export interface FindInPageEscapeEvent {
  key: string;
  repeat?: boolean;
  isComposing?: boolean;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  /** 兼容旧事件模型；IME 组合中 Chromium 报 keyCode 229。 */
  keyCode?: number;
}

/**
 * Escape 关闭判定（内容窗捕获）：无任何修饰键、非长按 repeat、非 IME 组合中。
 * IME 组合中的 Escape 属于输入法「取消组合」语义，不得吞成关闭查找栏
 * （与 bindings.ts 内核的 IME/repeat 噪声纪律一致；上游证据只过滤 autoRepeat+修饰键，
 * 这里按仓库纪律补 IME 闸）。
 */
export function isFindInPageCloseEscape(event: FindInPageEscapeEvent): boolean {
  return (
    event.key === "Escape" &&
    event.repeat !== true &&
    event.isComposing !== true &&
    event.keyCode !== 229 &&
    !event.shiftKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.metaKey
  );
}
