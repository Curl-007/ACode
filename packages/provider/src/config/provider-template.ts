// 2026-12-31 例外债务偿还：自 provider-config.ts 按职责拆出 —— Provider Template 族
// （Template 元数据壳、名称本地化解析与 ProviderTemplateMap 索引）。
// 逐字迁移，行为零改动；Access 族与 Provider 主配置见同目录其余叶子。
import { ConfigOverlay, type ConfigValidationIssue } from "../config-overlay.js";
import type { z } from "zod";
import type {
  providerTemplateNameMapDataSchema,
  providerTemplateDataSchema,
} from "./provider-data-schema.js";
import type { ProviderTemplateId } from "./ids.js";
import type { ProviderConfig } from "./provider-core-config.js";

export type ProviderTemplateNameMap = Readonly<z.infer<typeof providerTemplateNameMapDataSchema>>;
export type ProviderTemplateLocale = keyof ProviderTemplateNameMap;

export type ProviderTemplateInput = Omit<ProviderTemplateObject, "config"> & {
  readonly config: ProviderConfig;
};

export type ProviderTemplateObject = Readonly<z.infer<typeof providerTemplateDataSchema>>;

/** Template 是元数据与 Provider Overlay 的领域壳，本身不是 Provider。 */
export class ProviderTemplate {
  readonly templateId: ProviderTemplateId;
  readonly templateNameMap: ProviderTemplateNameMap;
  readonly config: ProviderConfig;

  constructor(input: ProviderTemplateInput) {
    this.templateId = input.templateId;
    this.templateNameMap = Object.freeze({ ...input.templateNameMap });
    this.config = input.config;
    Object.freeze(this);
  }

  toJSON(): ProviderTemplateObject {
    return {
      templateId: this.templateId,
      templateNameMap: this.templateNameMap,
      config: this.config.toJSON(),
    };
  }
}

export function resolveProviderTemplateName(
  templateId: ProviderTemplateId,
  template: Pick<ProviderTemplate, "templateNameMap">,
  locale: ProviderTemplateLocale,
): string {
  return (
    template.templateNameMap[locale]?.trim() ||
    template.templateNameMap["en-US"]?.trim() ||
    templateId
  );
}

/** Built-in Template 与真实 Provider 使用不同身份空间；Template 永不进入 Registry。 */
export class ProviderTemplateMap extends ConfigOverlay<ProviderTemplateMap> {
  readonly #values: ReadonlyMap<ProviderTemplateId, ProviderTemplate>;

  constructor(entries: Iterable<readonly [ProviderTemplateId, ProviderTemplate]> = []) {
    super();
    const values = new Map<ProviderTemplateId, ProviderTemplate>();
    for (const [templateId, template] of entries) {
      if (values.has(templateId)) throw new Error(`重复 Provider Template key: ${templateId}`);
      values.set(templateId, template);
    }
    this.#values = values;
    Object.freeze(this);
  }

  static empty(): ProviderTemplateMap {
    return new ProviderTemplateMap();
  }

  overlay(next: ProviderTemplateMap): ProviderTemplateMap {
    const result = new Map(this.#values);
    for (const [templateId, template] of next.#values) result.set(templateId, template);
    return new ProviderTemplateMap(result);
  }

  validateComplete(): readonly ConfigValidationIssue[] {
    return [];
  }

  get(templateId: ProviderTemplateId): ProviderTemplate | undefined {
    return this.#values.get(templateId);
  }

  has(templateId: ProviderTemplateId): boolean {
    return this.#values.has(templateId);
  }

  keys(): ProviderTemplateId[] {
    return [...this.#values.keys()];
  }

  entries(): Array<readonly [ProviderTemplateId, ProviderTemplate]> {
    return [...this.#values.entries()];
  }

  toJSON(): ProviderTemplateObject[] {
    return this.entries().map(([, template]) => template.toJSON());
  }
}
