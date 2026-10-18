import type {
  ConversationRow,
  SessionUsageLastRequest,
  SessionUsageState,
  SubagentProjectionState,
  TurnHeaderStats,
} from "@acode/shared/acode-protocol-v4";
import type { TodayUsageTotals } from "@/v4/usage-statusbar/usageStatusbarTodayModel.js";

// hide-on-absent 判定（specs/usage-statusbar.md「hide-on-absent 空态规则」节）。
// 从 usageStatusbarModel 拆出的原因：该文件顶过 400 行 ratchet（architecture:check），
// 本块自成一个关注点（「缺席 ≠ 0」的胶囊级显隐单一所有者），纯移动、语义不变。
// 既有导入面经 usageStatusbarModel re-export 保持（测试 deep-import 不破）。
//
// 规则依据（原注释保留）：
// - 数据源 null/缺席 → 胶囊不渲染（snapshot=null 只留设置齿轮，绝不回退其他会话）；
// - 数据源在场而数值为 0 → 照常显示（零值是事实，不是缺席）。
// 用户显式开关（useUsageStatusbarPreferences）与此正交：显式关 = 永不显示；
// 显式开 = 有数据即显示、无数据仍隐藏。

/** 投影窗口内是否存在 toolCall 行（工具胶囊的缺席判据；零次调用 = 无行 = 缺席）。 */
export function hasToolCallRows(rows: readonly ConversationRow[] | null | undefined): boolean {
  return (rows ?? []).some((row) => row.kind === "toolCall");
}

export interface UsageStatusbarPresence {
  generationSpeed: boolean;
  turnUsage: boolean;
  sessionCumulative: boolean;
  toolCalls: boolean;
  todayTotal: boolean;
  subagents: boolean;
}

export function resolveUsageStatusbarPresence(inputs: {
  usage: SessionUsageState | null | undefined;
  lastRequest: SessionUsageLastRequest | null | undefined;
  lastTurnStats: TurnHeaderStats | null;
  hasToolCallRows: boolean;
  todayTotals: TodayUsageTotals | null | undefined;
  subagents: SubagentProjectionState | null | undefined;
}): UsageStatusbarPresence {
  const running = inputs.subagents?.running ?? [];
  const endedTotal = Number.isFinite(inputs.subagents?.endedTotal)
    ? (inputs.subagents?.endedTotal ?? 0)
    : 0;
  return {
    // lastRequest 在场即显示（即使 generationMs 非法 → tok/s 为 "—"，请求事实仍是真）。
    generationSpeed: inputs.lastRequest != null,
    turnUsage: inputs.lastTurnStats != null,
    // usage 对象在场 = 快照绑定纪律成立；token 全 0 照常显示。
    sessionCumulative: inputs.usage != null,
    toolCalls: inputs.hasToolCallRows,
    // 当天 heatmap 单元格命中（可能全 0）= 在场；未命中 = 无数据。
    todayTotal: inputs.todayTotals != null,
    // 空投影（无 running 且无已结束）不携带任何事实，不渲染空壳胶囊。
    subagents: inputs.subagents != null && (running.length > 0 || endedTotal > 0),
  };
}
