// 2026-12-31 例外债务偿还：自 model-config.ts 按职责拆出 —— Option Spec 与输入/输出格式配置族
// （Enum/Speed/Limit 档位 Overlay 与 Model Input/Output Format Overlay）。
// 逐字迁移，行为零改动；Properties/OptionSpecs 聚合见 model-properties-config.ts，
// ModelConfig 与规则族见 model-config-rules.ts。
import { ConfigOverlay, type ConfigValidationIssue } from "../config-overlay.js";
import type { z } from "zod";
import {
  completeEnumOptionSpecDataSchema,
  completeSpeedOptionSpecDataSchema,
  completeLimitOptionSpecDataSchema,
  completeModelInputFormatDataSchema,
  completeModelOutputFormatDataSchema,
  type enumOptionSpecDataSchema,
  type speedOptionSpecDataSchema,
  type limitOptionSpecDataSchema,
  type modelInputFormatDataSchema,
  type modelOutputFormatDataSchema,
} from "@acode/shared/model-config";
import { validateConfigSchema } from "./schema-validation.js";

export type EnumOptionSpec = Readonly<z.infer<typeof completeEnumOptionSpecDataSchema>>;

export type LimitOptionSpec = Readonly<z.infer<typeof completeLimitOptionSpecDataSchema>>;

export type EnumOptionSpecConfigInput = Readonly<z.infer<typeof enumOptionSpecDataSchema>>;

export class EnumOptionSpecConfig extends ConfigOverlay<EnumOptionSpecConfig> {
  readonly values?: EnumOptionSpecConfigInput["values"];
  readonly map?: EnumOptionSpecConfigInput["map"];

  constructor(input: EnumOptionSpecConfigInput = {}) {
    super();
    this.values =
      input.values === undefined
        ? undefined
        : input.values === null
          ? null
          : Object.freeze([...input.values]);
    this.map = input.map;
    Object.freeze(this);
  }

  overlay(next: EnumOptionSpecConfig): EnumOptionSpecConfig {
    return new EnumOptionSpecConfig({
      values: this.overlayValue(this.values, next.values),
      map: this.overlayValue(this.map, next.map),
    });
  }

  validateComplete(path: readonly string[] = []): readonly ConfigValidationIssue[] {
    return validateConfigSchema(completeEnumOptionSpecDataSchema, this.toJSON(), path, true);
  }

  toJSON(): EnumOptionSpecConfigInput {
    return objectWithoutUndefined({
      values: this.values,
      map: this.map,
    });
  }
}

export type SpeedOptionSpecConfigInput = Readonly<z.infer<typeof speedOptionSpecDataSchema>>;

export class SpeedOptionSpecConfig extends ConfigOverlay<SpeedOptionSpecConfig> {
  readonly values?: SpeedOptionSpecConfigInput["values"];
  readonly map?: SpeedOptionSpecConfigInput["map"];

  constructor(input: SpeedOptionSpecConfigInput = {}) {
    super();
    this.values =
      input.values === undefined
        ? undefined
        : input.values === null
          ? null
          : Object.freeze([...input.values]);
    this.map = input.map;
    Object.freeze(this);
  }

  overlay(next: SpeedOptionSpecConfig): SpeedOptionSpecConfig {
    return new SpeedOptionSpecConfig({
      values: this.overlayValue(this.values, next.values),
      map: this.overlayValue(this.map, next.map),
    });
  }

  validateComplete(path: readonly string[] = []): readonly ConfigValidationIssue[] {
    return validateConfigSchema(completeSpeedOptionSpecDataSchema, this.toJSON(), path, true);
  }

  toJSON(): SpeedOptionSpecConfigInput {
    return objectWithoutUndefined({ values: this.values, map: this.map });
  }
}

export type LimitOptionSpecConfigInput = Readonly<z.infer<typeof limitOptionSpecDataSchema>>;

