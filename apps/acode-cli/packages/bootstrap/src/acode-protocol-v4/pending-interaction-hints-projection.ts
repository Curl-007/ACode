// attach 响应 pending 交互提示清单的发出侧投影（specs/protocol-attachment-typed-errors.md R5 / 接线 W4）。
// 单一职责：把会话投影 snapshot 的 pendingInteractions（权威、恒在数组）折算成 ack 上的
// 轻量 hint 引用清单。发出侧纪律：新 CLI 起 subscribe ack 恒在携带本字段（可空）；
// 客户端读法唯一入口是 shared 的 readPendingInteractionHints（字段存在性判代）。
import type { PendingInteraction, PendingInteractionHint } from "@acode/shared/acode-protocol-v4";

/**
 * snapshot → hints 的唯一映射点。hint 只携带引用子集（interactionId/kind/toolCallId?/
 * toolName?/createdAt/anchorRowId），不是 payload 副本；与 snapshot pendingInteractions
 * 冲突时以 snapshot 为准（spec R5 规则 4）。
 *
 * - toolCallId/toolName 只对 permission kind 存在（payload 判别联合的 permission 分支）；
 *   其余 kind 省略键而非填 null，保持 hint 轻量。
 * - anchorRowId 防御性收窄：hint schema 要求 int 且非负，snapshot 侧是 nullable number
 *   （null = 会话级）。null/畸形值一律省略键——畸形 hint 会让客户端整条 subscribe ack
 *   解析失败，宁可少一个可选引用字段。
 */
export function pendingInteractionHintsForSnapshot(
  interactions: readonly PendingInteraction[],
): PendingInteractionHint[] {
  return interactions.map((interaction) => ({
    interactionId: interaction.interactionId,
    kind: interaction.kind,
    ...(interaction.payload.kind === "permission"
      ? { toolCallId: interaction.payload.toolCallId, toolName: interaction.payload.toolName }
      : {}),
    createdAt: interaction.createdAt,
    ...(isHintAnchorRowId(interaction.anchorRowId) ? { anchorRowId: interaction.anchorRowId } : {}),
  }));
}

function isHintAnchorRowId(value: number | null): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
