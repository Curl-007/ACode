import type { ConversationRow, SessionUsageInFlight } from "@acode/shared/acode-protocol-v4";

// In-flight live 事实派生（specs/usage-statusbar.md「In-flight 真实用量事实面」与
// 「面板明细与实时动态显示口径」节，2026-10-19）。从 usageStatusbarModel 拆出的原因：
// 该文件逼近 400 行 ratchet，且本块自成一个关注点（running 态 live 显示的单点派生），
// 经 usageStatusbarModel re-export 保持既有导入面（同 usageStatusbarPresence 先例）。
//
// 红线纪律（spec 口径 4 的 2026-10-19 改写版）：
// - UI 只消费 producer 下发的真实 in-flight 事实，事件驱动重算（消费端 useMemo 依赖
//   inFlight）；严禁 UI 定时器重算速率、严禁字符数折算、严禁任何无事实依据的数字。
// - 事实缺席 = provider 无中途 usage（如 OpenAI 系 include_usage 仅末包）→ 如实返回
//   null，显示层降级为「生成中 + 已耗时秒表」（秒表是 UI 本地真实时间，不是用量
//   数字，不受估算禁令约束），绝不显示假速率。
// - 空闲态（phase 非 running）一律忽略 inFlight：投影保证清除，但消费端仍按相位门
//   双保险（重连/重放不出现幽灵「进行中」）。

/** optional 数值字段归一：非有限数 → null（缺席 ≠ 0，不当零值渲染）。 */
function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export interface UsageInFlightLiveView {
  /**
   * 进行中 tok/s（spec 口径 4 进行中值）= partialOutputTokens ÷ ((observedAtMs −
   * startedAtMs)/1000)，分母从请求起算（与含思考请求的权威口径一致）。
   * 无 partialOutputTokens 事实 / 分母非法 → null（降级秒表，绝不造速率）。
   */
  liveTokensPerSecond: number | null;
  /** message_delta 累计输出真值（含思考）；缺席 = provider 无中途输出事实。 */
  partialOutputTokens: number | null;
  /** message_start 通告输入真值（上下文环 overlay 与面板行消费）；缺席 = null。 */
  announcedInputTokens: number | null;
  /** 首字耗时进行中形态 = firstTokenAtMs − startedAtMs；firstTokenAtMs 缺席/非法 → null。 */
  timeToFirstTokenMs: number | null;
  /** 本请求起点（秒表降级也用此起点）。 */
  startedAtMs: number | null;
  /** 事实携带的已耗时 = observedAtMs − startedAtMs；非法 → null。 */
  observedElapsedMs: number | null;
  turnToDateInputTokens: number | null;
  turnToDateOutputTokens: number | null;
  /**
   * 本轮 live 合计 = turnToDateInput + turnToDateOutput。两者同代写入（投影
   * TurnUsageAccumulator + partial），任一缺席 → null（回退权威显示，不做缺席当 0
   * 的部分合计）。TurnComplete 后 inFlight=null 自然回落权威 turnHeader.stats。
   */
  turnToDateTotalTokens: number | null;
}

const IDLE_IN_FLIGHT_VIEW: UsageInFlightLiveView = {
  liveTokensPerSecond: null,
  partialOutputTokens: null,
  announcedInputTokens: null,
  timeToFirstTokenMs: null,
  startedAtMs: null,
  observedElapsedMs: null,
  turnToDateInputTokens: null,
  turnToDateOutputTokens: null,
  turnToDateTotalTokens: null,
};

/**
 * running 态 live 视图的唯一派生入口。相位门在本函数内单点收口：
 * !phaseRunning 或 inFlight 缺席（null/undefined）→ 全 null 视图（空闲态维持权威显示）。
 */
export function deriveUsageInFlightLiveView(params: {
  phaseRunning: boolean;
  inFlight: SessionUsageInFlight | null | undefined;
}): UsageInFlightLiveView {
  const { phaseRunning, inFlight } = params;
  if (!phaseRunning || !inFlight) return IDLE_IN_FLIGHT_VIEW;
  const startedAtMs = finiteOrNull(inFlight.startedAtMs);
  const observedAtMs = finiteOrNull(inFlight.observedAtMs);
  const partialOutputTokens = finiteOrNull(inFlight.partialOutputTokens);
  const firstTokenAtMs = finiteOrNull(inFlight.firstTokenAtMs);
  const observedElapsedMs =
    startedAtMs !== null && observedAtMs !== null && observedAtMs > startedAtMs
      ? observedAtMs - startedAtMs
      : null;
  const turnToDateInputTokens = finiteOrNull(inFlight.turnToDateInputTokens);
  const turnToDateOutputTokens = finiteOrNull(inFlight.turnToDateOutputTokens);
  return {
    // 进行中值只在 partialOutputTokens 与合法分母同时在场时计算；否则 null（降级）。
    liveTokensPerSecond:
      partialOutputTokens !== null && observedElapsedMs !== null && observedElapsedMs > 0
        ? partialOutputTokens / (observedElapsedMs / 1000)
        : null,
    partialOutputTokens,
    announcedInputTokens: finiteOrNull(inFlight.announcedInputTokens),
    timeToFirstTokenMs:
      firstTokenAtMs !== null && startedAtMs !== null && firstTokenAtMs >= startedAtMs
        ? firstTokenAtMs - startedAtMs
        : null,
    startedAtMs,
    observedElapsedMs,
    turnToDateInputTokens,
    turnToDateOutputTokens,
    turnToDateTotalTokens:
      turnToDateInputTokens !== null && turnToDateOutputTokens !== null
        ? turnToDateInputTokens + turnToDateOutputTokens
        : null,
  };
}

export type UsageSpeedDisplayMode = "authoritative" | "live" | "stopwatch";

/**
 * 速度胶囊显示档位（spec「进行中显示」）：
 * - 空闲 → authoritative（最近一次模型请求 tok/s 权威值，既有路径）；
 * - running 且有 live 事实 → live（进行中 tok/s，事件驱动更新）；
 * - running 且无 live 事实 → stopwatch（「生成中 · 已耗时」秒表降级，绝不显示假速率）。
 */
export function resolveUsageSpeedDisplayMode(params: {
  phaseRunning: boolean;
  liveTokensPerSecond: number | null;
}): UsageSpeedDisplayMode {
  if (!params.phaseRunning) return "authoritative";
  return params.liveTokensPerSecond !== null ? "live" : "stopwatch";
}

/**
 * 秒表起点兜底：inFlight 缺席（provider 无中途 usage 事实）时，取最近一个 running
 * turnHeader 行的 startedAt（投影权威时间戳）作为「已耗时」起点；无 → null（显示层
 * 用占位，不猜起点）。
 */
export function deriveRunningTurnStartedAtMs(
  rows: readonly ConversationRow[] | null | undefined,
): number | null {
  const rowsList = rows ?? [];
  for (let index = rowsList.length - 1; index >= 0; index -= 1) {
    const row = rowsList[index];
    if (!row || row.kind !== "turnHeader" || row.state !== "running") continue;
    return finiteOrNull(row.startedAt);
  }
  return null;
}

/**
 * 秒表已耗时（ms）= nowMs − startedAtMs（UI 本地真实时间差）。
 * 起点缺席 → null；时钟偏移导致负值 → 0（秒表不显示负数）。
 */
export function deriveElapsedMs(startedAtMs: number | null, nowMs: number): number | null {
  if (startedAtMs === null || !Number.isFinite(startedAtMs) || !Number.isFinite(nowMs)) {
    return null;
  }
  return Math.max(nowMs - startedAtMs, 0);
}
