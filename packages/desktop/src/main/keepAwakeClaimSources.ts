// keep-awake 认领数据源（specs/shutdown-keepawake-containment.md B2 节 R19-R24）。
// W1-4 台账（keepAwakeClaims.ts）本体没有生产调用方；本模块把三类 claim 接到既有
// 生命周期事件面：
// - turn ← host 运行计数：desktopHostProcess.ts 在 AgentRunningTaskCountChanged 时写
//   hostRunningTaskCountMap（仅计数、无会话明细）。本模块提供可观察 Map
//   （set/delete/clear 钩子同步调整 claim），index.ts 在 map 声明处替换实例即完成
//   接线，host 上报写路径零改动（单一写者不变）。
// - loop ← cron 运行：desktopCronScheduler 派发成功上报 onCronRunDispatched，main 的
//   forwardCronRunResult 结算上报 handleCronRunSettled；runId 全局唯一，合成会话
//   cron:<runId>。
// - background_task ← scheduler offpeak-active-count（仅计数、无 task 明细），按槽位
//   合成 offpeak:<slot>。
// 本文件不 import electron、不触碰 blocker：claim 只写入注入的台账（R8 单一所有者，
// blocker 仍由台账 reconcile 单点起停）；模块 inert-until-wired——import 无副作用，
// 全部事件入口经 installKeepAwakeClaimSources 返回的句柄由接线方显式调用（DI 可单测）。

import type { KeepAwakeClaimsController, KeepAwakeClaimsLogger } from "./keepAwakeClaims.js";

export interface KeepAwakeClaimSourcesDeps {
  /** 唯一 claim 写入目标（installKeepAwakeClaims 的输出）。 */
  claims: KeepAwakeClaimsController;
  logger: KeepAwakeClaimsLogger;
}

/** cron 派发成功上报（desktopCronScheduler onCronRunDispatched 的载荷）。 */
export interface KeepAwakeCronRunDispatchedInfo {
  runId: string;
  automationId?: string;
}

/** cron 结算上报（与 main forwardCronRunResult 的 CronRunResultPayload 兼容面）。 */
export interface KeepAwakeCronRunSettledInfo {
  runId: string;
  ok?: boolean;
}

export interface KeepAwakeClaimSourcesController {
  /**
   * 创建可观察 hostRunningTaskCountMap（turn claim 唯一数据源，R20）：
   * set/delete/clear 钩子同步 acquire/releaseSession；map 写入语义与原生 Map 完全
   * 一致（无效计数只拒绝记 claim、不拦截写入，不改变退出屏障的计数口径）。
   */
  createHostRunningTaskCountMap<K extends object>(): Map<K, number>;
  /** scheduler offpeak-active-count → background_task 槽位合成 claim（R22）。 */
  handleOffPeakActiveCountChanged(count: number): void;
  /** cron 派发成功 → acquire("loop", cron:<runId>)（R21）。 */
  handleCronRunDispatched(info: KeepAwakeCronRunDispatchedInfo): void;
  /** cron 结算 → releaseSession(cron:<runId>, ok ? close : error)（R21）。 */
  handleCronRunSettled(info: KeepAwakeCronRunSettledInfo): void;
  /** 收口后事件迟到静默 no-op；claim 台账 teardown 由 keepAwakeClaims.dispose() 承担（R24）。 */
  dispose(): void;
}

/** 单一计数可合成的槽位上限：防异常计数把台账无限吹大（R20/R22，超限 clamp+warn）。 */
const MAX_SYNTHETIC_SLOTS = 256;

