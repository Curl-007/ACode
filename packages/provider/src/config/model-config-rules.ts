// 2026-12-31 例外债务偿还：自 model-config.ts 按职责拆出 —— ModelConfig 与有序规则族
// （ModelConfig Overlay、六类 ModelConfigRule 联合、ModelConfigRules 索引与匹配解析）。
// 逐字迁移，行为零改动；Option Spec/格式类见 model-option-specs.ts，
// Properties/OptionSpecs 聚合见 model-properties-config.ts。
import { ConfigOverlay, type ConfigValidationIssue } from "../config-overlay.js";
import type { z } from "zod";
import {
  completeModelConfigDataSchema,
  type modelConfigDataSchema,
} from "@acode/shared/model-config";
import { validateConfigSchema } from "./schema-validation.js";
import { clearManualModelConfig } from "./manual-model-config.js";
import {
  providerModelConfigRuleSchema,
  manualProviderModelConfigRuleSchema,
  personalModelConfigRulesSchema,
  builtinModelConfigRulesSchema,
  type ProviderModelConfigRuleData,
  type ManualProviderModelConfigRuleData,
  type TemplateModelConfigRuleData,
  type ModelMatchConfigRuleData,
  type ModelApiMatchConfigRuleData,
  type ProviderSiteMatchConfigRuleData,
  type BuiltinModelConfigRulesData,
  type PersonalModelConfigRulesData,
} from "./rule-data-schema.js";
import { ModelOptionSpecsConfig, ModelPropertiesConfig } from "./model-properties-config.js";

export type ModelConfigInput = Omit<ModelConfigObject, "properties" | "optionSpecs"> & {
  readonly properties?: ModelPropertiesConfig | null;
  readonly optionSpecs?: ModelOptionSpecsConfig | null;
};

export type ModelConfigObject = Readonly<z.infer<typeof modelConfigDataSchema>>;

export class ModelConfig extends ConfigOverlay<ModelConfig> {
  readonly enabled?: ModelConfigObject["enabled"];
  readonly properties?: ModelPropertiesConfig | null;
  readonly optionSpecs?: ModelOptionSpecsConfig | null;

  constructor(input: ModelConfigInput = {}) {
    super();
    this.enabled = input.enabled;
    this.properties = input.properties;
    this.optionSpecs = input.optionSpecs;
    Object.freeze(this);
  }

  static empty(): ModelConfig {
    return new ModelConfig();
  }

  static fromData(config: ModelConfigObject): ModelConfig {
    return new ModelConfig({
      enabled: config.enabled,
      properties:
        config.properties == null
          ? config.properties
          : new ModelPropertiesConfig(config.properties),
      optionSpecs:
        config.optionSpecs == null
          ? config.optionSpecs
          : new ModelOptionSpecsConfig(config.optionSpecs),
    });
  }

  overlay(next: ModelConfig): ModelConfig {
    return new ModelConfig({
      enabled: this.overlayValue(this.enabled, next.enabled),
      properties: this.overlayConfig(this.properties, next.properties),
      optionSpecs: this.overlayConfig(this.optionSpecs, next.optionSpecs),
    });
  }

  validateComplete(path: readonly string[] = []): readonly ConfigValidationIssue[] {
    return validateConfigSchema(completeModelConfigDataSchema, this.toJSON(), path);
  }

  toJSON(): ModelConfigObject {
    return objectWithoutUndefined({
      enabled: this.enabled,
      properties: this.properties?.toJSON() ?? this.properties,
      optionSpecs: this.optionSpecs?.toJSON() ?? this.optionSpecs,
    });
  }
}

type RuleWithConfig<T> = Readonly<Omit<T, "config"> & { config: ModelConfig }>;
export type ProviderModelConfigRule = RuleWithConfig<ProviderModelConfigRuleData>;
export type ManualProviderModelConfigRule = RuleWithConfig<ManualProviderModelConfigRuleData>;
export type TemplateModelConfigRule = RuleWithConfig<TemplateModelConfigRuleData>;
export type ModelMatchConfigRule = RuleWithConfig<ModelMatchConfigRuleData>;
export type ModelApiMatchConfigRule = RuleWithConfig<ModelApiMatchConfigRuleData>;
export type ProviderSiteMatchConfigRule = RuleWithConfig<ProviderSiteMatchConfigRuleData>;

