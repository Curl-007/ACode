/**
 * 页内查找二期：provider 双路 main 侧协调器（specs/find-in-page.md R8-R14）。
 *
 * findInPageMain.ts 的姊妹模块（400 行 max-lines 硬闸，按 findInPageBindings.ts 同一
 * 拆分先例）。职责：
 * - per-sender provider 状态（WeakMap）：active 能力申报标志、单调 epoch、pending
 *   report 结算表；
 * - 双路仲裁的 provider 路：dispatch（webContents.send）→ report(epoch 匹配) |
 *   超时 | destroyed | render-process-gone 竞速，结构与原生路三路竞速同构，
 *   任何非正常路径 fail-soft 收口 EMPTY_FIND_RESULT（{0,0}），不抛错不悬挂；
 * - epoch 守卫：新一轮 dispatch 立即结算全部旧 pending（latest-wins，renderer 协调器
 *   只对最新 dispatch 申报，旧轮 report 永不到达）；错误 epoch 的 report 直接丢弃。
 *
 * 失效语义：stop/end-session 结算 pending + 下发 FindInPageClear，但保留 active
 * （能力申报与会话生命周期解耦）；跨文档导航/崩溃/销毁的失效链额外复位 active=false
 * （renderer 上下文已换，注册表由重载后的 renderer 重新申报）。
 */
import type { WebContents } from "electron";
import { PlatformChannels } from "@acode/shared";
import type { FindInPageReportPayload, FindInPageRequest, FindInPageResult } from "@acode/shared";

/** fail-soft 统一空结果（与一期 findInPageMain.ts 的 EMPTY_FIND_RESULT 同语义）。 */
const EMPTY_FIND_RESULT: FindInPageResult = { activeIndex: 0, total: 0 };

interface ProviderFindState {
  /** renderer 申报的 provider 路能力（注册表非空）；失效链复位。 */
  active: boolean;
  /** 单调递增；dispatch 携带，report 必须原样带回。 */
  epoch: number;
  /** epoch → invoke 结算器。clear/新 dispatch/失效时全部结算 {0,0}。 */
  pending: Map<number, (result: FindInPageResult) => void>;
}

/** per-sender 状态；WeakMap 让 webContents 回收即状态消亡（与一期会话表同构）。 */
const providerStates = new WeakMap<WebContents, ProviderFindState>();

function ensureState(target: WebContents): ProviderFindState {
  let state = providerStates.get(target);
  if (!state) {
    state = { active: false, epoch: 0, pending: new Map() };
    providerStates.set(target, state);
  }
  return state;
}

/** 双路仲裁判定：handleFindInPage 在原生路之前查询（spec R8）。 */
export function isProviderPathActive(target: WebContents): boolean {
  return providerStates.get(target)?.active === true;
}

/**
 * report 载荷运行时校验（不信任 renderer 输入，直连 IPC 可绕过 preload 类型）：
 * epoch/activeIndex/total 必须为有限数值，可选 provider 维度字段必须为布尔；
 * 非法即 null（丢弃不结算，留给超时 fail-soft，spec R14）。
 */
export function parseFindInPageReportPayload(payload: unknown): FindInPageReportPayload | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const candidate = payload as Partial<FindInPageReportPayload>;
  if (typeof candidate.epoch !== "number" || !Number.isFinite(candidate.epoch)) {
    return null;
  }
  const result = candidate.result;
  if (typeof result !== "object" || result === null) {
    return null;
  }
  if (typeof result.activeIndex !== "number" || !Number.isFinite(result.activeIndex)) {
    return null;
  }
  if (typeof result.total !== "number" || !Number.isFinite(result.total)) {
    return null;
  }
  for (const key of ["activeInRenderedWindow", "hasUnsearchableRegions"] as const) {
    if (result[key] !== undefined && typeof result[key] !== "boolean") {
      return null;
    }
  }
  return {
    epoch: candidate.epoch,
    result: {
      activeIndex: result.activeIndex,
      total: result.total,
      ...(result.activeInRenderedWindow !== undefined && {
        activeInRenderedWindow: result.activeInRenderedWindow,
      }),
      ...(result.hasUnsearchableRegions !== undefined && {
        hasUnsearchableRegions: result.hasUnsearchableRegions,
      }),
    },
  };
}