export function installKeepAwakeClaimSources(
  deps: KeepAwakeClaimSourcesDeps,
): KeepAwakeClaimSourcesController {
  const { claims, logger } = deps;
  let disposed = false;
  // host 进程对象 → 合成序号/当前计数。WeakMap：条目随 host 对象生命周期回收；
  // delete 后保留 count=0 的条目，同一 host 计数回来时沿用同一序号（身份不换）。
  let nextHostOrdinal = 0;
  const hostStates = new WeakMap<object, { ordinal: number; count: number }>();
  /** 已占用的 off-peak 槽位序号（1..count；位置身份，不指向固定 task，R19）。 */
  const offPeakSlots = new Set<number>();
  /** 已派发未结算的 cron runId（重复派发去重 + dispose 清点口径）。 */
  const cronRuns = new Set<string>();

  function turnSessionId(ordinal: number, slot: number): string {
    return `host:${ordinal}:${slot}`;
  }

  function rejectInvalid(source: string, outcome: string): void {
    // 拒绝原因只进结构化字段、不回显原始值：runId 由 automationId 拼段，可能含
    // 用户侧命名；台账侧对真实会话 id 有 sanitizeForLog，数据源侧直接不落内容。
    logger.warn(`[keep-awake-sources] ${source} event rejected (${outcome})`, {
      event: "keep_awake_claim_source_rejected",
      outcome,
      source,
    });
  }

  function normalizeCount(source: string, value: unknown): number | undefined {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      rejectInvalid(source, "invalid_count");
      return undefined;
    }
    if (value > MAX_SYNTHETIC_SLOTS) {
      logger.warn(`[keep-awake-sources] ${source} count clamped to ${MAX_SYNTHETIC_SLOTS}`, {
        event: "keep_awake_claim_source_clamped",
        outcome: "count_clamped",
        source,
        count: value,
        max_slots: MAX_SYNTHETIC_SLOTS,
      });
      return MAX_SYNTHETIC_SLOTS;
    }
    return value;
  }

  /** 计数上升逐槽 acquire；下降逐槽 releaseSession(close)（R20）。 */
  function applyHostRunningCount(host: object, rawCount: unknown): void {
    const count = normalizeCount("host_running_task_count", rawCount);
    if (count === undefined) {
      return;
    }
    let state = hostStates.get(host);
    if (state === undefined) {
      nextHostOrdinal += 1;
      state = { ordinal: nextHostOrdinal, count: 0 };
      hostStates.set(host, state);
    }
    const previous = state.count;
    if (count === previous) {
      return;
    }
    for (let slot = previous + 1; slot <= count; slot += 1) {
      claims.acquire("turn", turnSessionId(state.ordinal, slot));
    }
    for (let slot = previous; slot > count; slot -= 1) {
      // 运行任务数回落 = 对应合成会话到达终结态 close（数据源只用闭集子集
      // {close,error}，R23；未知状态拒绝+warn 语义由台账 releaseSession 承担）。
      claims.releaseSession(turnSessionId(state.ordinal, slot), "close");
    }
    state.count = count;
  }

  /** host 计数移除（count<=0 或 host exit）：该 host 全部 turn 槽位终结 close。 */
  function releaseHostTurns(host: object): void {
    const state = hostStates.get(host);
    if (state === undefined) {
      return;
    }
    for (let slot = state.count; slot >= 1; slot -= 1) {
      claims.releaseSession(turnSessionId(state.ordinal, slot), "close");
    }
    state.count = 0;
  }

  /**
   * 可观察 Map：钩子只叠加 claim 记账，不改变 Map 语义（写入永远透传——
   * hostRunningTaskCountMap 同时是退出屏障 getRunningAgentSessionCount 的口径，
   * 数据源不得拦截或改写它）。
   */
  class ObservedHostRunningTaskCountMap<K extends object> extends Map<K, number> {
    set(key: K, value: number): this {
      if (!disposed) {
        applyHostRunningCount(key, value);
      }
      return super.set(key, value);
    }
    delete(key: K): boolean {
      if (!disposed) {
        releaseHostTurns(key);
      }
      return super.delete(key);
    }
    clear(): void {
      if (!disposed) {
        for (const key of this.keys()) {
          releaseHostTurns(key);
        }
      }
      super.clear();
    }
  }

  logger.info("[keep-awake-sources] claim sources installed", {
    event: "keep_awake_claim_sources_installed",
    outcome: "installed",
  });

  return {
    createHostRunningTaskCountMap<K extends object>(): Map<K, number> {
      return new ObservedHostRunningTaskCountMap<K>();
    },
    handleOffPeakActiveCountChanged(count) {
      if (disposed) {
        return;
      }
      const next = normalizeCount("offpeak_active_count", count);
      if (next === undefined) {
        return;
      }
      // 槽位身份 = 位置（offpeak-active-count 不携带 task 明细，R19）：同一计数下
      // task 集合可能换血，但 keep-awake 语义只关心「有多少闲时任务在跑」+ 逐 claim
      // 持有计量，槽位合成满足 R11 计量与 R9.3 的 2h 上限兜底。
      while (offPeakSlots.size < next) {
        const slot = offPeakSlots.size + 1;
        offPeakSlots.add(slot);
        claims.acquire("background_task", `offpeak:${slot}`);
      }
      while (offPeakSlots.size > next) {
        const slot = offPeakSlots.size;
        offPeakSlots.delete(slot);
        claims.releaseSession(`offpeak:${slot}`, "close");
      }
    },
    handleCronRunDispatched(info) {
      if (disposed) {
        return;
      }
      const runId = typeof info?.runId === "string" ? info.runId.trim() : "";
      if (runId.length === 0) {
        rejectInvalid("cron_run", "invalid_run_id");
        return;
      }
      if (cronRuns.has(runId)) {
        // 重复派发上报：台账 acquire 本身幂等（同 key 不重置持有窗口），这里只维护
        // 本地清点集合，不重复 acquire。
        return;
      }
      cronRuns.add(runId);
      claims.acquire("loop", `cron:${runId}`);
    },
    handleCronRunSettled(info) {
      if (disposed) {
        return;
      }
      const runId = typeof info?.runId === "string" ? info.runId.trim() : "";
      if (runId.length === 0) {
        rejectInvalid("cron_run", "invalid_run_id");
        return;
      }
      // 迟到/重复结算幂等（scheduler 协议允许仅凭 runId 结算）：清点无此项也不
      // warn——releaseSession 在无 claim 时本身就是 no-op。
      cronRuns.delete(runId);
      claims.releaseSession(`cron:${runId}`, info?.ok === false ? "error" : "close");
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      // 不逐项 releaseSession：退出路径的 claim 台账 teardown 由 keepAwakeClaims
      // .dispose() 单点承担（清 timer、停 blocker），数据源再逐项释放只会制造
      // 重复的释放日志（R24）。
      offPeakSlots.clear();
      cronRuns.clear();
    },
  };
}
