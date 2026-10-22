import { z } from "zod";
import { compileModelOptionMap } from "@acode/model-option-map";
import { sparseShape } from "./config-schema.js";

function optionMapSchema(variableName: "reasoningLevel" | "maxOutputTokens" | "speed") {
  return z
    .string()
    .min(1)
    .superRefine((source, context) => {
      try {
        compileModelOptionMap(source, variableName);
      } catch (error) {
        context.addIssue({
          code: "custom",
          message: error instanceof Error ? error.message : "Option map 无法编译",
        });
      }
    });
}

export const completeEnumOptionSpecDataSchema = z
  .object({
    /** 按语义强度从低到高排列；首项是辅助调用可选的最低公开档位。 */
    values: z
      .array(
        z
          .string()
          .refine((value) => value.trim().length > 0, "reasoningLevel.values 必须是非空字符串"),
      )
      .min(1, "reasoningLevel.values 不能为空")
      .refine((values) => new Set(values).size === values.length, "reasoningLevel.values 不能重复")
      .readonly(),
    map: optionMapSchema("reasoningLevel"),
  })
  .strict();

export const completeLimitOptionSpecDataSchema = z
  .object({
    max: z.number().int().positive(),
    map: optionMapSchema("maxOutputTokens"),
  })
  .strict();

export const completeSpeedOptionSpecDataSchema = completeEnumOptionSpecDataSchema.extend({
  map: optionMapSchema("speed"),
});

export const enumOptionSpecDataSchema = z
  .object(sparseShape(completeEnumOptionSpecDataSchema.shape))
  .strict();
export const speedOptionSpecDataSchema = z
  .object(sparseShape(completeSpeedOptionSpecDataSchema.shape))
  .strict();
export const limitOptionSpecDataSchema = z
  .object(sparseShape(completeLimitOptionSpecDataSchema.shape))
  .strict();

export const completeModelInputFormatDataSchema = z
  .object({
    supportsText: z.boolean(),
    supportsImage: z.boolean(),
    supportsVideo: z.boolean(),
    supportsAudio: z.boolean(),
    supportsPdf: z.boolean(),
  })
  .strict();
export const completeModelOutputFormatDataSchema = z.object({ supportsText: z.boolean() }).strict();
export const modelInputFormatDataSchema = z
  .object(sparseShape(completeModelInputFormatDataSchema.shape))
  .strict();
export const modelOutputFormatDataSchema = z
  .object(sparseShape(completeModelOutputFormatDataSchema.shape))
  .strict();

export const completeModelPropertiesDataSchema = z
  .object({
    requiresMfjsToolSchema: z.boolean(),
    contextWindow: z.number().int().positive(),
    inputFormat: completeModelInputFormatDataSchema,
    outputFormat: completeModelOutputFormatDataSchema,
    supportsToolCall: z.boolean(),
    supportsJsonSchemaOutput: z.boolean(),
    supportsNativeWebSearch: z.boolean(),
    supportsMidConversationSystem: z.boolean(),
  })
  .strict();
export const modelPropertiesDataSchema = z
  .object({
    ...sparseShape(completeModelPropertiesDataSchema.shape),
    inputFormat: modelInputFormatDataSchema.nullable().optional(),
    outputFormat: modelOutputFormatDataSchema.nullable().optional(),
  })
  .strict();

export const completeModelOptionSpecsDataSchema = z
  .object({
    reasoningLevel: completeEnumOptionSpecDataSchema,
    maxOutputTokens: completeLimitOptionSpecDataSchema,
    // 迁移期允许旧远端配置缺失；当前内置基线会为所有模型补齐。
    speed: completeSpeedOptionSpecDataSchema.optional(),
  })
  .strict();
export const modelOptionSpecsDataSchema = z
  .object({
    ...sparseShape(completeModelOptionSpecsDataSchema.shape),
    reasoningLevel: enumOptionSpecDataSchema.nullable().optional(),
    maxOutputTokens: limitOptionSpecDataSchema.nullable().optional(),
    speed: speedOptionSpecDataSchema.nullable().optional(),
  })
  .strict();