export class LimitOptionSpecConfig extends ConfigOverlay<LimitOptionSpecConfig> {
  readonly max?: LimitOptionSpecConfigInput["max"];
  readonly map?: LimitOptionSpecConfigInput["map"];

  constructor(input: LimitOptionSpecConfigInput = {}) {
    super();
    Object.assign(this, input);
    Object.freeze(this);
  }

  overlay(next: LimitOptionSpecConfig): LimitOptionSpecConfig {
    return new LimitOptionSpecConfig({
      max: this.overlayValue(this.max, next.max),
      map: this.overlayValue(this.map, next.map),
    });
  }

  validateComplete(path: readonly string[] = []): readonly ConfigValidationIssue[] {
    return validateConfigSchema(completeLimitOptionSpecDataSchema, this.toJSON(), path, true);
  }

  toJSON(): LimitOptionSpecConfigInput {
    return objectWithoutUndefined({
      max: this.max,
      map: this.map,
    });
  }
}

export type ModelInputFormatConfigInput = Readonly<z.infer<typeof modelInputFormatDataSchema>>;

export class ModelInputFormatConfig extends ConfigOverlay<ModelInputFormatConfig> {
  readonly supportsText?: ModelInputFormatConfigInput["supportsText"];
  readonly supportsImage?: ModelInputFormatConfigInput["supportsImage"];
  readonly supportsVideo?: ModelInputFormatConfigInput["supportsVideo"];
  readonly supportsAudio?: ModelInputFormatConfigInput["supportsAudio"];
  readonly supportsPdf?: ModelInputFormatConfigInput["supportsPdf"];

  constructor(input: ModelInputFormatConfigInput = {}) {
    super();
    Object.assign(this, input);
    Object.freeze(this);
  }

  overlay(next: ModelInputFormatConfig): ModelInputFormatConfig {
    return new ModelInputFormatConfig({
      supportsText: this.overlayValue(this.supportsText, next.supportsText),
      supportsImage: this.overlayValue(this.supportsImage, next.supportsImage),
      supportsVideo: this.overlayValue(this.supportsVideo, next.supportsVideo),
      supportsAudio: this.overlayValue(this.supportsAudio, next.supportsAudio),
      supportsPdf: this.overlayValue(this.supportsPdf, next.supportsPdf),
    });
  }

  validateComplete(path: readonly string[] = []): readonly ConfigValidationIssue[] {
    return validateConfigSchema(completeModelInputFormatDataSchema, this.toJSON(), path);
  }

  toJSON(): ModelInputFormatConfigInput {
    return objectWithoutUndefined({
      supportsText: this.supportsText,
      supportsImage: this.supportsImage,
      supportsVideo: this.supportsVideo,
      supportsAudio: this.supportsAudio,
      supportsPdf: this.supportsPdf,
    });
  }
}

export type ModelOutputFormatConfigInput = Readonly<z.infer<typeof modelOutputFormatDataSchema>>;

export class ModelOutputFormatConfig extends ConfigOverlay<ModelOutputFormatConfig> {
  readonly supportsText?: ModelOutputFormatConfigInput["supportsText"];

  constructor(input: ModelOutputFormatConfigInput = {}) {
    super();
    Object.assign(this, input);
    Object.freeze(this);
  }

  overlay(next: ModelOutputFormatConfig): ModelOutputFormatConfig {
    return new ModelOutputFormatConfig({
      supportsText: this.overlayValue(this.supportsText, next.supportsText),
    });
  }

  validateComplete(path: readonly string[] = []): readonly ConfigValidationIssue[] {
    return validateConfigSchema(completeModelOutputFormatDataSchema, this.toJSON(), path);
  }

  toJSON(): ModelOutputFormatConfigInput {
    return objectWithoutUndefined({ supportsText: this.supportsText });
  }
}

function objectWithoutUndefined<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, fieldValue]) => fieldValue !== undefined),
  ) as T;
}
