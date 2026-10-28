// 2026-12-31 例外债务偿还：自 facades.ts 按职责拆出 —— ProviderSettingsFacade
// （Settings 视图读取、模型配置解析预览与串行化写入边界）。类逐字迁移，行为零改动；
// 视图契约见 provider-settings-views.ts，快照投影见 provider-settings-projection.ts。
import type { ProviderModelMembership } from "./config-service.js";
import type {
  ModelConfigObject,
  ModelId,
  ProviderConfigObject,
  ProviderId,
  ProviderTemplateId,
} from "./config/index.js";
import {
  ModelConfigRules,
  type ProviderConfigRule,
  type ProviderTemplateLocale,
  parseModelConfig,
  parseProviderConfig,
} from "./config/index.js";
import type {
  ModelConfigResolution,
  ProviderDiscoveryInput,
  ProviderRegistryFacadeSource,
  ProviderSettingsCreationResult,
  ProviderSettingsMutationTarget,
  ProviderSettingsView,
  ResolveModelConfigInput,
  SavePersonalModelDraftInput,
} from "./provider-settings-views.js";
import {
  createProviderSettingsView,
  requireEffectiveProvider,
  requireSnapshot,
} from "./provider-settings-projection.js";

export class ProviderSettingsFacade {
  readonly #source: ProviderRegistryFacadeSource;
  readonly #mutations?: ProviderSettingsMutationTarget;
  readonly #providerMutationTails = new Map<ProviderId, Promise<unknown>>();

  constructor(source: ProviderRegistryFacadeSource, mutations?: ProviderSettingsMutationTarget) {
    this.#source = source;
    this.#mutations = mutations;
  }

  getView(): ProviderSettingsView {
    const snapshot = requireSnapshot(this.#source);
    return createProviderSettingsView({
      revision: snapshot.registry.revision,
      acodeBuiltinProviders: snapshot.config.acodeBuiltinProviders,
      acodeBuiltinProviderTemplates: snapshot.config.acodeBuiltinProviderTemplates,
      personalProviders: snapshot.config.personalProviders,
      personalModels: snapshot.config.personalModels,
      resolution: snapshot.resolution,
      accountStates: snapshot.account.states,
    });
  }

  async refresh(reason: string): Promise<ProviderSettingsView> {
    if (this.#mutations?.refreshSources) {
      await this.#mutations.refreshSources(`settings:${reason}`);
    } else {
      await this.#source.refresh(reason);
    }
    return this.getView();
  }

  resolveModelConfig(input: ResolveModelConfigInput): ModelConfigResolution {
    const snapshot = requireSnapshot(this.#source);
    const provider = requireEffectiveProvider(snapshot, input.providerId);
    if (!("personalConfig" in input)) {
      const modelRules = ModelConfigRules.composeEffective(
        snapshot.config.acodeBuiltinModelRules,
        snapshot.config.personalModels,
      );
      const config = modelRules.resolve({
        providerId: input.providerId,
        templateId: provider.templateId,
        modelId: input.modelId,
        apiType: provider.config.api?.type,
        baseUrl: provider.config.api?.baseUrl,
      });
      return Object.freeze({
        inheritedConfig: config.toJSON(),
        effectiveConfig: config.toJSON(),
        issues: Object.freeze([
          ...config.validateComplete(["providers", input.providerId, "models", input.modelId]),
        ]),
      });
    }

    const personalConfig = parseModelConfig(input.personalConfig);
    const inheritedConfig = snapshot.config.acodeBuiltinModelRules.resolve({
      providerId: input.providerId,
      templateId: provider.templateId,
      modelId: input.modelId,
      apiType: provider.config.api?.type,
      baseUrl: provider.config.api?.baseUrl,
    });
    let personalRules = snapshot.config.personalModels;
    if (input.originalModelId !== input.modelId) {
      personalRules = personalRules.renameExactModel(
        input.providerId,
        input.originalModelId,
        input.modelId,
      );
    }
    // 此入口预览智能配置草稿；固定模式不请求推荐，重新开启时不能沿用旧固定标记。
    personalRules = personalRules.setExact(input.providerId, input.modelId, personalConfig, true);
    const config = ModelConfigRules.composeEffective(
      snapshot.config.acodeBuiltinModelRules,
      personalRules,
    ).resolve({
      providerId: input.providerId,
      templateId: provider.templateId,
      modelId: input.modelId,
      apiType: provider.config.api?.type,
      baseUrl: provider.config.api?.baseUrl,
    });
    return Object.freeze({
      inheritedConfig: inheritedConfig.toJSON(),
      effectiveConfig: config.toJSON(),
      issues: Object.freeze([
        ...config.validateComplete(["providers", input.providerId, "models", input.modelId]),
      ]),
    });
  }

  onDidChange(listener: (view: ProviderSettingsView) => void): () => void {
    return this.#source.onDidChange(() => listener(this.getView()));
  }

  createPersonalProvider(input?: {
    readonly templateId?: ProviderTemplateId;
    readonly providerName?: string;
    readonly locale?: ProviderTemplateLocale;
    readonly initialConfig?: ProviderConfigObject;
  }): Promise<ProviderSettingsCreationResult> {
    return this.#mutateWithResult("create-provider", (target) =>
      target.createPersonalProvider({
        ...(input?.templateId ? { templateId: input.templateId } : {}),
        ...(input?.providerName ? { providerName: input.providerName } : {}),
        ...(input?.locale ? { locale: input.locale } : {}),
        ...(input?.initialConfig
          ? { initialConfig: parseProviderConfig(input.initialConfig) }
          : {}),
      }),
    ).then(({ result, view }) => ({ providerId: result.providerId, view }));
  }

  savePersonalProviderOverlay(
    providerId: ProviderId,
    config: ProviderConfigObject,
    metadata?: Pick<ProviderConfigRule, "providerName" | "templateId" | "enabled">,
  ): Promise<ProviderSettingsView> {
    return this.#mutateProvider(providerId, "save-provider", (target) =>
      target.savePersonalProviderOverlay(
        providerId,
        parseProviderConfig(config),
        this.#modelMembership(providerId),
        metadata,
      ),
    );
  }

