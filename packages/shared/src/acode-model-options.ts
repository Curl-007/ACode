// session 模型选项 / 上下文预算策略 / runtime preferences 词汇。M4 从 legacy barrel 中立迁移，形状不变。

import { z } from "zod";
import { completeModelPropertiesDataSchema } from "./model-config.js";
import { integratedTerminalShellSelectionSchema } from "./validationAppSettings.js";
import { modelSelectionSchema } from "./model-selection.js";

const nonEmptyString = z.string().trim().min(1);

export const acodeThoughtLevelOptionSchema = z
  .object({
    value: nonEmptyString,
    label: nonEmptyString,
    description: z.string().optional(),
  })
  .strict();

export const acodeModelReasoningOptionsSchema = z
  .object({
    levels: z.array(acodeThoughtLevelOptionSchema),
    defaultLevel: nonEmptyString.optional(),
  })
  .strict();

export type ACodeModelReasoningOptions = z.infer<typeof acodeModelReasoningOptionsSchema>;

export const acodeModelFormatPropertiesSchema = completeModelPropertiesDataSchema.pick({
  inputFormat: true,
  outputFormat: true,
});

export type ACodeModelFormatProperties = z.infer<typeof acodeModelFormatPropertiesSchema>;

export const acodeModelOptionSchema = z
  .object({
    ref: modelSelectionSchema,
    label: nonEmptyString,
    providerLabel: nonEmptyString.optional(),
    description: z.string().optional(),
    contextWindow: z.number().int().positive().optional(),
    maxOutputTokens: z.number().int().positive().optional(),
    reasoning: acodeModelReasoningOptionsSchema.optional(),
    properties: acodeModelFormatPropertiesSchema,
    disabledReason: z.string().optional(),
  })
  .strict();

export type ACodeModelOption = z.infer<typeof acodeModelOptionSchema>;

export const acodeSessionRuntimePreferencesScopeSchema = z.enum([
  "runtime-materialization",
  "user-execution",
]);

export type ACodeSessionRuntimePreferencesScope = z.infer<
  typeof acodeSessionRuntimePreferencesScopeSchema
>;

export const ACODE_SESSION_RUNTIME_PREFERENCES_REQUEST_TIMEOUT_MS = 15_000;

export const acodeSessionRequestRuntimePreferencesParamsSchema = z
  .object({
    sessionId: nonEmptyString,
    scope: acodeSessionRuntimePreferencesScopeSchema,
  })
  .strict();

export type ACodeSessionRequestRuntimePreferencesParams = z.infer<
  typeof acodeSessionRequestRuntimePreferencesParamsSchema
>;

export const DEFAULT_ACODE_MODEL_CONTEXT_BUDGET_STRATEGY = "preflight-v1" as const;

export const acodeModelContextBudgetStrategySchema = z.enum(["legacy", "preflight-v1"]);

export type ACodeModelContextBudgetStrategy = z.infer<typeof acodeModelContextBudgetStrategySchema>;

export const acodeSessionRuntimePreferencesResultSchema = z
  .object({
    nativeSearchEnhancementsEnabled: z.boolean(),
    memoryEnabled: z.boolean().default(false),
    askUserQuestionAutoResolutionEnabled: z.boolean().default(true),
    integratedTerminalShell: integratedTerminalShellSelectionSchema.optional(),
    // 兼容旧 Host：缺少字段时在协议解析边界使用当前默认策略。
    modelContextBudgetStrategy: acodeModelContextBudgetStrategySchema.default(
      DEFAULT_ACODE_MODEL_CONTEXT_BUDGET_STRATEGY,
    ),
  })
  .strict();

export type ACodeSessionRuntimePreferencesResult = z.infer<
  typeof acodeSessionRuntimePreferencesResultSchema
>;
