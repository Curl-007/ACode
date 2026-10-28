// 2026-12-31 例外债务偿还：自 model-config.ts 按职责拆出 —— Model 嵌套配置聚合族
// （ModelPropertiesConfig 与 ModelOptionSpecsConfig：ModelConfig 的两棵子树及档位归一化 helper）。
// 逐字迁移，行为零改动；Option Spec/格式类见 model-option-specs.ts，
// ModelConfig 与规则族见 model-config-rules.ts。
import { ConfigOverlay, type ConfigValidationIssue } from "../config-overlay.js";
import type { z } from "zod";
import {
  completeModelPropertiesDataSchema,
  completeModelOptionSpecsDataSchema,
  type modelPropertiesDataSchema,
  type modelOptionSpecsDataSchema,
} from "@acode/shared/model-config";
import { validateConfigSchema } from "./schema-validation.js";
import {
  EnumOptionSpecConfig,
  LimitOptionSpecConfig,
  ModelInputFormatConfig,
  ModelOutputFormatConfig,
  SpeedOptionSpecConfig,
  type EnumOptionSpecConfigInput,
  type LimitOptionSpecConfigInput,
  type SpeedOptionSpecConfigInput,
} from "./model-option-specs.js";

export type ModelPropertiesConfigInput = Readonly<z.infer<typeof modelPropertiesDataSchema>>;

export class ModelPropertiesConfig extends ConfigOverlay<ModelPropertiesConfig> {
  readonly requiresMfjsToolSchema?: ModelPropertiesConfigInput["requiresMfjsToolSchema"];
  readonly contextWindow?: ModelPropertiesConfigInput["contextWindow"];
  readonly inputFormat?: ModelInputFormatConfig | null;
  readonly outputFormat?: ModelOutputFormatConfig | null;
  readonly supportsToolCall?: ModelPropertiesConfigInput["supportsToolCall"];
  readonly supportsJsonSchemaOutput?: ModelPropertiesConfigInput["supportsJsonSchemaOutput"];
  readonly supportsNativeWebSearch?: ModelPropertiesConfigInput["supportsNativeWebSearch"];
  readonly supportsMidConversationSystem?: ModelPropertiesConfigInput["supportsMidConversationSystem"];

  constructor(input: ModelPropertiesConfigInput = {}) {
    super();
    Object.assign(this, {
      ...input,
      inputFormat:
        input.inputFormat instanceof ModelInputFormatConfig || input.inputFormat == null
          ? input.inputFormat
          : new ModelInputFormatConfig(input.inputFormat),
      outputFormat:
        input.outputFormat instanceof ModelOutputFormatConfig || input.outputFormat == null
          ? input.outputFormat
          : new ModelOutputFormatConfig(input.outputFormat),
    });
    Object.freeze(this);
  }

  overlay(next: ModelPropertiesConfig): ModelPropertiesConfig {
    return new ModelPropertiesConfig({
      requiresMfjsToolSchema: this.overlayValue(
        this.requiresMfjsToolSchema,
        next.requiresMfjsToolSchema,
      ),
      contextWindow: this.overlayValue(this.contextWindow, next.contextWindow),
      inputFormat: this.overlayConfig(this.inputFormat, next.inputFormat),
      outputFormat: this.overlayConfig(this.outputFormat, next.outputFormat),
      supportsToolCall: this.overlayValue(this.supportsToolCall, next.supportsToolCall),
      supportsJsonSchemaOutput: this.overlayValue(
        this.supportsJsonSchemaOutput,
        next.supportsJsonSchemaOutput,
      ),
      supportsNativeWebSearch: this.overlayValue(
        this.supportsNativeWebSearch,
        next.supportsNativeWebSearch,
      ),
      supportsMidConversationSystem: this.overlayValue(
        this.supportsMidConversationSystem,
        next.supportsMidConversationSystem,
      ),
    });
  }

  validateComplete(path: readonly string[] = []): readonly ConfigValidationIssue[] {
    return validateConfigSchema(completeModelPropertiesDataSchema, this.toJSON(), path);
  }

  toJSON(): ModelPropertiesConfigInput {
    return objectWithoutUndefined({
      requiresMfjsToolSchema: this.requiresMfjsToolSchema,
      contextWindow: this.contextWindow,
      inputFormat: this.inputFormat?.toJSON() ?? this.inputFormat,
      outputFormat: this.outputFormat?.toJSON() ?? this.outputFormat,
      supportsToolCall: this.supportsToolCall,
      supportsJsonSchemaOutput: this.supportsJsonSchemaOutput,
      supportsNativeWebSearch: this.supportsNativeWebSearch,
      supportsMidConversationSystem: this.supportsMidConversationSystem,
    });
  }
}

export type ModelOptionSpecsConfigInput = Readonly<z.infer<typeof modelOptionSpecsDataSchema>>;

export class ModelOptionSpecsConfig extends ConfigOverlay<ModelOptionSpecsConfig> {
  readonly reasoningLevel?: EnumOptionSpecConfig | null;
  readonly maxOutputTokens?: LimitOptionSpecConfig | null;
  readonly speed?: SpeedOptionSpecConfig | null;

  constructor(input: ModelOptionSpecsConfigInput = {}) {
    super();
    this.reasoningLevel = toEnumOptionSpecConfig(input.reasoningLevel);
    this.maxOutputTokens = toLimitOptionSpecConfig(input.maxOutputTokens);
    this.speed = toSpeedOptionSpecConfig(input.speed);
    Object.freeze(this);
  }

  overlay(next: ModelOptionSpecsConfig): ModelOptionSpecsConfig {
    return new ModelOptionSpecsConfig({
      reasoningLevel: this.overlayConfig(this.reasoningLevel, next.reasoningLevel),
      maxOutputTokens: this.overlayConfig(this.maxOutputTokens, next.maxOutputTokens),
      speed: this.overlayConfig(this.speed, next.speed),
    });
  }

  validateComplete(path: readonly string[] = []): readonly ConfigValidationIssue[] {
    return validateConfigSchema(completeModelOptionSpecsDataSchema, this.toJSON(), path, true);
  }

  toJSON(): ModelOptionSpecsConfigInput {
    return objectWithoutUndefined({
      reasoningLevel: this.reasoningLevel?.toJSON() ?? this.reasoningLevel,
      maxOutputTokens: this.maxOutputTokens?.toJSON() ?? this.maxOutputTokens,
      speed: this.speed?.toJSON() ?? this.speed,
    });
  }
}

function toEnumOptionSpecConfig(
  spec: EnumOptionSpecConfig | EnumOptionSpecConfigInput | null | undefined,
): EnumOptionSpecConfig | null | undefined {
  return spec instanceof EnumOptionSpecConfig || spec == null
    ? spec
    : new EnumOptionSpecConfig(spec);
}

function toLimitOptionSpecConfig(
  spec: LimitOptionSpecConfig | LimitOptionSpecConfigInput | null | undefined,
): LimitOptionSpecConfig | null | undefined {
  return spec instanceof LimitOptionSpecConfig || spec == null
    ? spec
    : new LimitOptionSpecConfig(spec);
}

function toSpeedOptionSpecConfig(
  spec: SpeedOptionSpecConfig | SpeedOptionSpecConfigInput | null | undefined,
): SpeedOptionSpecConfig | null | undefined {
  return spec instanceof SpeedOptionSpecConfig || spec == null
    ? spec
    : new SpeedOptionSpecConfig(spec);
}

function objectWithoutUndefined<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, fieldValue]) => fieldValue !== undefined),
  ) as T;
}
