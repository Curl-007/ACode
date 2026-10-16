import type { AppUsageSnapshot } from "@acode/shared";

// 今日合计派生（specs/usage-statusbar.md「今日合计」行）：从 AppUsageSnapshot 的
// heatmap 面提取当天单元格（heatmap 日期 = YYYY-MM-DD@请求 timeZone，与 bootstrap
// usage-stats-builder 的 dayIndex 口径一致）。AppUsageRange 无 "today" 档，取数 hook
// 用包含当天的最小档 7d，再在此按日期键命中。纯函数，无 IO。

export interface TodayUsageTotals {
  totalTokens: number;
  turnCount: number;
  toolCallCount: number;
}

/**
 * 当天日期键（YYYY-MM-DD），按请求 timeZone 计算本地日。
 * en-CA 的 Intl 输出即 ISO 日期形状。
 */
export function resolveTodayDateKey(timeZone: string, nowMs: number): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(nowMs));
  } catch {
    // 非法 timeZone 回退 UTC，绝不抛错阻断状态栏渲染。
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(nowMs));
  }
}

/**
 * 从 App Usage 快照的 heatmap 提取当天合计；无该日期单元格 → null（无数据 ≠ 0，
 * 消费端显示占位）。快照本身来自会话所属 workspace 的服务实例，不跨 workspace 混算
 * （数据面纪律由取数 hook 保证）。
 */
export function deriveTodayUsageTotals(
  snapshot: AppUsageSnapshot | null | undefined,
  todayDateKey: string,
): TodayUsageTotals | null {
  if (!snapshot || !todayDateKey) return null;
  for (const week of snapshot.heatmap?.weeks ?? []) {
    for (const cell of week.days) {
      if (cell && cell.date === todayDateKey) {
        return {
          totalTokens: Number.isFinite(cell.totalTokens) ? cell.totalTokens : 0,
          turnCount: Number.isFinite(cell.turnCount) ? cell.turnCount : 0,
          toolCallCount: Number.isFinite(cell.toolCallCount) ? cell.toolCallCount : 0,
        };
      }
    }
  }
  return null;
}
