// 2026-12-31 例外债务偿还：原 811 行 config-service.ts 按职责拆为 4 个叶子（均 <400 行），
// 首行 oxlint max-lines 抑制头注随拆分删除：
// - config-service-types.ts          契约类型族（7 个公开接口 + 内部 OpsContext）
// - config-service-helpers.ts        纯函数 helper 族（成员守卫/规范化/基线解析/命名）
// - config-service-provider-ops.ts   Provider 生命周期方法族（保存/创建/删除/调序）
// - config-service-model-ops.ts      Model 成员与草稿方法族（调序/添加/重命名/启停/草稿/删除）
// ProviderConfigService 类本体保留生命周期与事务私有方法；11 个领域方法逐字保留签名，
// 一行委托到对应方法族叶子（函数体逐字外迁，仅 this.#x 私有访问机械改写为 context 同名能力）。
// 公开导出面逐名不变：7 个接口经下方 export type 原地 re-export。
import type {
  ModelConfig,
  ModelId,
  ProviderConfig,
  ProviderId,
  ProviderConfigRule,
} from "./config/index.js";
import { ProviderTemplateMap } from "./config/index.js";
import type { ProviderConfigSnapshot, ProviderSource } from "./sources.js";
import type {
  CreatePersonalProviderInput,
  PersonalProviderConfigRepository,
  PersonalProviderCreation,
  ProviderConfigLayerSnapshot,
  ProviderConfigLayerUpdate,
  ProviderConfigServiceDependencies,
  ProviderConfigServiceOpsContext,
  ProviderModelMembership,
} from "./config-service-types.js";
import {
  createPersonalProvider,
  deletePersonalProvider,
  reorderPersonalProviders,
  savePersonalProviderOverlay,
} from "./config-service-provider-ops.js";
import {
  addPersonalModel,
  addPersonalModels,
  deletePersonalModel,
  renamePersonalModel,
  reorderPersonalModels,
  savePersonalModelDraft,
  setPersonalModelEnabled,
} from "./config-service-model-ops.js";

export type {
  CreatePersonalProviderInput,
  PersonalProviderConfigRepository,
  PersonalProviderCreation,
  ProviderConfigLayerSnapshot,
  ProviderConfigLayerUpdate,
  ProviderConfigServiceDependencies,
  ProviderModelMembership,
} from "./config-service-types.js";

export class ProviderConfigService implements ProviderSource<ProviderConfigSnapshot> {
  readonly #acodeBuiltinSource: ProviderSource<ProviderConfigLayerSnapshot>;
  readonly #personalRepository: PersonalProviderConfigRepository;
  readonly #listeners = new Set<(reason: string) => void>();
  readonly #sourceDisposers: Array<() => void>;
  #disposed = false;
  /** 2026-12-31 例外债务偿还：方法族叶子的协作上下文，能力与原私有成员一一对应。 */
  readonly #ops: ProviderConfigServiceOpsContext;

