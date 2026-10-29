// M3 幸存三词的最小登记模块（spec apps/acode-cli/specs/m3-legacy-server-removal.md §0）。
//
// 裁决依据：三个 wire 字面量经 v4 无双链路等价物，删除即断生产（保守无能力损失默认，
// 产品可推翻）。schema/类型逐字从 legacy barrel 迁移，形状不变。
//
// 移除条件：
// - session/subagents：v4 新增 subagents 分页 query（协议扩展批次），或产品确认下线。
// - plugins/cancelOperation：中止注册表与协议代际解耦的 v4 面建模完成。
// - session/send（附件回退）：v4 附件上传/寄存命令面建模完成 + 双链路真实冒烟通过。
//
// 绝不为幸存面扩新能力：新增 wire 词一律进 v4，不进本模块。

import { z } from "zod";
import { acodeBrowserAmbientContextSchema } from "./acode-protocol-shared.js";
import { acodeAutomationBotDeliveryTargetSchema } from "./bots.js";
import { modelExecutionSchema } from "./model-execution.js";
import { modelSelectionSchema } from "./model-selection.js";

/** M3 幸存三词的 wire 字面量（唯一登记点）。 */
export const LEGACY_SURVIVOR_METHODS = {
  sessionSubagents: "session/subagents",
  sessionSend: "session/send",
  pluginsCancelOperation: "plugins/cancelOperation",
} as const;
export type LegacySurvivorMethod =
  (typeof LEGACY_SURVIVOR_METHODS)[keyof typeof LEGACY_SURVIVOR_METHODS];

const nonEmptyString = z.string().trim().min(1);
const jsonObjectSchema = z.record(z.string(), z.unknown());

const acodeSessionSubagentBaseSchema = z
  .object({
    childSessionId: nonEmptyString,
    agentId: nonEmptyString.optional(),
    toolCallId: nonEmptyString.optional(),
    subagentType: nonEmptyString,
    title: nonEmptyString,
    summary: z.string().optional(),
    startedAt: z.number().int().nonnegative().optional(),
    endedAt: z.number().int().nonnegative().optional(),
  })
  .strict();

export const acodeSessionRunningSubagentSchema = acodeSessionSubagentBaseSchema.extend({
  status: z.enum(["running", "waiting", "blocked"]),
});

export type ACodeSessionRunningSubagent = z.infer<typeof acodeSessionRunningSubagentSchema>;

export const acodeSessionEndedSubagentSchema = acodeSessionSubagentBaseSchema.extend({
  status: z.enum(["success", "failed", "cancelled", "lost"]),
});

export type ACodeSessionEndedSubagent = z.infer<typeof acodeSessionEndedSubagentSchema>;

export const acodeSessionSubagentsResultSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    childSessionIds: z.array(nonEmptyString),
    running: z.array(acodeSessionRunningSubagentSchema),
    ended: z
      .object({
        total: z.number().int().nonnegative(),
        items: z.array(acodeSessionEndedSubagentSchema),
        nextCursor: nonEmptyString.optional(),
      })
      .strict(),
  })
  .strict();

export type ACodeSessionSubagentsResult = z.infer<typeof acodeSessionSubagentsResultSchema>;

export const acodeSessionSubagentsParamsSchema = z
  .object({
    sessionId: nonEmptyString,
    endedCursor: nonEmptyString.optional(),
    endedLimit: z.number().int().positive().max(100).default(20),
  })
  .strict();

export type ACodeSessionSubagentsParams = z.infer<typeof acodeSessionSubagentsParamsSchema>;

export const acodeSessionSendParamsSchema = z
  .object({
    sessionId: nonEmptyString,
    modelSelection: modelSelectionSchema.optional(),
    modelExecution: modelExecutionSchema.optional(),
    inputId: nonEmptyString.optional(),
    queryId: nonEmptyString.optional(),
    content: z.string(),
    attachments: z.array(jsonObjectSchema).optional(),
    browserAmbientContext: acodeBrowserAmbientContextSchema.optional(),
    expectedRevision: z.number().int().nonnegative().optional(),
    expectedProviderRevision: nonEmptyString.optional(),
    automationId: nonEmptyString.optional(),
    offPeakTaskId: nonEmptyString.optional(),
    offPeakRunType: z.enum(["init", "resume"]).optional(),
    botDeliveryTarget: acodeAutomationBotDeliveryTargetSchema.optional(),
    toolDenylist: z.array(nonEmptyString).optional(),
  })
  .strict()
  .superRefine((payload, context) => {
    if (payload.automationId && payload.offPeakTaskId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "automationId and offPeakTaskId are mutually exclusive",
      });
    }
    if (payload.offPeakRunType && !payload.offPeakTaskId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "offPeakRunType requires offPeakTaskId",
        path: ["offPeakRunType"],
      });
    }
    if (payload.modelExecution && !payload.modelSelection) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "modelExecution requires modelSelection",
        path: ["modelExecution"],
      });
    }
  });

export const acodeSessionSendResultSchema = z
  .object({
    sessionId: nonEmptyString,
    accepted: z.literal(true),
    stateRevision: z.number().int().nonnegative(),
  })
  .strict();

export type ACodeSessionSendResult = z.infer<typeof acodeSessionSendResultSchema>;

export const acodePluginsCancelOperationParamsSchema = z
  .object({
    operationId: nonEmptyString,
  })
  .strict();

export type ACodePluginsCancelOperationParams = z.infer<
  typeof acodePluginsCancelOperationParamsSchema
>;

export const acodePluginsCancelOperationResultSchema = z
  .object({
    operationId: nonEmptyString,
    cancelled: z.boolean(),
  })
  .strict();

export type ACodePluginsCancelOperationResult = z.infer<
  typeof acodePluginsCancelOperationResultSchema
>;