/** type 只标识内存执行规则的来源层，不写入配置文件；分组不能再按字段有无猜测。 */
export type ModelConfigRule =
  | (ProviderModelConfigRule & { readonly type: "provider-model" })
  | (ManualProviderModelConfigRule & { readonly type: "manual-provider-model" })
  | (TemplateModelConfigRule & { readonly type: "template-model" })
  | (ModelMatchConfigRule & { readonly type: "model" })
  | (ModelApiMatchConfigRule & { readonly type: "model-api" })
  | (ProviderSiteMatchConfigRule & { readonly type: "provider-site" });
type ExactModelConfigRule = Extract<
  ModelConfigRule,
  { type: "provider-model" | "manual-provider-model" }
>;

export interface ModelConfigRuleResolutionInput {
  readonly providerId: string;
  readonly templateId?: string | null;
  readonly modelId: string;
  readonly apiType?: string | null;
  readonly baseUrl?: string | null;
}

export class ModelConfigRules {
  readonly #rules: readonly ModelConfigRule[];

  constructor(rules: readonly ModelConfigRule[] = []) {
    this.#rules = Object.freeze(rules.map((rule) => Object.freeze({ ...rule })));
    Object.freeze(this);
  }

  static empty(): ModelConfigRules {
    return new ModelConfigRules();
  }

  /** Built-in 保留原层次和组内顺序；个人只包含普通/手动精确规则。 */
  static composeEffective(builtin: ModelConfigRules, personal: ModelConfigRules): ModelConfigRules {
    return new ModelConfigRules([...builtin.rules(), ...personal.rules().filter(isExactModelRule)]);
  }

  rules(): readonly ModelConfigRule[] {
    return this.#rules;
  }

  resolve(input: ModelConfigRuleResolutionInput): ModelConfig {
    let result = ModelConfig.empty();
    const baseUrl = input.baseUrl == null ? undefined : normalizeBaseURLForRuleMatch(input.baseUrl);
    for (const rule of this.#rules) {
      if (isExactModelRule(rule)) {
        if (rule.providerId !== input.providerId || rule.modelId !== input.modelId) continue;
        // 手动规则要求所有可编辑叶子齐全，因此可直接覆盖；系统叶子继续来自当前身份的规则。
        // 清空整份基线会既丢失系统映射，也迫使 UI 把旧模型的隐藏配置复制进个人规则。
        result = (
          rule.type === "manual-provider-model"
            ? ModelConfig.fromData(clearManualModelConfig(result.toJSON()))
            : result
        ).overlay(rule.config);
        continue;
      }
      if (rule.type === "template-model") {
        if (rule.templateId === input.templateId && rule.modelId === input.modelId)
          result = result.overlay(rule.config);
        continue;
      }
      // 只放宽推荐规则匹配，不改真实请求里的模型 ID。
      if (!matchesRule(rule.modelMatch, input.modelId, true)) continue;
      if (
        (rule.type === "model-api" || rule.type === "provider-site") &&
        rule.apiTypeMatch !== undefined
      ) {
        if (input.apiType == null || !matchesRule(rule.apiTypeMatch, input.apiType)) continue;
      }
      if (
        rule.type === "provider-site" &&
        (baseUrl === undefined || !matchesRule(rule.baseUrlMatch, baseUrl))
      )
        continue;
      result = result.overlay(rule.config);
    }
    return result;
  }

  setExact(
    providerId: string,
    modelId: string,
    config: ModelConfig,
    useRecommendedConfig?: boolean,
  ): ModelConfigRules {
    const previous = this.getExactRule(providerId, modelId);
    const manual =
      useRecommendedConfig === undefined
        ? previous?.type === "manual-provider-model"
        : !useRecommendedConfig;
    // 保存入口复用整条规则 schema，不再另写一份“完整但忽略 enabled”的校验。
    const data = { providerId, modelId, config: config.toJSON() };
    (manual ? manualProviderModelConfigRuleSchema : providerModelConfigRuleSchema).parse(data);
    const replacement: ExactModelConfigRule = {
      type: manual ? "manual-provider-model" : "provider-model",
      providerId,
      modelId,
      config,
    };
    const result: ModelConfigRule[] = [];
    let replaced = false;
    for (const rule of this.#rules) {
      if (isExactModelRule(rule) && rule.providerId === providerId && rule.modelId === modelId) {
        if (!replaced) result.push(replacement);
        replaced = true;
      } else {
        result.push(rule);
      }
    }
    if (!replaced) result.push(replacement);
    return new ModelConfigRules(result);
  }

