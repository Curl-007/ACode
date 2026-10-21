/**
 * 页内查找二期：renderer 多腿协调器（specs: packages/desktop/specs/find-in-page.md R9-R13）。
 *
 * 蓝本多 provider 协调器的机制移植：内置 DOM 腿 + scope provider 腿按文档序归并成
 * 单一命中序列；epoch 守卫（clear/注册表失效即作废在途搜索与重绘重试）；
 * activeInRenderedWindow + loadRest 虚拟化感知（total=0 时触发物化，grow 重搜一次，
 * active 保持、total 只增）；重绘重试预算（double-rAF，6 次封顶）。
 *
 * DOM 触面全部经 FindInPageCoordinatorEnv 注入——本文件是纯编排，node 可测。
 * 所有 provider 回调 safe-call：抛错按 0 命中/无操作收口（spec R14）。
 */
import type { FindInPageDispatchPayload, FindInPageResult } from "@acode/shared";
import type { FindInPageScopeProvider } from "./findInPageProvider.js";
import { getFindInPageProviders } from "./findInPageProvider.js";
import type { FindInPageCoordinatorEnv } from "./findInPageCoordinatorEnv.js";
import { createBrowserCoordinatorEnv } from "./findInPageCoordinatorEnv.js";

/** loadRest 单个 provider 的等待封顶（蓝本 4s 同构）。 */
const FIND_LOAD_REST_TIMEOUT_MS = 4000;
/** 重绘重试预算（蓝本 double-rAF 重试的收口值；epoch 失配即停）。 */
const FIND_REPAINT_RETRY_BUDGET = 6;

const EMPTY_FIND_RESULT: FindInPageResult = { activeIndex: 0, total: 0 };

type FindSearchMode = "new" | "step" | "incremental" | "grow";

interface DomLeg {
  kind: "dom";
  ranges: unknown[];
}

interface ProviderLeg {
  kind: "provider";
  provider: FindInPageScopeProvider;
  count: number;
}

type MergedLeg = DomLeg | ProviderLeg;

