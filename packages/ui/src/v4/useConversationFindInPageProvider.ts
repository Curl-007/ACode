/**
 * 页内查找二期：ConversationTimeline provider 的 React 生命周期接线（WI-E2b；
 * specs: packages/desktop/specs/find-in-page.md R11/R15）。
 *
 * 三件事：
 * 1. mount 注册 / unmount 注销 scope provider（注册表语义见 findInPageProvider.ts：
 *    数组型多实例——同文档多 pane 各注册各的，协调器按 scope 文档序归并）；
 * 2. loadRest 批增长的宿主侧：provider 经 requestExpandedMount 抬高 overscan 目标
 *    （返回值交给 useVirtualizer 的 overscan，窗口 ±target 全挂载），每个 React
 *    commit 放行一批 awaitCommitted 等待者，实现「逐 commit 一批」的步进；
 * 3. 卸载/ clear 时撤销扩展并放行全部等待者（在途批增长循环靠代际作废退出）。
 *
 * 高频值（已挂载/总 unit 数）经 ref 读取，provider 引用保持稳定——注册表不随
 * 行数据流式变动反复注册。
 */
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { registerFindInPageProvider } from "@/find-in-page/findInPageProvider.js";
import {
  createConversationFindInPageProvider,
  createConversationScopeDomSearch,
} from "@/v4/conversationFindInPageProvider.js";

export interface UseConversationFindInPageProviderOptions {
  /** scope 根元素（message layer：virtual history + live tail + headerSlot）。 */
  scopeRef: RefObject<HTMLElement | null>;
  /** 当前已挂载的虚拟行数（virtualRows.length；宿主渲染期间写入 ref）。 */
  getRenderedUnitCount: () => number;
  /** 虚拟化 unit 总数（virtualizedUnits.length；live tail 恒定挂载不计入）。 */
  getTotalUnitCount: () => number;
}

/**
 * 返回虚拟器 overscan 的扩展目标（null = 默认窗口 overscan）。
 * 用法：`overscan: findInPageExpandedOverscan ?? ROW_OVERSCAN`。
 */
export function useConversationFindInPageProvider(
  options: UseConversationFindInPageProviderOptions,
): number | null {
  const { scopeRef } = options;
  const [expandedOverscan, setExpandedOverscan] = useState<number | null>(null);
  const expandedOverscanRef = useRef<number | null>(null);
  expandedOverscanRef.current = expandedOverscan;
  const commitWaitersRef = useRef<Array<() => void>>([]);
  // 高频 getter 经 ref 读取，保持 provider 引用稳定（provider 全生命周期只创建一次）。
  const gettersRef = useRef({
    getRenderedUnitCount: options.getRenderedUnitCount,
    getTotalUnitCount: options.getTotalUnitCount,
  });
  gettersRef.current = {
    getRenderedUnitCount: options.getRenderedUnitCount,
    getTotalUnitCount: options.getTotalUnitCount,
  };

  const flushCommitWaiters = (): void => {
    const waiters = commitWaitersRef.current;
    if (waiters.length === 0) {
      return;
    }
    commitWaitersRef.current = [];
    for (const resolve of waiters) {
      resolve();
    }
  };
  const flushCommitWaitersRef = useRef(flushCommitWaiters);
  flushCommitWaitersRef.current = flushCommitWaiters;

  // 每次 commit 后放行一批 loadRest 等待者——批增长的「逐 commit 一批」步进信号。
  // 无依赖数组：overscan 变更、行数据流式变动等任何 commit 都算一次物化进度。
  useEffect(() => {
    flushCommitWaitersRef.current();
  });

  const provider = useMemo(
    () =>
      createConversationFindInPageProvider({
        getScopeEl: () => scopeRef.current,
        searchScopeRanges: (text) => {
          const scope = scopeRef.current;
          return scope === null ? [] : createConversationScopeDomSearch()(scope, text);
        },
        getRenderedUnitCount: () => gettersRef.current.getRenderedUnitCount(),
        getTotalUnitCount: () => gettersRef.current.getTotalUnitCount(),
        requestExpandedMount: (target) => {
          const current = expandedOverscanRef.current;
          if (current !== null && current >= target) {
            // 目标已被既有扩展覆盖：setState 同值不会再产生 commit，直接放行等待者
            // 防 loadRest 批增长悬挂（协调器 4s 封顶前的正常路径）。
            flushCommitWaitersRef.current();
            return;
          }
          setExpandedOverscan(target);
        },
        resetExpandedMount: () => {
          setExpandedOverscan(null);
          // 放行等待者：在途批增长循环醒来后靠代际作废退出，不悬挂 promise。
          flushCommitWaitersRef.current();
        },
        awaitCommitted: () =>
          new Promise<void>((resolve) => {
            commitWaitersRef.current.push(resolve);
          }),
      }),
    [scopeRef],
  );

  // mount 注册 / unmount 注销：先 provider.clear()（复位扩展态、surgical 撤自绘
  // 高亮），再摘注册表（触发协调器 refresh / 桥的能力撤回申报）。
  useEffect(() => {
    const dispose = registerFindInPageProvider(provider);
    return () => {
      provider.clear();
      dispose();
    };
  }, [provider]);

  return expandedOverscan;
}
