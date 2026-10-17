// 轮尾收尾卡解析（packages/ui/specs/turn-wrap-up-card.md）。
// 纯函数 view-model：与 resolveCronAutomationTurnCards / resolveOffPeakTurnCards 同一道缝，
// 由 ConversationTurnGroup 在 unit.isRunning === false 后经 useMemo 派生，无组件级状态。
// 载荷 schema 的单一事实源在 @acode/shared/acode-protocol-v4（turn-wrap-up.ts），UI 不复制字段表。
import {
  parseTurnWrapUpPayload,
  TURN_WRAP_UP_TOOL_NAME,
  type TurnWrapUpPayload,
} from "@acode/shared/acode-protocol-v4";
import type { AssistantWorkRow } from "@/v4/conversationTurnFlowItems.js";

export interface TurnWrapUpTurnCard {
  rowId: number;
  toolCallId: string;
  payload: TurnWrapUpPayload;
}

/**
 * 从本轮工作行里解析收尾卡：只看成功终态的 TurnWrapUp 工具行；多次成功调用取
 * **最后一条**（last-wins，CLI spec R4/R6）。载荷解析失败的行跳过——安全回落：
 * 该行仍按普通工具行渲染，卡片缺席不抛。
 */
export function resolveTurnWrapUpCard(
  rows: readonly AssistantWorkRow[],
): TurnWrapUpTurnCard | undefined {
  let card: TurnWrapUpTurnCard | undefined;
  for (const row of rows) {
    if (row.kind !== "toolCall" || row.status !== "success") continue;
    if (row.toolName !== TURN_WRAP_UP_TOOL_NAME) continue;
    const payload = parseTurnWrapUpPayload(row.input);
    if (!payload) continue;
    card = { rowId: row.rowId, toolCallId: row.toolCallId, payload };
  }
  return card;
}
