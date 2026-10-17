// 回合收尾载荷（apps/acode-cli/specs/turn-wrap-up.md R1/R5）。
//
// 承载通道 = toolCall row 的 `input` 字段（`z.unknown()` 对所有客户端版本无 schema 透传；
// 裁决与实证见 spec §2.2）。本文件**刻意不加** row kind、delta op 或 display 成员：
// 未知 row kind 会让旧客户端整帧校验失败（wire-fault 的确定性内容故障 → 订阅 contentRejected），
// 而 input 通道对旧客户端逐字节可解析——「旧客户端安全忽略」由承载通道本身保证，
// 并以验收场景 5 的负向断言钉住（conversationRowSchema 的 kind 闭集不得出现 wrap-up 成员）。
//
// 名字与上限是单一事实源：contracts 的 producer 镜像（zod v3）引用这里的常量；
// 两份 schema 的字段集一致性由 parity 测试钉住（zod 版本边界，同 toolDisplay ↔
// tool-result-metadata 的同步纪律）。
import { z } from "zod";

/** 收尾工具名。producer（contracts/core）与 consumer（UI/TUI/测试）共用这一个常量。 */
export const TURN_WRAP_UP_TOOL_NAME = "TurnWrapUp";

/**
 * 载荷上限（字符数，trim 后计）。超限是**拒绝**而不是截断：收尾卡是给用户看的承诺，
 * 静默截断会伪造事实；模型面错误文本负责把上限告诉模型。
 */
export const TURN_WRAP_UP_LIMITS = {
  recapMaxChars: 600,
  nextStepMaxChars: 300,
  followUpTitleMaxChars: 120,
  followUpTldrMaxChars: 280,
  followUpPromptMaxChars: 4_000,
} as const;

/**
 * 建议任务卡载荷 = new_task 判别的载体（spec R8）：只有当后续自成一体、
 * 新任务仅凭 prompt 就能出发（可能没有本会话上下文）时才在场。
 */
export const turnWrapUpFollowUpSuggestionSchema = z
  .object({
    title: z.string().trim().min(1).max(TURN_WRAP_UP_LIMITS.followUpTitleMaxChars),
    tldr: z.string().trim().min(1).max(TURN_WRAP_UP_LIMITS.followUpTldrMaxChars),
    prompt: z.string().trim().min(1).max(TURN_WRAP_UP_LIMITS.followUpPromptMaxChars),
  })
  .strict();
export type TurnWrapUpFollowUpSuggestion = z.infer<typeof turnWrapUpFollowUpSuggestionSchema>;

/** 回合收尾载荷：recap（两三句回顾）+ nextStep（下一步）+ 可选建议任务卡。 */
export const turnWrapUpPayloadSchema = z
  .object({
    recap: z.string().trim().min(1).max(TURN_WRAP_UP_LIMITS.recapMaxChars),
    nextStep: z.string().trim().min(1).max(TURN_WRAP_UP_LIMITS.nextStepMaxChars),
    followUpSuggestion: turnWrapUpFollowUpSuggestionSchema.optional(),
  })
  .strict();
export type TurnWrapUpPayload = z.infer<typeof turnWrapUpPayloadSchema>;

/** 客户端解析入口：失败回 undefined（安全回落，绝不抛）。 */
export function parseTurnWrapUpPayload(input: unknown): TurnWrapUpPayload | undefined {
  const parsed = turnWrapUpPayloadSchema.safeParse(input);
  return parsed.success ? parsed.data : undefined;
}

export function isTurnWrapUpToolName(value: string | undefined): boolean {
  return value === TURN_WRAP_UP_TOOL_NAME;
}