  deletePersonalProvider(providerId: ProviderId): Promise<ProviderSettingsView> {
    return this.#mutateProvider(providerId, "delete-provider", (target) =>
      target.deletePersonalProvider(providerId),
    );
  }

  reorderPersonalProviders(providerIds: readonly ProviderId[]): Promise<ProviderSettingsView> {
    return this.#mutate("reorder-providers", (target) =>
      target.reorderPersonalProviders(providerIds),
    );
  }

  reorderPersonalModels(
    providerId: ProviderId,
    modelIds: readonly ModelId[],
  ): Promise<ProviderSettingsView> {
    return this.#mutateProvider(providerId, "reorder-models", (target) =>
      target.reorderPersonalModels(providerId, modelIds, this.#modelMembership(providerId)),
    );
  }

  addPersonalModel(
    providerId: ProviderId,
    modelId: ModelId,
    config: ModelConfigObject,
    useRecommendedConfig?: boolean,
  ): Promise<ProviderSettingsView> {
    return this.#mutateProvider(providerId, "add-model", (target) =>
      target.addPersonalModel(
        providerId,
        modelId,
        parseModelConfig(config),
        this.#modelMembership(providerId),
        useRecommendedConfig,
      ),
    );
  }

  /** 批量添加个人 Model（发现对话框确认路径）：单事务单 revision 守卫，语义见 config-service。 */
  addPersonalModels(
    providerId: ProviderId,
    modelIds: readonly ModelId[],
    useRecommendedConfig?: boolean,
  ): Promise<ProviderSettingsView> {
    return this.#mutateProvider(providerId, "add-models", (target) =>
      target.addPersonalModels(
        providerId,
        modelIds,
        this.#modelMembership(providerId),
        useRecommendedConfig,
      ),
    );
  }

  /**
   * 发现输入的宿主本地只读面（spec 同节）：从 Registry 内存视图取 baseUrl/api 类型/
   * 水合 apiKey（registry 下游 access.apiKey 读取先例同款）。baseUrl 缺席 → null
   * （UI 禁用按钮 / 服务层 no-base-url 错误）。api.type 缺席回落 openai-chat-completions
   * （与 BYO 表单默认同口径）。
   */
  readProviderDiscoveryInput(providerId: ProviderId): ProviderDiscoveryInput | null {
    const snapshot = requireSnapshot(this.#source);
    const provider = snapshot.registry.providers.find((item) => item.providerId === providerId);
    const baseUrl = provider?.config.api?.baseUrl?.trim();
    if (!provider || !baseUrl) return null;
    // access 是水合后的联合类型；仅 api-key 形态携带 apiKey，zhipu-account 等形态缺席即无 key。
    const access = provider.config.access as { apiKey?: unknown } | undefined;
    const apiKey =
      typeof access?.apiKey === "string" && access.apiKey.trim().length > 0
        ? access.apiKey
        : undefined;
    return {
      baseUrl,
      apiType: provider.config.api?.type ?? "openai-chat-completions",
      ...(apiKey ? { apiKey } : {}),
    };
  }

  renamePersonalModel(
    providerId: ProviderId,
    currentModelId: ModelId,
    nextModelId: ModelId,
  ): Promise<ProviderSettingsView> {
    return this.#mutateProvider(providerId, "rename-model", (target) =>
      target.renamePersonalModel(
        providerId,
        currentModelId,
        nextModelId,
        this.#modelMembership(providerId),
      ),
    );
  }

  deletePersonalModel(providerId: ProviderId, modelId: ModelId): Promise<ProviderSettingsView> {
    return this.#mutateProvider(providerId, "delete-personal-model", (target) =>
      target.deletePersonalModel(providerId, modelId, this.#modelMembership(providerId)),
    );
  }

  savePersonalModelDraft(input: SavePersonalModelDraftInput): Promise<ProviderSettingsView> {
    return this.#mutateProvider(input.providerId, "save-model-draft", async (target) => {
      const snapshot = requireSnapshot(this.#source);
      if (snapshot.registry.revision !== input.basedOnRevision) {
        throw new Error(
          `Provider Settings revision conflict: expected ${input.basedOnRevision}, current ${snapshot.registry.revision}`,
        );
      }
      const parsedConfig = parseModelConfig(input.personalConfig);
      await target.savePersonalModelDraft(
        input.providerId,
        input.originalModelId,
        input.nextModelId,
        parsedConfig,
        snapshot.config.personalRevision,
        input.useRecommendedConfig,
        this.#modelMembership(input.providerId, snapshot),
      );
    });
  }

  setPersonalModelEnabled(
    providerId: ProviderId,
    modelId: ModelId,
    enabled: boolean,
  ): Promise<ProviderSettingsView> {
    return this.#mutateProvider(providerId, "set-model-enabled", (target) =>
      target.setPersonalModelEnabled(
        providerId,
        modelId,
        enabled,
        this.#modelMembership(providerId),
      ),
    );
  }

  #modelMembership(
    providerId: ProviderId,
    snapshot = requireSnapshot(this.#source),
  ): ProviderModelMembership {
    const provider = snapshot.resolution.resolvedProviders.find(
      (item) => item.providerId === providerId,
    );
    if (!provider) throw new Error(`Provider 不存在: ${providerId}`);
    // 配置成员与可执行模型不是同一名单：禁用、无权益和不完整模型仍可编辑。
    // Account 的空/替换名单也必须原样使用，不能再与静态 Built-in 取并集。
    return Object.freeze({
      providerId,
      inheritedModelIds: Object.freeze(
        provider.models.filter((model) => model.source === "builtin").map((model) => model.modelId),
      ),
      personalRevision: snapshot.config.personalRevision,
      assertCurrent: () => {
        if (this.#source.getSnapshot() !== snapshot)
          throw new Error("Provider Settings snapshot revision conflict");
      },
    });
  }

  async #mutate(
    reason: string,
    operation: (target: ProviderSettingsMutationTarget) => Promise<unknown>,
  ): Promise<ProviderSettingsView> {
    if (!this.#mutations) throw new Error("ProviderSettingsFacade 未配置写入目标");
    await operation(this.#mutations);
    await this.#mutations.refresh(`settings:${reason}`);
    return this.getView();
  }

  #mutateProvider(
    providerId: ProviderId,
    reason: string,
    operation: (target: ProviderSettingsMutationTarget) => Promise<unknown>,
  ): Promise<ProviderSettingsView> {
    const previous = this.#providerMutationTails.get(providerId) ?? Promise.resolve();
    const waitForPrevious = previous.catch(() => undefined);
    const result = waitForPrevious.then(() => this.#mutate(reason, operation));
    this.#providerMutationTails.set(providerId, result);
    const cleanup = () => {
      if (this.#providerMutationTails.get(providerId) === result) {
        this.#providerMutationTails.delete(providerId);
      }
    };
    void result.then(cleanup, cleanup);
    return result;
  }

  async waitForProviderOperations(providerId: ProviderId): Promise<void> {
    await this.#providerMutationTails.get(providerId);
  }

  async #mutateWithResult<TResult>(
    reason: string,
    operation: (target: ProviderSettingsMutationTarget) => Promise<TResult>,
  ): Promise<{ readonly result: TResult; readonly view: ProviderSettingsView }> {
    if (!this.#mutations) throw new Error("ProviderSettingsFacade 未配置写入目标");
    const result = await operation(this.#mutations);
    await this.#mutations.refresh(`settings:${reason}`);
    return { result, view: this.getView() };
  }
}