  constructor(dependencies: ProviderConfigServiceDependencies) {
    this.#acodeBuiltinSource = dependencies.acodeBuiltinSource;
    this.#personalRepository = dependencies.personalRepository;
    this.#sourceDisposers = [
      this.#acodeBuiltinSource.onDidChange((reason) => this.#emit(`acodeBuiltin:${reason}`)),
      this.#personalRepository.onDidChange((reason) => this.#emit(`personal:${reason}`)),
    ];
    this.#ops = {
      acodeBuiltinSource: this.#acodeBuiltinSource,
      personalRepository: this.#personalRepository,
      updatePersonal: (transform) => this.#updatePersonal(transform),
    };
  }

  async read(): Promise<ProviderConfigSnapshot> {
    this.#assertNotDisposed();
    const [acodeBuiltin, personal] = await Promise.all([
      this.#acodeBuiltinSource.read(),
      this.#personalRepository.read(),
    ]);
    return Object.freeze({
      revision: JSON.stringify([acodeBuiltin.revision, personal.revision]),
      acodeBuiltinRevision: acodeBuiltin.revision,
      personalRevision: personal.revision,
      acodeBuiltinProviders: acodeBuiltin.providers,
      acodeBuiltinProviderTemplates: acodeBuiltin.providerTemplates ?? ProviderTemplateMap.empty(),
      personalProviders: personal.providers,
      acodeBuiltinModelRules: acodeBuiltin.models,
      personalModels: personal.models,
      personalProviderOrder: personal.providerOrder ?? [],
    });
  }

  onDidChange(listener: (reason: string) => void): () => void {
    this.#assertNotDisposed();
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** 仅供版本迁移或事实源 cutover 原子替换完整 Personal Overlay。 */
  replacePersonalConfig(config: ProviderConfigLayerUpdate): Promise<ProviderConfigLayerSnapshot> {
    this.#assertNotDisposed();
    // 全量导入/分发与字段编辑不同；新信封未带默认选择时必须清除，不能继承接收端旧值。
    return this.#personalRepository.update(() => config);
  }

  async savePersonalProviderOverlay(
    providerId: ProviderId,
    config: ProviderConfig,
    membership?: ProviderModelMembership,
    metadata?: Pick<ProviderConfigRule, "providerName" | "templateId" | "enabled">,
  ): Promise<ProviderConfigLayerSnapshot> {
    return savePersonalProviderOverlay(this.#ops, providerId, config, membership, metadata);
  }

  async createPersonalProvider(
    input: CreatePersonalProviderInput = {},
  ): Promise<PersonalProviderCreation> {
    return createPersonalProvider(this.#ops, input);
  }

  deletePersonalProvider(providerId: ProviderId): Promise<ProviderConfigLayerSnapshot> {
    return deletePersonalProvider(this.#ops, providerId);
  }

  async reorderPersonalProviders(
    providerIds: readonly ProviderId[],
  ): Promise<ProviderConfigLayerSnapshot> {
    return reorderPersonalProviders(this.#ops, providerIds);
  }

  async reorderPersonalModels(
    providerId: ProviderId,
    modelIds: readonly ModelId[],
    membership?: ProviderModelMembership,
  ): Promise<ProviderConfigLayerSnapshot> {
    return reorderPersonalModels(this.#ops, providerId, modelIds, membership);
  }

  async addPersonalModel(
    providerId: ProviderId,
    modelId: ModelId,
    config: ModelConfig,
    membership?: ProviderModelMembership,
    useRecommendedConfig?: boolean,
  ): Promise<ProviderConfigLayerSnapshot> {
    return addPersonalModel(this.#ops, providerId, modelId, config, membership, useRecommendedConfig);
  }

  async addPersonalModels(
    providerId: ProviderId,
    modelIds: readonly ModelId[],
    membership?: ProviderModelMembership,
    useRecommendedConfig?: boolean,
  ): Promise<ProviderConfigLayerSnapshot> {
    return addPersonalModels(this.#ops, providerId, modelIds, membership, useRecommendedConfig);
  }

  async renamePersonalModel(
    providerId: ProviderId,
    currentModelId: ModelId,
    nextModelId: ModelId,
    membership?: ProviderModelMembership,
  ): Promise<ProviderConfigLayerSnapshot> {
    return renamePersonalModel(this.#ops, providerId, currentModelId, nextModelId, membership);
  }

  async setPersonalModelEnabled(
    providerId: ProviderId,
    modelId: ModelId,
    enabled: boolean,
    membership?: ProviderModelMembership,
  ): Promise<ProviderConfigLayerSnapshot> {
    return setPersonalModelEnabled(this.#ops, providerId, modelId, enabled, membership);
  }

  async savePersonalModelDraft(
    providerId: ProviderId,
    originalModelId: ModelId,
    nextModelId: ModelId,
    config: ModelConfig,
    expectedPersonalRevision: string,
    useRecommendedConfig?: boolean,
    membership?: ProviderModelMembership,
  ): Promise<ProviderConfigLayerSnapshot> {
    return savePersonalModelDraft(
      this.#ops,
      providerId,
      originalModelId,
      nextModelId,
      config,
      expectedPersonalRevision,
      useRecommendedConfig,
      membership,
    );
  }

  async deletePersonalModel(
    providerId: ProviderId,
    modelId: ModelId,
    membership?: ProviderModelMembership,
  ): Promise<ProviderConfigLayerSnapshot> {
    return deletePersonalModel(this.#ops, providerId, modelId, membership);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const dispose of this.#sourceDisposers.splice(0)) dispose();
    this.#listeners.clear();
  }

  #updatePersonal(
    transform: (current: ProviderConfigLayerSnapshot) => ProviderConfigLayerUpdate,
  ): Promise<ProviderConfigLayerSnapshot> {
    this.#assertNotDisposed();
    return this.#personalRepository.update((current) => ({
      // Provider/Model/排序只修改自己的成员，不能因共用文件清掉默认选择。
      defaultModelSelection: current.defaultModelSelection,
      ...transform(current),
    }));
  }

  #emit(reason: string): void {
    if (this.#disposed) return;
    for (const listener of this.#listeners) listener(reason || "changed");
  }

  #assertNotDisposed(): void {
    if (this.#disposed) throw new Error("ProviderConfigService 已 dispose");
  }
}
