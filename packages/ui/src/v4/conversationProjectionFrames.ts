// conversationProjectionStore 的帧分类纯函数（目录失效裁决 + subagent 跃迁日志）。
//
// 从 conversationProjectionStore.ts 原样外迁：该文件已在 legacy ratchet 基线上
// （超限只减不增），U07 历史焦点需要腾出行数。语义零改动，只搬位置。
import type {
  ConversationSnapshot,
  ConversationTopicFrame,
  ToolCallRow,
} from "@acode/shared/acode-protocol-v4";
import { logger } from "@/logger.js";

export const TERMINAL_PLAN_STATUSES: ReadonlySet<ToolCallRow["status"]> = new Set([
  "success",
  "error",
  "cancelled",
]);

export function shouldInvalidatePlanDirectory(frame: ConversationTopicFrame): boolean {
  if (frame.payload.kind === "snapshot") return true;
  return frame.payload.deltas.some((delta) => {
    if (delta.op === "row.removed") return true;
    if (delta.op !== "row.appended" && delta.op !== "row.upserted") return false;
    const row = delta.row;
    return (
      row.kind === "toolCall" &&
      row.toolName === "ExitPlanMode" &&
      TERMINAL_PLAN_STATUSES.has(row.status)
    );
  });
}

/**
 * 问题导航目录是否需要失效。
 * not-enough-queries 终态曾只以 logEpoch 判定，导致同一 epoch
 * 内追加 real-user query 后永久命中缓存。判定条件：
 * - snapshot 整体替换 → true（全新状态，终态作废）；
 * - row.removed → true（rewind/分支裁剪改变可导航 query 集合）；
 * - row.appended/row.upserted 命中 realUser userInput → true（新增/变更用户问题）；
 * - 其余 delta（assistant text、tool、reasoning 流式）→ false，不触发重探测。
 */
export function shouldInvalidateTurnNavigatorDirectory(frame: ConversationTopicFrame): boolean {
  if (frame.payload.kind === "snapshot") return true;
  return frame.payload.deltas.some((delta) => {
    if (delta.op === "row.removed") return true;
    if (delta.op !== "row.appended" && delta.op !== "row.upserted") return false;
    const row = delta.row;
    return row.kind === "userInput" && row.origin === "realUser";
  });
}

/** 帧内最早的 row.removed 起点（rewind/edit 权威裁剪边界）；无则 null。 */
export function earliestRemovedFromRowId(frame: ConversationTopicFrame): number | null {
  if (frame.payload.kind === "snapshot") return null;
  return frame.payload.deltas.reduce<number | null>(
    (earliest, delta) =>
      delta.op === "row.removed"
        ? Math.min(earliest ?? delta.fromRowId, delta.fromRowId)
        : earliest,
    null,
  );
}

export function logSubagentProjectionTransition(
  topic: string,
  previous: ConversationSnapshot | null,
  next: ConversationSnapshot,
  delivery: "snapshot" | "deltas",
): void {
  const previousIds = previous?.subagents?.running.map((item) => item.childSessionId) ?? [];
  const nextIds = next.subagents?.running.map((item) => item.childSessionId) ?? [];
  if (
    previousIds.length === nextIds.length &&
    previousIds.every((childSessionId, index) => childSessionId === nextIds[index])
  ) {
    return;
  }
  // 交互 bug 的根因位于订阅快照交接，不在 React DOM；仅在 Agent 运行集变化时
  // 记录轻量身份与水位，使本地复现能区分合法终态和迟到快照覆盖。
  logger.info("[v4-store] running subagent projection changed", {
    delivery,
    nextBackgroundWorkIds: next.backgroundWorks
      .filter((work) => work.kind === "subagent" && work.status === "running")
      .map((work) => work.childSessionId ?? work.workId),
    nextIds,
    nextSeq: next.seq,
    previousIds,
    previousSeq: previous?.seq ?? null,
    topic,
  });
}
