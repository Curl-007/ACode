import { useCallback, useEffect, useRef, useState } from "react";
import type { AppUsageHeatmapCell } from "@acode/shared";
import { logger } from "@/logger.js";
import { useOptionalServices } from "@/hooks/useServices.js";

/**
 * 用量状态栏「今日合计」的唯一数据源（apps/acode-cli/specs/usage-statusbar-port.md §3.4）：
 * 本地 AppUsage 聚合里今天那一格。按 P1 规则 8 不轮询——调用方在轮收口后防抖调用
 * `refresh()`，组件自身在窗口回到前台时补一次。
 *
 * 查询失败按「无数据」处理（返回 null），由状态栏隐藏该段，不显示 0。
 */
const REFRESH_DEBOUNCE_MS = 5_000;

interface TodayAppUsage {
  totalTokens: number;
  turnCount: number;
  toolCallCount: number;
  // 分项（状态栏「今日合计」明细）。旧 CLI 不带这些字段时为 undefined，
  // 状态栏隐藏对应明细行，不显示 0。
  inputTokens?: number;
  outputTokens?: number;
  cacheHitRate?: number;
  requestCount?: number;
}

function readTodayCell(cells: readonly (AppUsageHeatmapCell | null)[], today: string) {
  for (const cell of cells) {
    if (cell && cell.date === today) return cell;
  }
  return null;
}

function toLocalDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * 今日分项：只透传旧 CLI 没给的字段（缺省 = 整个键不出现），
 * 状态栏据此整行隐藏，而不是把那一天显示成 0。
 */
function readBreakdownFields(cell: AppUsageHeatmapCell): Partial<TodayAppUsage> {
  return {
    ...(cell.inputTokens === undefined ? {} : { inputTokens: cell.inputTokens }),
    ...(cell.outputTokens === undefined ? {} : { outputTokens: cell.outputTokens }),
    ...(cell.cacheHitRate === undefined ? {} : { cacheHitRate: cell.cacheHitRate }),
    ...(cell.requestCount === undefined ? {} : { requestCount: cell.requestCount }),
  };
}

export function useTodayAppUsage(enabled: boolean) {
  const services = useOptionalServices();
  const usageStatsService = services?.usageStatsService ?? null;
  const [todayUsage, setTodayUsage] = useState<TodayAppUsage | null>(null);
  const requestVersionRef = useRef(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    if (!usageStatsService) return;
    const requestVersion = requestVersionRef.current + 1;
    requestVersionRef.current = requestVersion;
    try {
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const snapshot = await usageStatsService.getAppUsageSnapshot({ range: "7d", timeZone });
      if (requestVersionRef.current !== requestVersion) return;
      const today = toLocalDateKey(new Date());
      const cell = readTodayCell(
        snapshot.heatmap.weeks.flatMap((week) => week.days),
        today,
      );
      setTodayUsage(
        cell === null
          ? null
          : {
              totalTokens: cell.totalTokens,
              turnCount: cell.turnCount,
              toolCallCount: cell.toolCallCount,
              ...readBreakdownFields(cell),
            },
      );
    } catch (error) {
      if (requestVersionRef.current !== requestVersion) return;
      logger.warn("[useTodayAppUsage] 读取今日用量失败", {
        error: error instanceof Error ? error.message : String(error),
      });
      setTodayUsage(null);
    }
  }, [usageStatsService]);

  /** 轮收口等事实触发的刷新：防抖 5s，避免连续多轮把查询打成轮询。 */
  const refresh = useCallback(() => {
    if (!enabled) return;
    if (debounceRef.current !== null) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      void load();
    }, REFRESH_DEBOUNCE_MS);
  }, [enabled, load]);

  useEffect(() => {
    if (!enabled) {
      setTodayUsage(null);
      return;
    }
    void load();
  }, [enabled, load]);

  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [enabled, load]);

  useEffect(
    () => () => {
      if (debounceRef.current !== null) clearTimeout(debounceRef.current);
    },
    [],
  );

  return { todayUsage, refresh };
}
