// 舰队目录行的事实解析（specs/subagent-fleet-panel.md R1）：纯函数叶子，
// tokens「缺席不假零」与 elapsed 门控（now 只属于运行中行）的唯一裁决点。
import type { ACodeSessionEndedSubagent } from "@acode/shared";
import type { RunningSubagentSummary } from "@acode/shared/acode-protocol-v4";

export type SubagentDirectoryItem = RunningSubagentSummary | ACodeSessionEndedSubagent;

export interface SubagentRowFacts {
  /** 累计 tokens；字段缺席（旧投影/ended 项）→ undefined（UI 隐藏列，不显示假零）。 */
  cumulativeTokens?: number;
  /** 运行时长 ms；仅 now 传入（运行中行）且 startedAt 在场时存在。 */
  elapsedMs?: number;
}

export function resolveSubagentRowFacts(
  item: SubagentDirectoryItem,
  now: number | undefined,
): SubagentRowFacts {
  const cumulativeTokens =
    "cumulativeTokens" in item && typeof item.cumulativeTokens === "number"
      ? item.cumulativeTokens
      : undefined;
  const elapsedMs =
    now !== undefined && item.startedAt !== undefined
      ? Math.max(0, now - item.startedAt)
      : undefined;
  return {
    ...(cumulativeTokens !== undefined ? { cumulativeTokens } : {}),
    ...(elapsedMs !== undefined ? { elapsedMs } : {}),
  };
}
