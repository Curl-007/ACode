import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import type { SessionDataLayer } from "@/v4/sessionDataLayer.js";
import {
  isLiveOutputPhase,
  readChildSessionTokenTotal,
  readLiveOutputObservation,
} from "./sessionTokenStats.js";

// 子会话结束后不再订阅（见 collectLiveChildSessionIds），它运行期间最后一次读到的用量
// 留在这里供会话累计继续计入；按 childSessionId 全局唯一，有界淘汰最旧的。
const MAX_REMEMBERED_CHILD_TOTALS = 512;
const rememberedChildTokenTotals = new Map<string, number>();

function rememberChildTokenTotal(childSessionId: string, total: number): void {
  rememberedChildTokenTotals.delete(childSessionId);
  rememberedChildTokenTotals.set(childSessionId, total);
  if (rememberedChildTokenTotals.size > MAX_REMEMBERED_CHILD_TOTALS) {
    rememberedChildTokenTotals.delete(rememberedChildTokenTotals.keys().next().value!);
  }
}

/**
 * @param childSessionIds 会话的全部子会话（含已结束），只用于计数与合计口径。
 * @param liveChildSessionIds 需要实时订阅的子会话（运行中且已截断到上限）。
 */
export function useChildSessionTokenStats(
  layer: SessionDataLayer,
  childSessionIds: readonly string[],
  liveChildSessionIds: readonly string[],
) {
  const idKey = liveChildSessionIds.join("\0");
  const leases = useMemo(
    () => (idKey ? idKey.split("\0").map((id) => layer.acquire(id)) : []),
    [idKey, layer],
  );
  useEffect(() => () => leases.forEach((lease) => lease.release()), [leases]);

  const subscribe = useCallback(
    (listener: () => void) => {
      const unsubscribes = leases.map((lease) => lease.store.subscribe(listener));
      return () => unsubscribes.forEach((unsubscribe) => unsubscribe());
    },
    [leases],
  );
  const getVersion = useCallback(
    () =>
      leases
        .map(({ store }) => {
          const { status, snapshot } = store.getState();
          return `${status}:${snapshot?.seq ?? ""}:${snapshot?.revision ?? ""}`;
        })
        .join("|"),
    [leases],
  );
  const version = useSyncExternalStore(subscribe, getVersion, () => "");
  const snapshots = useMemo(
    () => leases.map(({ store }) => store.getState().snapshot),
    [leases, version],
  );
  // 按 childSessionId 的单任务累计（子代理任务级面板用）：与只读子面板同一读法，
  // 读不到的子会话不进表，面板据此省略该行用量而不是显示 0。
  const tokenTotalByChildId = useMemo(() => {
    const totals = new Map<string, number>();
    leases.forEach((lease, index) => {
      const snapshot = snapshots[index];
      if (!snapshot || !lease.sessionId) return;
      const total = readChildSessionTokenTotal(snapshot);
      if (total === null) return;
      totals.set(lease.sessionId, total);
      rememberChildTokenTotal(lease.sessionId, total);
    });
    return totals;
  }, [leases, snapshots]);
  // 会话累计里的子会话合计：运行中取实时值，已结束取记住的最后值，都没有的计为未知（段值带 ≥）。
  const childKey = childSessionIds.join("\0");
  const { tokenTotal, unknownCount } = useMemo(() => {
    let sum = 0;
    let unknown = 0;
    for (const id of childKey ? childKey.split("\0") : []) {
      const total = tokenTotalByChildId.get(id) ?? rememberedChildTokenTotals.get(id);
      if (total === undefined) unknown += 1;
      else sum += total;
    }
    return { tokenTotal: sum, unknownCount: unknown };
  }, [childKey, tokenTotalByChildId]);
  // 按 childSessionId 的单任务实时输出速度（子代理面板每行显示「这一个任务」多快）：
  // 与段值合计同源——合计就是这张表求和，不会出现「合计有速度、单任务全空」。
  const rateByChildId = useMemo(() => {
    const rates = new Map<string, number>();
    leases.forEach((lease, index) => {
      const snapshot = snapshots[index];
      if (!snapshot || !lease.sessionId || !isLiveOutputPhase(snapshot.control.phase)) return;
      const rate = layer.liveOutputRates.read(snapshot);
      if (rate === null || rate <= 0) return;
      rates.set(lease.sessionId, rate);
    });
    return rates;
  }, [leases, snapshots, layer]);
  const activeSamples = useMemo(
    () =>
      snapshots.flatMap((snapshot) => {
        const observation = readLiveOutputObservation(snapshot);
        if (!observation) return [];
        return [{ sample: observation.sample }];
      }),
    [snapshots],
  );
  const currentOutputTokens = activeSamples.reduce(
    (sum, { sample }) => sum + sample.estimatedTokens,
    0,
  );
  return {
    tokenTotal,
    unknownCount,
    tokenTotalByChildId,
    rateByChildId,
    currentOutputTokens: activeSamples.length ? currentOutputTokens : null,
    liveOutputRate: rateByChildId.size
      ? [...rateByChildId.values()].reduce((sum, rate) => sum + rate, 0)
      : null,
    childCount: childSessionIds.length,
  };
}
