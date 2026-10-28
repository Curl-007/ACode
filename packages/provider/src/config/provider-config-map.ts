// 2026-12-31 例外债务偿还：自 provider-config.ts 按职责拆出 —— Provider 规则索引族
// （ProviderConfigRule 与 ProviderConfigMap：ProviderId → 完整规则的内容投影与合并）。
// 逐字迁移，行为零改动；Access 族、Provider 主配置与 Template 族见同目录其余叶子。
import { ConfigOverlay, type ConfigValidationIssue } from "../config-overlay.js";
import type { ProviderId } from "./ids.js";
import type { ProviderConfigRuleData } from "./rule-data-schema.js";
import type { ProviderConfig } from "./provider-core-config.js";

export type ProviderConfigRule = Readonly<
  Omit<ProviderConfigRuleData, "config"> & { config: ProviderConfig }
>;

/** 索引只保存完整规则；get/entries 是内容投影，改成员时不能丢掉外层身份和名称。 */
export class ProviderConfigMap extends ConfigOverlay<ProviderConfigMap> {
  readonly #values: ReadonlyMap<ProviderId, ProviderConfigRule>;

  constructor(entries: Iterable<ProviderConfigRule | readonly [ProviderId, ProviderConfig]> = []) {
    super();
    const values = new Map<ProviderId, ProviderConfigRule>();
    for (const entry of entries) {
      const rule = "providerId" in entry ? entry : { providerId: entry[0], config: entry[1] };
      if (values.has(rule.providerId)) throw new Error(`重复 Provider key: ${rule.providerId}`);
      values.set(rule.providerId, Object.freeze({ ...rule }));
    }
    this.#values = values;
    Object.freeze(this);
  }

  static empty(): ProviderConfigMap {
    return new ProviderConfigMap();
  }

  overlay(next: ProviderConfigMap): ProviderConfigMap {
    const result = new Map(this.#values);
    for (const [providerId, rule] of next.#values) {
      const current = result.get(providerId);
      result.set(
        providerId,
        current
          ? {
              providerId,
              templateId: this.overlayValue(current.templateId, rule.templateId),
              providerName: this.overlayValue(current.providerName, rule.providerName),
              enabled: this.overlayValue(current.enabled, rule.enabled),
              config: current.config.overlay(rule.config),
            }
          : rule,
      );
    }
    return new ProviderConfigMap(result.values());
  }

  mapConfigs(
    transform: (
      config: ProviderConfig,
      providerId: ProviderId,
      rule: ProviderConfigRule,
    ) => ProviderConfig,
  ): ProviderConfigMap {
    return new ProviderConfigMap(
      this.rules().map((rule) => ({
        ...rule,
        config: transform(rule.config, rule.providerId, rule),
      })),
    );
  }

  reorder(providerIds: readonly ProviderId[]): ProviderConfigMap {
    const result = new Map<ProviderId, ProviderConfigRule>();
    for (const providerId of providerIds) {
      const rule = this.#values.get(providerId);
      if (rule && !result.has(providerId)) result.set(providerId, rule);
    }
    for (const [providerId, rule] of this.#values) {
      if (!result.has(providerId)) result.set(providerId, rule);
    }
    return new ProviderConfigMap(result.values());
  }

  set(providerId: ProviderId, config: ProviderConfig): ProviderConfigMap {
    return this.setRule({ ...this.#values.get(providerId), providerId, config });
  }

  setRule(rule: ProviderConfigRule): ProviderConfigMap {
    const result = new Map(this.#values);
    result.set(rule.providerId, rule);
    return new ProviderConfigMap(result.values());
  }

  delete(providerId: ProviderId): ProviderConfigMap {
    return new ProviderConfigMap(this.rules().filter((rule) => rule.providerId !== providerId));
  }

  validateComplete(path: readonly string[] = []): readonly ConfigValidationIssue[] {
    return this.entries().flatMap(([providerId, config]) =>
      config.validateComplete([...path, providerId]),
    );
  }

  get(providerId: ProviderId): ProviderConfig | undefined {
    return this.#values.get(providerId)?.config;
  }
  getRule(providerId: ProviderId): ProviderConfigRule | undefined {
    return this.#values.get(providerId);
  }
  has(providerId: ProviderId): boolean {
    return this.#values.has(providerId);
  }
  keys(): ProviderId[] {
    return [...this.#values.keys()];
  }
  rules(): ProviderConfigRule[] {
    return [...this.#values.values()];
  }
  entries(): Array<readonly [ProviderId, ProviderConfig]> {
    return this.rules().map((rule) => [rule.providerId, rule.config]);
  }

  toJSON(): ProviderConfigRuleData[] {
    return this.rules().map(({ config, ...rule }) =>
      objectWithoutUndefined({ ...rule, config: config.toJSON() }),
    );
  }
}

function objectWithoutUndefined<T extends object>(input: T): T {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as T;
}
