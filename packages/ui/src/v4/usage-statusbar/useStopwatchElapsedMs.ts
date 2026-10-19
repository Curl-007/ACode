import { useEffect, useState } from "react";
import { useACodeStoreWithDefault } from "@/store/StoreProvider.js";
import { deriveElapsedMs } from "@/v4/usage-statusbar/usageStatusbarInFlight.js";

// running 态已耗时秒表（specs/usage-statusbar.md 口径 4 的降级形态）：秒表 = 起始
// 时间戳与当前时刻之差的 UI 本地真实时间，不是用量数字，不受估算禁令约束；但它是
// 状态栏唯一的定时器合法用途——严禁拿它重算速率（live tok/s 只在 inFlight 事实
// 变更时事件驱动重算，见 usageStatusbarInFlight.ts）。
//
// 挂载纪律：1Hz interval 仅在 active（phase running 且需要秒表读数）时挂载；
// unmount / active 落空即清理。reduce-motion 双闸（DESIGN.md 外观偏好轴）：OS 媒体
// 查询或应用内 reduce 档生效时不挂定时器（人为的每秒重渲染即动效），读数退化为
// 渲染时刻现取——流式 re-render 下仍真实，静止时显示最后取值。

function useOsPrefersReducedMotion(): boolean {
  const [prefers, setPrefers] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setPrefers(query.matches);
    update();
    if (typeof query.addEventListener === "function") {
      query.addEventListener("change", update);
      return () => query.removeEventListener("change", update);
    }
    query.addListener(update);
    return () => query.removeListener(update);
  }, []);
  return prefers;
}

export interface StopwatchParams {
  /** 秒表起点（inFlight.startedAtMs 优先，缺席兜底 running turnHeader.startedAt）；null = 无起点。 */
  startedAtMs: number | null;
  /** 仅在需要秒表时置 true（速度位降级态 / 面板进行中分组在场）；false → 不挂定时器、返回 null。 */
  active: boolean;
}

/** 已耗时毫秒数；active=false 或起点缺席 → null（显示层用占位，不猜）。 */
export function useStopwatchElapsedMs({ startedAtMs, active }: StopwatchParams): number | null {
  const reduceMotionPreference = useACodeStoreWithDefault(
    (state) => state.appearancePreferences.reduceMotion,
    "auto",
  );
  const osPrefersReducedMotion = useOsPrefersReducedMotion();
  const reduceMotion = reduceMotionPreference === "reduce" || osPrefersReducedMotion;
  const running = active && startedAtMs !== null;
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!running) return;
    // 挂载/起点换代即刻校一次读数，不继承上一段的陈旧 now。
    setNowMs(Date.now());
    // reduce-motion 双闸：不挂 1Hz 定时器（读数走渲染时刻现取，见下）。
    if (reduceMotion) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running, startedAtMs, reduceMotion]);

  if (!running) return null;
  return deriveElapsedMs(startedAtMs, reduceMotion ? Date.now() : nowMs);
}
