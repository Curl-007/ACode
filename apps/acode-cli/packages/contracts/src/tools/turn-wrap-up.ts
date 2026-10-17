// ============================================================
// TurnWrapUp Tool - 回合收尾载荷契约（apps/acode-cli/specs/turn-wrap-up.md）
// ============================================================
// producer 侧镜像：名字与上限的单一事实源在 shared v4（turn-wrap-up.ts），这里直接
// 引用常量；字段集因 zod 版本边界（contracts v3 / shared v4）必须镜像一份，
// 同步纪律与 toolDisplay ↔ tool-result-metadata 相同，parity 由测试钉住
// （apps/acode-cli/tests/turn-wrapup-contract.test.mjs 场景 8）。

import { z } from "zod";
import { TURN_WRAP_UP_LIMITS, TURN_WRAP_UP_TOOL_NAME } from "@acode/shared/acode-protocol-v4";
import { toToolJsonSchema } from "./json-schema.js";

export { TURN_WRAP_UP_LIMITS, TURN_WRAP_UP_TOOL_NAME };

/** 建议任务卡载荷 = new_task 判别载体（spec R8）：prompt 必须自包含（新任务可能没有本会话上下文）。 */
export const TurnWrapUpFollowUpSuggestionSchema = z
  .object({
    title: z.string().trim().min(1).max(TURN_WRAP_UP_LIMITS.followUpTitleMaxChars),
    tldr: z.string().trim().min(1).max(TURN_WRAP_UP_LIMITS.followUpTldrMaxChars),
    prompt: z.string().trim().min(1).max(TURN_WRAP_UP_LIMITS.followUpPromptMaxChars),
  })
  .strict();

export type TurnWrapUpFollowUpSuggestion = z.infer<typeof TurnWrapUpFollowUpSuggestionSchema>;

/**
 * 工具入参 = 收尾载荷本体。它同时是 v4 wire 载荷（toolCall row 的 input 通道，
 * 对所有客户端版本无 schema 透传——裁决见 spec §2.2），所以这里的字段集/上限
 * 与 shared 的 turnWrapUpPayloadSchema 必须逐字一致。
 *
 * 超限是拒绝而不是截断：收尾卡是给用户看的承诺，静默截断会伪造事实。
 */
export const TurnWrapUpInputSchema = z
  .object({
    recap: z.string().trim().min(1).max(TURN_WRAP_UP_LIMITS.recapMaxChars),
    nextStep: z.string().trim().min(1).max(TURN_WRAP_UP_LIMITS.nextStepMaxChars),
    followUpSuggestion: TurnWrapUpFollowUpSuggestionSchema.optional(),
  })
  .strict();

export type TurnWrapUpInput = z.infer<typeof TurnWrapUpInputSchema>;

export const TurnWrapUpInputJsonSchema = toToolJsonSchema(TurnWrapUpInputSchema);

/**
 * 工具输出：只有「已记录」一种成功结局。message 是模型面收口指令
 * （双面文本按模型面处理，恒英文，prompt-language-policy R3）。
 */
export const TurnWrapUpOutputSchema = z
  .object({
    status: z.literal("recorded"),
    message: z.string(),
  })
  .strict();

export type TurnWrapUpOutput = z.infer<typeof TurnWrapUpOutputSchema>;

export const TurnWrapUpOutputJsonSchema = toToolJsonSchema(TurnWrapUpOutputSchema);
