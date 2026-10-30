// 2026-12-31 例外债务偿还：自 facades.ts 按职责拆出 —— Provider Settings 视图契约族
// （发现输入、Facade 依赖接口、Settings 视图/候选/解析/草稿/创建结果类型）。
// 接口逐字迁移，行为零改动；Registry 快照投影见 provider-settings-projection.ts，
// Facade 实现见 provider-settings-facade.ts / model-selection-facade.ts。
import type { ConfigValidationIssue } from "./config-overlay.js";
import type { ProviderModelMembership } from "./config-service.js";
import type {
  ModelConfig,
  ModelConfigObject,
  ModelId,
  ProviderConfig,
  ProviderConfigObject,
  ProviderId,
  ProviderTemplateId,
} from "./config/index.js";
import type {
  ProviderConfigRule,
  ProviderTemplateNameMap,
  ProviderTemplateLocale,
} from "./config/index.js";
import type { ProviderRegistryView } from "./registry.js";
import type { ProviderApiType } from "./config/provider-config.js";
import type { RegistryModelConfigObject } from "./resolver.js";
import type {
  ProviderRegistryServiceChangedEvent,
  ProviderRegistryServiceSnapshot,
} from "./registry-service.js";

/**
 * 模型发现（packages/services/specs/provider-model-discovery.md）的宿主本地输入：
 * baseUrl + api 类型 + 水合 apiKey。apiKey 只供宿主侧发现请求的鉴权头使用——不进
 * RPC 视图、不进日志、不作为任何 RPC 方法的返回值（readProviderDiscoveryInput
 * 不登记进 RPC allowedMethods）。
 */
export interface ProviderDiscoveryInput {
  readonly baseUrl: string;
  readonly apiType: ProviderApiType;
  readonly apiKey?: string;
}

export interface ProviderRegistryFacadeSource {
  getSnapshot(): ProviderRegistryServiceSnapshot | null;
  getView(): ProviderRegistryView;
  refresh(reason: string): Promise<ProviderRegistryServiceSnapshot>;
  onDidChange(listener: (event: ProviderRegistryServiceChangedEvent) => void): () => void;
}

export interface ProviderSettingsMutationTarget {
  createPersonalProvider(input?: {
    readonly templateId?: ProviderTemplateId;
    readonly providerName?: string;
    readonly locale?: ProviderTemplateLocale;
    readonly initialConfig?: ProviderConfig;
  }): Promise<{ readonly providerId: ProviderId }>;
  savePersonalProviderOverlay(
    providerId: ProviderId,
    config: ProviderConfig,
    membership?: ProviderModelMembership,
    metadata?: Pick<ProviderConfigRule, "providerName" | "templateId" | "enabled">,
  ): Promise<unknown>;
  deletePersonalProvider(providerId: ProviderId): Promise<unknown>;
  reorderPersonalProviders(providerIds: readonly ProviderId[]): Promise<unknown>;
  reorderPersonalModels(
    providerId: ProviderId,
    modelIds: readonly ModelId[],
    membership?: ProviderModelMembership,
  ): Promise<unknown>;
  addPersonalModel(
    providerId: ProviderId,
    modelId: ModelId,
    config: ModelConfig,
    membership?: ProviderModelMembership,
    useRecommendedConfig?: boolean,
  ): Promise<unknown>;
  addPersonalModels(
    providerId: ProviderId,
    modelIds: readonly ModelId[],
    membership?: ProviderModelMembership,
    useRecommendedConfig?: boolean,
  ): Promise<unknown>;
  renamePersonalModel(
    providerId: ProviderId,
    currentModelId: ModelId,
    nextModelId: ModelId,
    membership?: ProviderModelMembership,
  ): Promise<unknown>;
  deletePersonalModel(
    providerId: ProviderId,
    modelId: ModelId,
    membership?: ProviderModelMembership,
  ): Promise<unknown>;
  savePersonalModelDraft(
    providerId: ProviderId,
    originalModelId: ModelId,
    nextModelId: ModelId,
    config: ModelConfig,
    expectedPersonalRevision: string,
    useRecommendedConfig?: boolean,
    membership?: ProviderModelMembership,
  ): Promise<unknown>;
  setPersonalModelEnabled(
    providerId: ProviderId,
    modelId: ModelId,
    enabled: boolean,
    membership?: ProviderModelMembership,
  ): Promise<unknown>;
  refresh(reason: string): Promise<ProviderRegistryServiceSnapshot>;
  /** 主动重读上游事实后再刷新 Registry。 */
  refreshSources?(reason: string): Promise<ProviderRegistryServiceSnapshot>;
}

export interface ProviderSettingsModelCandidateView {
  readonly kind: "candidate";
  readonly modelId: ModelId;
  readonly builtin: boolean;
  readonly effectiveBuiltinConfig: ModelConfigObject;
  readonly personalExactConfig?: ModelConfigObject;
  readonly useRecommendedConfig?: boolean;
  readonly effectiveConfig: RegistryModelConfigObject | ModelConfigObject;
  readonly enabled: boolean;
  readonly executable: boolean;
  readonly selectable: boolean;
  readonly issues: readonly ConfigValidationIssue[];
}

export type ProviderSettingsModelView = ProviderSettingsModelCandidateView;

export interface ModelConfigResolution {
  readonly inheritedConfig: ModelConfigObject;
  readonly effectiveConfig: ModelConfigObject;
  readonly issues: readonly ConfigValidationIssue[];
}

export type ResolveModelConfigInput =
  | {
      readonly providerId: ProviderId;
      readonly modelId: ModelId;
    }
  | {
      readonly providerId: ProviderId;
      readonly originalModelId: ModelId;
      readonly modelId: ModelId;
      readonly personalConfig: ModelConfigObject;
    };

export interface SavePersonalModelDraftInput {
  readonly providerId: ProviderId;
  readonly originalModelId: ModelId;
  readonly nextModelId: ModelId;
  readonly personalConfig: ModelConfigObject;
  readonly useRecommendedConfig?: boolean;
  readonly basedOnRevision: number;
}

export interface ProviderSettingsProviderView extends Pick<
  ProviderConfigRule,
  "providerName" | "templateId"
> {
  readonly enabled: boolean;
  readonly accountState?: import("./account-provider-state.js").AccountProviderState;
  readonly providerId: ProviderId;
  /** 当前 Effective Config 是否已经进入 Registry，可用于模型选择和创建。 */
  readonly executable: boolean;
  readonly effectiveBuiltinConfig?: ProviderConfigObject;
  readonly personalConfig?: ProviderConfigObject;
  readonly effectiveConfig: ProviderConfigObject;
  readonly issues: readonly ConfigValidationIssue[];
  readonly models: readonly ProviderSettingsModelView[];
}

export interface ProviderSettingsTemplateView {
  readonly templateId: ProviderTemplateId;
  readonly templateNameMap: ProviderTemplateNameMap;
  readonly config: ProviderConfigObject;
}

export interface ProviderSettingsView {
  readonly revision: number;
  readonly providerTemplates: readonly ProviderSettingsTemplateView[];
  readonly providerOrder: readonly ProviderId[];
  readonly providers: readonly ProviderSettingsProviderView[];
}

export interface ProviderSettingsCreationResult {
  readonly providerId: ProviderId;
  readonly view: ProviderSettingsView;
}