  deleteExact(providerId: string, modelId: string): ModelConfigRules {
    return new ModelConfigRules(
      this.#rules.filter(
        (rule) =>
          !isExactModelRule(rule) || rule.providerId !== providerId || rule.modelId !== modelId,
      ),
    );
  }

  renameExactModel(
    providerId: string,
    currentModelId: string,
    nextModelId: string,
  ): ModelConfigRules {
    if (currentModelId === nextModelId) return this;
    return new ModelConfigRules(
      this.#rules.map((rule) =>
        isExactModelRule(rule) && rule.providerId === providerId && rule.modelId === currentModelId
          ? { ...rule, modelId: nextModelId }
          : rule,
      ),
    );
  }

  deleteExactForProvider(providerId: string): ModelConfigRules {
    return new ModelConfigRules(
      this.#rules.filter((rule) => !isExactModelRule(rule) || rule.providerId !== providerId),
    );
  }

  getExact(providerId: string, modelId: string): ModelConfig | undefined {
    let result: ModelConfig | undefined;
    for (const rule of this.#rules) {
      if (!isExactModelRule(rule) || rule.providerId !== providerId || rule.modelId !== modelId)
        continue;
      result = result ? result.overlay(rule.config) : rule.config;
    }
    return result;
  }

  getExactRule(providerId: string, modelId: string): ExactModelConfigRule | undefined {
    for (let index = this.#rules.length - 1; index >= 0; index -= 1) {
      const rule = this.#rules[index]!;
      if (isExactModelRule(rule) && rule.providerId === providerId && rule.modelId === modelId)
        return rule;
    }
    return undefined;
  }

  toACodeBuiltinJSON(): BuiltinModelConfigRulesData {
    return builtinModelConfigRulesSchema.parse({
      modelRules: this.#collect("model"),
      modelApiRules: this.#collect("model-api"),
      providerSiteRules: this.#collect("provider-site"),
      templateModelRules: this.#collect("template-model"),
      builtinProviderModelRules: this.#collect("provider-model"),
    });
  }

  toPersonalJSON(): PersonalModelConfigRulesData {
    // 完整规则必须在编码边界再校验，不能把直接构造的不完整手动值写入文件。
    return personalModelConfigRulesSchema.parse({
      providerModelRules: this.#collect("provider-model"),
      manualProviderModelRules: this.#collect("manual-provider-model"),
    });
  }

  toJSON() {
    return {
      ...this.toACodeBuiltinJSON(),
      manualProviderModelRules: this.#collect("manual-provider-model"),
    };
  }

  #collect<T extends ModelConfigRule["type"]>(type: T) {
    return this.#rules
      .filter((rule): rule is Extract<ModelConfigRule, { type: T }> => rule.type === type)
      .map(({ type: _type, config, ...identity }) => ({ ...identity, config: config.toJSON() }));
  }
}

function isExactModelRule(rule: ModelConfigRule): rule is ExactModelConfigRule {
  return rule.type === "provider-model" || rule.type === "manual-provider-model";
}

function matchesRule(pattern: string, value: string, ignoreCase = false): boolean {
  return new RegExp(`^(?:${pattern})$`, ignoreCase ? "i" : undefined).test(value);
}

function normalizeBaseURLForRuleMatch(value: string): string | undefined {
  try {
    // Host 大小写、默认端口和尾部斜杠不应改变配置命中；URL parser 会保留 path/query 大小写。
    const parsed = new URL(value);
    const suffix = `${parsed.search}${parsed.hash}`;
    const serialized = parsed.toString();
    const endpoint = suffix.length === 0 ? serialized : serialized.slice(0, -suffix.length);
    return `${endpoint.replace(/\/+$/, "")}${suffix}`;
  } catch {
    return undefined;
  }
}

function objectWithoutUndefined<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, fieldValue]) => fieldValue !== undefined),
  ) as T;
}