function safeCall<T>(fn: (() => T) | undefined, fallback: T): T {
  if (!fn) {
    return fallback;
  }
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function safeCount(provider: FindInPageScopeProvider, text: string): number {
  const value = safeCall(() => provider.count(text), 0);
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

/**
 * 纯核心：active 序号选择（0-based，-1 = 无）。
 * - new：首命中（蓝本 Y=m>0?0:-1 同构；provider 路不做「视口最近」，文档序首命中可预期）；
 * - step：±1 循环 wrap；prev 无效时 forward→首 / backward→尾；
 * - incremental：exactRemapIndex 命中（边界全等的 dom range）优先，否则序号 clamp；
 * - grow：active 保持，clamp 进 [0,total-1]（loadRest 物化后 total 只增）。
 */
export function selectActiveIndex(
  mode: FindSearchMode,
  previousActive: number,
  total: number,
  forward: boolean,
  exactRemapIndex: number,
): number {
  if (total <= 0) {
    return -1;
  }
  switch (mode) {
    case "new":
      return 0;
    case "step": {
      if (previousActive < 0) {
        return forward ? 0 : total - 1;
      }
      const base = Math.min(previousActive, total - 1);
      return (base + (forward ? 1 : -1) + total) % total;
    }
    case "incremental": {
      if (previousActive < 0) {
        return 0;
      }
      if (exactRemapIndex >= 0 && exactRemapIndex < total) {
        return exactRemapIndex;
      }
      return Math.min(previousActive, total - 1);
    }
    case "grow":
      return Math.min(Math.max(previousActive, 0), total - 1);
  }
}

/**
 * 纯核心：文档序归并。domRanges 已按文档序；connectedScopes 已按文档序排好。
 * range 落在某 scope 之前 → 归入当前 dom 段；否则封段并插入 provider 腿。
 * 返回的腿序列即全局命中序（total = 各腿 count 之和）。
 */
export function mergeLegsInDocumentOrder(
  domRanges: readonly unknown[],
  connectedScopes: ReadonlyArray<{ provider: FindInPageScopeProvider; el: unknown; count: number }>,
  rangeOrderKey: (range: unknown) => unknown,
  compare: (a: unknown, b: unknown) => number,
): MergedLeg[] {
  const legs: MergedLeg[] = [];
  let segmentStart = 0;
  let cursor = 0;
  const closeDomSegment = (end: number): void => {
    if (end > segmentStart) {
      legs.push({ kind: "dom", ranges: domRanges.slice(segmentStart, end) });
      segmentStart = end;
    }
  };
  for (const scope of connectedScopes) {
    while (cursor < domRanges.length && compare(rangeOrderKey(domRanges[cursor]), scope.el) < 0) {
      cursor += 1;
    }
    closeDomSegment(cursor);
    legs.push({ kind: "provider", provider: scope.provider, count: scope.count });
  }
  closeDomSegment(domRanges.length);
  return legs;
}

export interface FindInPageCoordinator {
  dispatchFind(payload: FindInPageDispatchPayload): Promise<FindInPageResult>;
  clear(): void;
  /** 注册表变动后的重归并（查询激活时 grow 重搜；main 无 pending，纯 UI 一致性）。 */
  refresh(): void;
  readonly localEpoch: number;
  readonly currentQuery: string;
}

export function createFindInPageCoordinator(options?: {
  env?: FindInPageCoordinatorEnv;
  loadRestTimeoutMs?: number;
  repaintRetryBudget?: number;
}): FindInPageCoordinator {
  const env = options?.env ?? createBrowserCoordinatorEnv();
  const loadRestTimeoutMs = options?.loadRestTimeoutMs ?? FIND_LOAD_REST_TIMEOUT_MS;
  const repaintRetryBudget = options?.repaintRetryBudget ?? FIND_REPAINT_RETRY_BUDGET;

  let currentQuery = "";
  /** 0-based 全局 active 序号；-1 = 无。 */
  let activeIndex = -1;
  let localEpoch = 0;
  /** 上一轮 active 的 dom range（增量重搜的 exact remap 判据）。 */
  let lastActiveDomRange: unknown | null = null;

  const withTimeout = (promise: Promise<void> | void): Promise<void> => {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, loadRestTimeoutMs);
      Promise.resolve(promise).then(
        () => {
          clearTimeout(timer);
          resolve();
        },
        () => {
          clearTimeout(timer);
          resolve();
        },
      );
    });
  };

  const scheduleRepaintCheck = (range: unknown, epochAtPaint: number): void => {
    let attempts = 0;
    const check = (): void => {
      if (epochAtPaint !== localEpoch) {
        return; // epoch 守卫：clear/失效后不再追赶移动布局。
      }
      if (env.measureRangeHeight(range) > 0) {
        return;
      }
      attempts += 1;
      if (attempts > repaintRetryBudget) {
        return;
      }
      env.applyActiveHighlight(range); // 重绘（布局未就绪时 Highlight 可能没画上）。
      env.scheduleFramePair(check);
    };
    env.scheduleFramePair(check);
  };

  function runSearch(text: string, mode: FindSearchMode, forward: boolean): FindInPageResult {
    if (!env.hasDocument()) {
      currentQuery = text;
      activeIndex = -1;
      lastActiveDomRange = null;
      return EMPTY_FIND_RESULT;
    }
    const providers = [...getFindInPageProviders()];
    // scope 分档：已连接（参与文档序插入）/ 失联（排尾，蓝本 s 数组同构）。
    const connected: Array<{ provider: FindInPageScopeProvider; el: unknown }> = [];
    const disconnected: FindInPageScopeProvider[] = [];
    for (const provider of providers) {
      const el = safeCall(() => provider.getScopeEl(), null);
      if (el && env.isConnected(el)) {
        connected.push({ provider, el: env.hostify(el) });
      } else {
        disconnected.push(provider);
      }
    }
    connected.sort((a, b) => env.comparePosition(a.el, b.el));

    const exclude = new Set<unknown>(connected.map((entry) => entry.el));
    const domRanges = env.searchDocument(text, exclude);

    const scopedCounts = connected.map((entry) => ({
      provider: entry.provider,
      el: entry.el,
      count: safeCount(entry.provider, text),
    }));
    const legs = mergeLegsInDocumentOrder(
      domRanges,
      scopedCounts,
      (range) => env.hostify(env.rangeStartNode(range)),
      env.comparePosition,
    );
    for (const provider of disconnected) {
      legs.push({ kind: "provider", provider, count: safeCount(provider, text) });
    }

    const total = legs.reduce(
      (sum, leg) => sum + (leg.kind === "dom" ? leg.ranges.length : leg.count),
      0,
    );

    // exact remap：上一轮 active dom range 在新 ranges 里找边界全等者（全局序号）。
    let exactRemapIndex = -1;
    if (lastActiveDomRange !== null) {
      let walked = 0;
      for (const leg of legs) {
        if (leg.kind === "dom") {
          for (const range of leg.ranges) {
            if (env.sameRangeBoundaries(lastActiveDomRange, range)) {
              exactRemapIndex = walked;
              break;
            }
            walked += 1;
          }
        } else {
          walked += leg.count;
        }
        if (exactRemapIndex >= 0) {
          break;
        }
      }
    }

    activeIndex = selectActiveIndex(mode, activeIndex, total, forward, exactRemapIndex);
    currentQuery = text;

    // 全局 active → (腿, 腿内序号)。
    let activeLegIndex = -1;
    let activeInLeg = -1;
    if (activeIndex >= 0) {
      let walked = 0;
      for (let index = 0; index < legs.length; index += 1) {
        const leg = legs[index];
        if (!leg) {
          continue;
        }
        const legTotal = leg.kind === "dom" ? leg.ranges.length : leg.count;
        if (activeIndex < walked + legTotal) {
          activeLegIndex = index;
          activeInLeg = activeIndex - walked;
          break;
        }
        walked += legTotal;
      }
    }

    // 绘制：全部命中层（dom ranges）+ active 层 + provider 腿各自的 show。
    env.clearHighlights();
    const allDomRanges = legs.flatMap((leg) => (leg.kind === "dom" ? leg.ranges : []));
    env.applyMatchHighlight(allDomRanges);
    let activeInRenderedWindow: boolean | undefined;
    lastActiveDomRange = null;
    const epochAtPaint = localEpoch;
    legs.forEach((leg, index) => {
      if (leg.kind === "provider") {
        safeCall(
          () => leg.provider.show(text, index === activeLegIndex ? activeInLeg : -1, epochAtPaint),
          undefined,
        );
        if (index === activeLegIndex) {
          activeInRenderedWindow =
            safeCall(
              leg.provider.isMatchRendered
                ? () => leg.provider.isMatchRendered?.(text, activeInLeg)
                : undefined,
              true,
            ) !== false;
        }
        return;
      }
      if (index === activeLegIndex) {
        const range = leg.ranges[activeInLeg] ?? null;
        lastActiveDomRange = range;
        activeInRenderedWindow = true; // 内置 DOM 腿命中天然在已渲染窗口。
        if (range) {
          env.applyActiveHighlight(range);
          env.scrollRangeIntoView(range);
          scheduleRepaintCheck(range, epochAtPaint);
        }
      }
    });

    // 虚拟化不可搜标记：无 loadRest 能力且申报有未渲染内容的 scope（spec R11）。
    const hasUnsearchableRegions = providers.some(
      (provider) =>
        typeof provider.loadRest !== "function" &&
        safeCall(() => provider.hasUnrenderedContent?.(), false) === true,
    );

    return {
      activeIndex: activeIndex >= 0 ? activeIndex + 1 : 0,
      total,
      ...(activeInRenderedWindow !== undefined && { activeInRenderedWindow }),
      ...(hasUnsearchableRegions && { hasUnsearchableRegions }),
    };
  }

  return {
    get localEpoch() {
      return localEpoch;
    },
    get currentQuery() {
      return currentQuery;
    },
    async dispatchFind(payload: FindInPageDispatchPayload): Promise<FindInPageResult> {
      const epochAtStart = localEpoch;
      const mode: FindSearchMode =
        payload.text !== currentQuery ? "new" : payload.findNext ? "incremental" : "step";
      try {
        let result = runSearch(payload.text, mode, payload.forward);
        if (result.total === 0) {
          // loadRest grow：仅零命中时触发（蓝本 Y<0 判定同构），全部 provider 并行，
          // 每个 4s 封顶；等待期间被 clear（epoch 变动）则作废本轮。
          const growers = [...getFindInPageProviders()].filter(
            (provider) => typeof provider.loadRest === "function",
          );
          if (growers.length > 0) {
            await Promise.all(
              growers.map((provider) =>
                withTimeout(safeCall(() => provider.loadRest?.(), undefined)),
              ),
            );
            if (epochAtStart !== localEpoch) {
              return EMPTY_FIND_RESULT;
            }
            result = runSearch(payload.text, "grow", payload.forward);
          }
        }
        return result;
      } catch {
        // 协调器自身异常也 fail-soft 收口 {0,0}（spec R14），不向桥/receiver 抛错。
        return EMPTY_FIND_RESULT;
      }
    },
    clear(): void {
      localEpoch += 1;
      currentQuery = "";
      activeIndex = -1;
      lastActiveDomRange = null;
      env.clearHighlights();
      for (const provider of getFindInPageProviders()) {
        safeCall(() => provider.clear(), undefined);
      }
    },
    refresh(): void {
      if (currentQuery === "") {
        return;
      }
      try {
        runSearch(currentQuery, "grow", true);
      } catch {
        // 同 dispatchFind：fail-soft，不向订阅链抛错。
      }
    },
  };
}

/** 桥接共用的模块级单例（浏览器环境；node 测试自建实例注入 stub env）。 */
let sharedCoordinator: FindInPageCoordinator | null = null;

export function getSharedFindInPageCoordinator(): FindInPageCoordinator {
  if (!sharedCoordinator) {
    sharedCoordinator = createFindInPageCoordinator();
  }
  return sharedCoordinator;
}
