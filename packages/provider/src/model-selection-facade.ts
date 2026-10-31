// 2026-12-31 例外债务偿还：自 facades.ts 按职责拆出 —— Model Selection 视图族
// （ModelSelection*View 契约、ModelSelectionFacade 与投影 helper
// projectModelSelectionProviderView）。逐字迁移，行为零改动；
// 快照守卫来自 provider-settings-projection.ts。
import type {
  ModelId,
  ProviderConfigObject,
  ProviderId,
} from "./config/index.js";
import type { ProviderConfigRule } from "./config/index.js";
import type { ProviderRegistryView } from "./registry.js";
import { resolveInitialModelSelection } from "./model-selection-config.js";
import {
  resolveEffectiveModelSelection,
  type EffectiveModelSelectionResult,
  type ModelSelectionProviderClassifier,
} from "./effective-model-selection.js";
import type { ModelSelection } from "./registry.js";
import {
  serializeRegistryModelConfig,
  serializeRegistryProviderConfig,
  type RegistryModelConfigObject,
} from "./resolver.js";
import type { ProviderRegistryServiceSnapshot } from "./registry-service.js";
import type { ProviderRegistryFacadeSource } from "./provider-settings-views.js";
import { requireSnapshot } from "./provider-settings-projection.js";

export interface ModelSelectionModelView {
  readonly modelId: ModelId;
  readonly config: RegistryModelConfigObject;
}

export interface ModelSelectionProviderView extends Pick<
  ProviderConfigRule,
  "providerName" | "templateId"
> {
  readonly providerId: ProviderId;
  readonly config: ProviderConfigObject;
  readonly models: readonly ModelSelectionModelView[];
}

export interface ModelSelectionViewInput {
  readonly selection: ModelSelection | null;
}

export interface ModelSelectionView extends Partial<EffectiveModelSelectionResult> {
  readonly revision: number;
  readonly providers: readonly ModelSelectionProviderView[];
  readonly preferredSelection?: ModelSelection;
}

export class ModelSelectionFacade {
  readonly #source: ProviderRegistryFacadeSource;
  readonly #classifyProvider: ModelSelectionProviderClassifier;
  readonly #resolveLegacyReasoningLevel?: (
    snapshot: ProviderRegistryServiceSnapshot,
    selection: ModelSelection,
  ) => string | undefined;

  constructor(
    source: ProviderRegistryFacadeSource,
    classifyProvider: ModelSelectionProviderClassifier = () => "ordinary",
    resolveLegacyReasoningLevel?: (
      snapshot: ProviderRegistryServiceSnapshot,
      selection: ModelSelection,
    ) => string | undefined,
  ) {
    this.#source = source;
    this.#classifyProvider = classifyProvider;
    this.#resolveLegacyReasoningLevel = resolveLegacyReasoningLevel;
  }

  getView(
    configuredDefault?: ModelSelection,
    revision?: number,
    input?: ModelSelectionViewInput,
  ): ModelSelectionView {
    // 账号事实与候选从同一已应用快照读取；不把最新 Settings 配给旧 Registry。
    const snapshot = input ? requireSnapshot(this.#source) : this.#source.getSnapshot();
    const registry = snapshot?.registry ?? this.#source.getView();
    const resolveLegacyReasoningLevel =
      snapshot && this.#resolveLegacyReasoningLevel
        ? (selection: ModelSelection) => this.#resolveLegacyReasoningLevel!(snapshot, selection)
        : undefined;
    // 默认偏好只归一化档位，不借此改写账号身份或保存配置。
    const normalizedDefault =
      configuredDefault && resolveLegacyReasoningLevel
        ? (resolveEffectiveModelSelection({
            selection: configuredDefault,
            registry,
            classifyProvider: () => "ordinary",
            resolveLegacyReasoningLevel,
          }).effectiveSelection ?? undefined)
        : configuredDefault;
    const initial = resolveInitialModelSelection({
      registry,
      configuredDefault: normalizedDefault,
    });
    return Object.freeze({
      revision: revision ?? registry.revision,
      providers: Object.freeze(
        registry.providers
          .filter((provider) => provider.config.visibility !== "hidden")
          .map(projectModelSelectionProviderView),
      ),
      ...(initial.source === "none" ? {} : { preferredSelection: initial.selection }),
      ...(input
        ? resolveEffectiveModelSelection({
            selection: input.selection,
            registry,
            accountStates: snapshot?.account.states,
            classifyProvider: this.#classifyProvider,
            resolveLegacyReasoningLevel,
          })
        : {}),
    });
  }

  onDidChange(listener: (view: ModelSelectionView) => void): () => void {
    return this.#source.onDidChange(() => listener(this.getView()));
  }
}

/** 把一个已进入 Registry 的 Provider 投影为标准模型选择候选。调用方负责产品作用域。 */
export function projectModelSelectionProviderView(
  provider: ProviderRegistryView["providers"][number],
): ModelSelectionProviderView {
  return Object.freeze({
    providerId: provider.providerId,
    providerName: provider.providerName,
    templateId: provider.templateId,
    config: serializeRegistryProviderConfig(provider.config),
    models: Object.freeze(
      provider.models.map((model) =>
        Object.freeze({
          modelId: model.modelId,
          config: serializeRegistryModelConfig(model.config),
        }),
      ),
    ),
  });
}
