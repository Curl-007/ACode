// attach 响应的 pending 交互提示清单：恒在可空，字段存在性做版本判代。
// spec: apps/acode-cli/specs/protocol-attachment-typed-errors.md R5（含证据出处与
// V4_WIRE_PROTOCOL_VERSION 关系）：wire 版本是连接级协商；本字段存在性是**响应级**判代
// 探针（relay 转发、web 客户端旧构建、混合窗口）。两者互补，禁止互相反推。
// 判代读法：缺席 = 老世代（≠ 无 pending）；null = 新世代不枚举；数组 = 确定清单。
import { z } from "zod";
import { timestampSchema } from "./core.js";
import { pendingInteractionKindSchema } from "./snapshot.js";

/** 轻量提示 = pendingInteraction 的引用子集；与 snapshot 的 pendingInteractions（权威）冲突时以后者为准。 */
export const pendingInteractionHintSchema = z
  .object({
    interactionId: z.string().min(1),
    kind: pendingInteractionKindSchema,
    toolCallId: z.string().min(1).optional(),
    toolName: z.string().optional(),
    createdAt: timestampSchema,
    anchorRowId: z.number().int().nonnegative().nullable().optional(),
  })
  .strict();
export type PendingInteractionHint = z.infer<typeof pendingInteractionHintSchema>;

/**
 * 字段 schema：`nullable().optional()` 是**偏斜安全**的形状约束（新客户端解析老 CLI 的
 * ack 不得失败），不是发出侧许可——发出侧纪律是新 CLI 起该字段恒在（可空）。
 */
export const pendingInteractionHintsSchema = z.array(pendingInteractionHintSchema).nullable();
export type PendingInteractionHints = z.infer<typeof pendingInteractionHintsSchema>;

/** 判代读法（唯一入口）：缺席 = 老世代（≠ 无 pending）；null = 新世代但不枚举；数组 = 确定清单。 */
export type PendingInteractionHintsReading =
  | { generation: "legacy" }
  | { generation: "current"; hints: PendingInteractionHints };

export function readPendingInteractionHints(response: {
  pendingInteractionHints?: PendingInteractionHints;
}): PendingInteractionHintsReading {
  if (!("pendingInteractionHints" in response) || response.pendingInteractionHints === undefined) {
    // 字段缺席只能推断「对端是老世代」；完整清单等 snapshot 的 pendingInteractions。
    return { generation: "legacy" };
  }
  return { generation: "current", hints: response.pendingInteractionHints };
}
