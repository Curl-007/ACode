/**
 * 内容状态面包屑的采样折算（specs/main-stall-diagnostics.md R11，ui 侧纯函数）。
 *
 * 数据源都是窗口级、纯内存、零 IO 的既有事实：
 * - route kind ← tabStore activeTab.kind（settings / workspace）；
 * - transcript 规模 ← 存活 projection store 的 turn 索引条目数（目录覆盖全历史，
 *   不受投影窗口裁剪影响，比 rows.window 更贴近「transcript 有多大」）；
 * - 持有行数 ← 存活 projection store 的 rows.window 行数（renderer 常驻行 = 虚拟列表持有量）；
 * - composer 块数 ← composer onChange 推入的 gauge（见 v4/composer/composerContentGauge.ts）。
 *
 * 近似与边界（登记）：projection 汇总是窗口内合计（分屏多会话时不区分 active session）；
 * route kind 一期不产出 "browser"——嵌入浏览器是 workspace body 里的 resizable panel，
 * 其展开态是组件局部 state，无窗口级可读源。桶粒度（zero/small/…/huge）下这些近似
 * 足够支撑卡顿归因，wire 闭集不变（main 侧对未知值归一为 other）。
 */
import type { ContentStateSample } from "@/lib/contentStateBreadcrumb.js";

/** tabStore 的 activeTab.kind 闭集（settings / workspace）；null = 无激活 tab。 */
export function resolveContentRouteKind(activeTabKind: string | null | undefined): string {
  if (activeTabKind === "settings") {
    return "settings";
  }
  if (activeTabKind === "workspace") {
    return "chat";
  }
  return "other";
}

function toCount(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

export interface ContentStateSampleInput {
  activeTabKind: string | null | undefined;
  /** 存活 projection store 汇总（summarizeLiveProjectionStores 的相关字段）。 */
  projectionRows: number | undefined;
  projectionTurnIndexEntries: number | undefined;
  composerBlockCount: number | undefined;
}

export function sampleContentState(input: ContentStateSampleInput): ContentStateSample {
  const routeKind = resolveContentRouteKind(input.activeTabKind);
  return {
    routeKind,
    transcriptMessageCount: toCount(input.projectionTurnIndexEntries),
    // 非 chat 面不读 composer gauge：composer 卸载不清零，避免陈旧值误报（见 gauge 注释）。
    composerBlockCount: routeKind === "chat" ? toCount(input.composerBlockCount) : 0,
    rowsHeldCount: toCount(input.projectionRows),
  };
}