/** SetProviderActive handler：载荷校验 + true→false 迁移时清高亮并结算 pending。 */
export function handleProviderActiveDeclaration(target: WebContents, payload: unknown): void {
  if (typeof payload !== "object" || payload === null) {
    return;
  }
  const active = (payload as { active?: unknown }).active;
  if (typeof active !== "boolean") {
    return;
  }
  const state = ensureState(target);
  if (state.active === active) {
    return;
  }
  state.active = active;
  if (!active) {
    // 能力撤回：清 provider 路高亮（防残留）+ 在途请求 fail-soft 收口。
    clearProviderFind(target);
  }
}

/** FindInPageReport handler：epoch 匹配才结算；失配 report 丢弃（spec R10）。 */
export function handleProviderReport(target: WebContents, payload: unknown): void {
  const parsed = parseFindInPageReportPayload(payload);
  const state = providerStates.get(target);
  if (parsed === null || state === undefined) {
    return;
  }
  const settle = state.pending.get(parsed.epoch);
  if (settle === undefined) {
    return; // 旧轮/已超时/已结算：latest-wins，直接丢弃。
  }
  state.pending.delete(parsed.epoch);
  settle(parsed.result);
}

/**
 * provider 路查找：epoch++ → 旧 pending 全部结算 {0,0} → send dispatch →
 * 竞速 report(epoch) | 超时 | destroyed | render-process-gone。
 * 结算后摘净全部监听器与定时器（与一期 raceFoundInPage 同一纪律）。
 */
export function dispatchProviderFind(
  target: WebContents,
  request: FindInPageRequest,
  timeoutMs: number,
): Promise<FindInPageResult> {
  const state = ensureState(target);
  const epoch = ++state.epoch;
  // latest-wins：renderer 只处理最新 dispatch，旧轮 report 永不到达，先结算防悬挂。
  settleAllPending(state);
  try {
    target.send(PlatformChannels.FindInPageDispatch, {
      epoch,
      text: request.text,
      findNext: request.findNext,
      forward: request.forward ?? true,
    });
  } catch {
    return Promise.resolve(EMPTY_FIND_RESULT);
  }
  if (target.isDestroyed()) {
    return Promise.resolve(EMPTY_FIND_RESULT);
  }
  return new Promise<FindInPageResult>((resolve) => {
    let settled = false;
    const settle = (result: FindInPageResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      state.pending.delete(epoch);
      target.removeListener("destroyed", onTargetLost);
      target.removeListener("render-process-gone", onTargetLost);
      resolve(result);
    };
    const onTargetLost = (): void => {
      settle(EMPTY_FIND_RESULT);
    };
    state.pending.set(epoch, settle);
    const timer = setTimeout(onTargetLost, timeoutMs);
    target.once("destroyed", onTargetLost);
    target.once("render-process-gone", onTargetLost);
  });
}

function settleAllPending(state: ProviderFindState): void {
  const pending = [...state.pending.values()];
  state.pending.clear();
  for (const settle of pending) {
    settle(EMPTY_FIND_RESULT);
  }
}

/** 向 renderer 下发 FindInPageClear（destroyed 守卫 + fail-soft，send 抛错吞掉）。 */
function sendClear(target: WebContents): void {
  if (target.isDestroyed()) {
    return;
  }
  try {
    target.send(PlatformChannels.FindInPageClear);
  } catch {
    // 崩溃后 IPC 通道可能已失效；高亮随文档消失，无需清理（fail-soft 纪律）。
  }
}

/**
 * 清理（stop / end-session / 能力撤回）：结算全部 pending {0,0} + 下发 clear。
 * 保留 active 标志——能力申报由 renderer 注册表驱动，与会话生命周期解耦。
 */
export function clearProviderFind(target: WebContents): void {
  const state = providerStates.get(target);
  if (state === undefined) {
    return;
  }
  settleAllPending(state);
  sendClear(target);
}

/**
 * 失效链复位（跨文档导航/崩溃/销毁）：clearProviderFind + active=false。
 * renderer 上下文已换，provider 注册表随文档消亡，待重载后重新申报。
 */
export function resetProviderFind(target: WebContents): void {
  const state = providerStates.get(target);
  clearProviderFind(target);
  if (state !== undefined) {
    state.active = false;
  }
}
