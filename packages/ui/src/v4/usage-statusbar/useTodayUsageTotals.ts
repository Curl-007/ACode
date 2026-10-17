import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppUsageSnapshot } from "@acode/shared";
import type { ConversationSnapshot } from "@acode/shared/acode-protocol-v4";
import { logger } from "@/logger.js";
import { useOptionalServices } from "@/hooks/useServices.js";
import {
  deriveTodayUsageTotals,
  resolveTodayDateKey,
  type TodayUsageTotals,
} from "@/v4/usage-statusbar/usageStatusbarTodayModel.js";

// 今日合计取数（specs/usage-statusbar.md「今日合计」行）：
// 挂载拉取 + turn 完成刷新 + 窗口聚焦刷新，无高频轮询。
// workspace 绑定纪律：服务实例取自组件所在 ServiceProvider——会话 pane 子树注入的是
// 该 workspace（本地或远端 remoteWorkspaceServiceCollection 同源）的 usageStatsService，
// 因此今日量天然按会话所属 workspace 取数，绝不跨 workspace 混算；本 hook 不做任何
// 跨 workspace 兜底（无服务 = 不取数）。

export interface TodayUsageTotalsState {
  totals: TodayUsageTotals | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

interface FetchedTodayUsage {
  appSnapshot: AppUsageSnapshot;
  /** 取数时刻的当天日期键；与快照同代保存，避免跨午夜后错配单元格。 */
  dateKey: string;
}

export function useTodayUsageTotals(params: {
  snapshot: ConversationSnapshot | null;
  enabled: boolean;
}): TodayUsageTotalsState {
  const { snapshot, enabled } = params;
  const services = useOptionalServices();
  const usageStatsService = services?.usageStatsService ?? null;
  const [fetched, setFetched] = useState<FetchedTodayUsage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestVersionRef = useRef(0);

  const refresh = useCallback(() => {
    if (!enabled || !usageStatsService) return;
    const requestVersion = requestVersionRef.current + 1;
    requestVersionRef.current = requestVersion;
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    setLoading(true);
    void usageStatsService
      // AppUsageRange 无 "today" 档；7d 是包含当天的最小档，当天值从 heatmap 提取
      // （date 键与请求 timeZone 同口径，见 usageStatusbarModel.resolveTodayDateKey）。
      .getAppUsageSnapshot({ range: "7d", timeZone })
      .then((appSnapshot) => {
        if (requestVersionRef.current !== requestVersion) return;
        setFetched({ appSnapshot, dateKey: resolveTodayDateKey(timeZone, Date.now()) });
        setLoading(false);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (requestVersionRef.current !== requestVersion) return;
        const message = cause instanceof Error ? cause.message : String(cause);
        logger.warn("[usage-statusbar] 今日合计取数失败", { error: message });
        setLoading(false);
        setError(message);
      });
  }, [enabled, usageStatsService]);

  // 挂载拉取（enabled/服务实例换代时重拉）。
  useEffect(() => {
    refresh();
  }, [refresh]);

  // turn 完成刷新：control.phase 从 running 落到非 running 是权威完成信号，
  // 不受投影行窗口截断（1200 行上限）影响，不做任何定时轮询。
  const phase = snapshot?.control.phase ?? null;
  const previousPhaseRef = useRef(phase);
  useEffect(() => {
    const previousPhase = previousPhaseRef.current;
    previousPhaseRef.current = phase;
    if (previousPhase === "running" && phase !== null && phase !== "running") {
      refresh();
    }
  }, [phase, refresh]);

  // 窗口聚焦刷新（桌面 focus + 手机 Web visibilitychange）。
  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;
    const handleWindowFocus = () => refresh();
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener("focus", handleWindowFocus);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("focus", handleWindowFocus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [enabled, refresh]);

  const totals = useMemo(
    () => (fetched ? deriveTodayUsageTotals(fetched.appSnapshot, fetched.dateKey) : null),
    [fetched],
  );

  return { totals, loading, error, refresh };
}