// ============================================================
// Model compat 标志族（omp 价值提取波 2 · WI-12）
// ============================================================
// spec: apps/acode-cli/specs/model-compat-flags.md。用 TS 表承载 omp KDL 行为差异表的
// 语义：per-model 请求结构/语义修补只准消费这里的结构化标志，业务代码禁止按模型 id
// 字符串/正则分支。字段族天然稀疏（全部可选，缺省 = 通用行为 = 零变换），因此没有
// "complete" 面对照；strict 拒绝未知标志——词汇表即 schema，规则表 typo 加载即炸。
// nullable 与既有 sparse 家族一致，为配置 overlay 的 null 清除语义预留。
//
// 与 model-option-map 的边界：option-map（CEL patch）管请求体字段值映射
// （thinking/reasoning*/enable_thinking/max_*）；compat 标志管结构/语义修补
// （tool-call id 重写、tool 消息 name 回填、system 消息形状/合并）。两套机制不许互相绕。
export const modelCompatFlagsDataSchema = z
  .object({
    /**
     * tool-call id 的 wire 档案。"openai-40" = id 必须满足 ^[A-Za-z0-9_-]{1,40}$，
     * 违规 id 在请求体内一致性重写（assistant tool_calls[].id / tool.tool_call_id /
     * Responses call_id 同一映射）。omp 对应 uses-openai-tool-call-id-limit。
     */
    toolCallIdProfile: z.enum(["openai-40"]).nullable().optional(),
    /**
     * chat wire 的 tool-role 消息必须携带 name（从配对 assistant tool_call 回填）。
     * AI SDK openai-compatible 序列化 tool 消息不发 name；Moonshot 系（kimi-k3）要求。
     * omp 对应 requires-tool-result-name。
     */
    requiresToolResultName: z.boolean().nullable().optional(),
    /**
     * 端点只接受一个开头 system：多段开头 system 按原顺序合并为一条。
     * omp 对应 supports-multiple-system-messages=false。
     */
    singleLeadingSystem: z.boolean().nullable().optional(),
    /**
     * messages[] 内 system 的 content 必须是纯字符串：单 text block 数组还原为 string。
     * 部分 Anthropic-compatible 服务拒绝 block 数组形状的 mid-conversation system。
     */
    requiresStringSystemContent: z.boolean().nullable().optional(),
  })
  .strict();

/** 稀疏 compat 标志（null 与缺省同义：通用行为）。 */
export type ModelCompatFlagsData = z.infer<typeof modelCompatFlagsDataSchema>;

/** 解析后的 compat 档案：只含已启用标志，缺省字段一律不参与判断。 */
export type ResolvedModelCompatData = Readonly<Partial<ModelCompatFlagsData>>;

export const completeModelConfigDataSchema = z
  .object({
    enabled: z.boolean(),
    properties: completeModelPropertiesDataSchema,
    optionSpecs: completeModelOptionSpecsDataSchema,
  })
  .strict();
export const modelConfigDataSchema = z
  .object({
    ...sparseShape(completeModelConfigDataSchema.shape),
    properties: modelPropertiesDataSchema.nullable().optional(),
    optionSpecs: modelOptionSpecsDataSchema.nullable().optional(),
  })
  .strict();

// 跨层只共享数据合同；Provider 行为类与 IO 不进入公共 Schema。
export type ModelInputFormatData = z.infer<typeof completeModelInputFormatDataSchema>;
export type ModelOutputFormatData = z.infer<typeof completeModelOutputFormatDataSchema>;
export type ModelPropertiesData = z.infer<typeof completeModelPropertiesDataSchema>;
export type EnumOptionSpecData = z.infer<typeof completeEnumOptionSpecDataSchema>;
export type LimitOptionSpecData = z.infer<typeof completeLimitOptionSpecDataSchema>;
export type ModelOptionSpecsData = z.infer<typeof completeModelOptionSpecsDataSchema>;
