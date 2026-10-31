// 2026-12-31 例外债务偿还：自 facades.ts 按职责拆出 —— Registry 快照投影族
// （快照存取守卫 requireSnapshot/requireEffectiveProvider 与 Settings 视图构建
// createProviderSettingsView）。逐字迁移（仅补 export 供两个 Facade 叶子复用），行为零改动。
// 内部 helper：facades.ts 不 re-export 本叶符号，包导出面保持不变。
import { ProviderTemplateMap } from "./config/index.js";
import type { ProviderConfigRule, ProviderId } from "./config/index.js";
import type { ProviderConfigResolution } from "./resolver.js";
import type { ProviderRegistryServiceSnapshot } from "./registry-service.js";
import type {
  ProviderRegistryFacadeSource,
  ProviderSettingsView,
} from "./provider-settings-views.js";

export function requireSnapshot(source: ProviderRegistryFacadeSource): ProviderRegistryServiceSnapshot {
  const snapshot = source.getSnapshot();
  if (!snapshot) throw new Error("ProviderRegistryService 尚未 start()");
  return snapshot;
}

export function requireEffectiveProvider(
  snapshot: ProviderRegistryServiceSnapshot,
  providerId: ProviderId,
): ProviderConfigRule {
  const provider = snapshot.resolution.effectiveProviders.getRule(providerId);
  if (!provider) throw new Error(`Provider 不存在: ${providerId}`);
  return provider;
}

export function createProviderSettingsView(input: {
  revision: number;
  acodeBuiltinProviders: ProviderRegistryServiceSnapshot["config"]["acodeBuiltinProviders"];
  acodeBuiltinProviderTemplates: ProviderRegistryServiceSnapshot["config"]["acodeBuiltinProviderTemplates"];
  personalProviders: ProviderRegistryServiceSnapshot["config"]["personalProviders"];
  personalModels: ProviderRegistryServiceSnapshot["config"]["personalModels"];
  resolution: ProviderConfigResolution;
  accountStates?: import("./account-provider-state.js").AccountProviderStates;
}): ProviderSettingsView {
  const executableProviderIds = new Set(
    input.resolution.registryProviders.map((provider) => provider.providerId),
  );
  const projectProvider = (provider: (typeof input.resolution.resolvedProviders)[number]) => {
    const personalConfig = input.personalProviders.get(provider.providerId);
    return Object.freeze({
      providerId: provider.providerId,
      providerName: provider.providerName,
      templateId: provider.templateId,
      enabled: provider.enabled,
      ...(input.accountStates?.[provider.providerId]
        ? { accountState: input.accountStates[provider.providerId] }
        : {}),
      executable: executableProviderIds.has(provider.providerId),
      ...(provider.templateConfig ? { templateConfig: provider.templateConfig.toJSON() } : {}),
      ...(provider.effectiveBuiltinConfig
        ? { effectiveBuiltinConfig: provider.effectiveBuiltinConfig.toJSON() }
        : {}),
      ...(personalConfig ? { personalConfig: personalConfig.toJSON() } : {}),
      effectiveConfig: provider.config.toJSON(),
      issues: provider.providerIssues,
      models: Object.freeze(
        provider.models.map((model) => {
          const personalModelConfig = input.personalModels.getExact(
            provider.providerId,
            model.modelId,
          );
          const personalModelRule = input.personalModels.getExactRule(
            provider.providerId,
            model.modelId,
          );
          return Object.freeze({
            kind: model.kind,
            modelId: model.modelId,
            builtin: model.source === "builtin",
            effectiveBuiltinConfig: model.effectiveBuiltinConfig.toJSON(),
            ...(personalModelConfig ? { personalExactConfig: personalModelConfig.toJSON() } : {}),
            ...(personalModelRule
              ? { useRecommendedConfig: personalModelRule.type !== "manual-provider-model" }
              : {}),
            effectiveConfig: model.config.toJSON(),
            enabled: model.enabled,
            executable: model.executable,
            selectable: model.selectable,
            issues: model.issues,
          });
        }),
      ),
    });
  };
  const visibleProviders = input.resolution.resolvedProviders.filter(
    (provider) => provider.config.visibility !== "hidden",
  );
  const configuredProviders = visibleProviders;
  return Object.freeze({
    revision: input.revision,
    providerTemplates: Object.freeze(
      (input.acodeBuiltinProviderTemplates ?? ProviderTemplateMap.empty())
        .entries()
        .map(([templateId, template]) =>
          Object.freeze({
            templateId,
            templateNameMap: template.templateNameMap,
            config: template.config.toJSON(),
          }),
        ),
    ),
    providerOrder: Object.freeze(
      configuredProviders
        .filter((provider) => provider.config.group === "standard-personal")
        .map((provider) => provider.providerId),
    ),
    providers: Object.freeze(configuredProviders.map(projectProvider)),
  });
}
