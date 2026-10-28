// 2026-12-31 例外债务偿还：自 config-service.ts 按方法族拆出 —— Model 成员与草稿操作族
// （调序 / 单个与批量添加 / 重命名 / 启停 / 草稿保存 / 删除）。函数体逐字迁移，
// 仅把原类内私有访问 `this.#acodeBuiltinSource` / `#personalRepository` / `#updatePersonal`
// 机械改写为首参 context 的同名能力（见 config-service-types.ts
// ProviderConfigServiceOpsContext），领域逻辑、校验顺序与注释一字未动；
// ProviderConfigService 同名方法逐字保留签名并一行委托。
import { ModelConfig } from "./config/index.js";
import type { ModelId, ProviderId } from "./config/index.js";
import type {
  ProviderConfigLayerSnapshot,
  ProviderConfigServiceOpsContext,
  ProviderModelMembership,
} from "./config-service-types.js";
import {
  assertMembershipCurrent,
  assertNonEmptyId,
  isStructurallyEmpty,
  normalizeId,
  normalizeModelOrder,
  resolveProviderBuiltinModelIds,
  resolveTemplateBaseline,
  writableProviderOverlay,
} from "./config-service-helpers.js";

export async function reorderPersonalModels(
  context: ProviderConfigServiceOpsContext,
  providerId: ProviderId,
  modelIds: readonly ModelId[],
  membership?: ProviderModelMembership,
): Promise<ProviderConfigLayerSnapshot> {
  assertNonEmptyId("providerId", providerId);
  const acodeBuiltin = await context.acodeBuiltinSource.read();
  return context.updatePersonal((current) => {
    assertMembershipCurrent(membership, providerId, current);
    const builtinProvider =
      acodeBuiltin.providers.get(providerId) ??
      resolveTemplateBaseline(acodeBuiltin, current.providers, providerId);
    const provider = writableProviderOverlay(acodeBuiltin, current, providerId);
    const modelOrder = normalizeModelOrder(
      membership?.inheritedModelIds ?? builtinProvider?.builtinModelIds ?? [],
      provider.personalModelIds ?? [],
      modelIds,
    );
    return {
      providers: current.providers.set(providerId, provider.withModelOrder(modelOrder)),
      models: current.models,
      providerOrder: current.providerOrder,
    };
  });
}

export async function addPersonalModel(
  context: ProviderConfigServiceOpsContext,
  providerId: ProviderId,
  modelId: ModelId,
  config: ModelConfig,
  membership?: ProviderModelMembership,
  useRecommendedConfig?: boolean,
): Promise<ProviderConfigLayerSnapshot> {
  const normalizedProviderId = normalizeId("providerId", providerId);
  const normalizedModelId = normalizeId("modelId", modelId);
  const acodeBuiltin = await context.acodeBuiltinSource.read();
  return context.updatePersonal((current) => {
    assertMembershipCurrent(membership, normalizedProviderId, current);
    const provider = writableProviderOverlay(acodeBuiltin, current, normalizedProviderId);
    const builtinModelIds =
      membership?.inheritedModelIds ??
      resolveProviderBuiltinModelIds(acodeBuiltin, current.providers, normalizedProviderId);
    if (builtinModelIds.includes(normalizedModelId)) {
      throw new Error(`Model 已存在: ${normalizedProviderId}/${normalizedModelId}`);
    }
    const currentModelIds = provider.personalModelIds ?? [];
    if (currentModelIds.includes(normalizedModelId)) {
      throw new Error(`Model 已存在: ${normalizedProviderId}/${normalizedModelId}`);
    }
    return {
      providers: current.providers.set(
        normalizedProviderId,
        provider.withPersonalModelIds([...currentModelIds, normalizedModelId]).withModelOrder(
          // 添加不能重新按成员名单排序，否则会丢掉用户已经保存的顺序。
          normalizeModelOrder(
            builtinModelIds,
            [...currentModelIds, normalizedModelId],
            provider.modelOrder ?? [],
          ),
        ),
      ),
      models: current.models.setExact(
        normalizedProviderId,
        normalizedModelId,
        config.overlay(new ModelConfig({ enabled: true })),
        useRecommendedConfig,
      ),
      providerOrder: current.providerOrder,
    };
  });
}

/**
 * 批量添加个人 Model（packages/services/specs/provider-model-discovery.md）：
 * 单次 #updatePersonal 事务 = 单次 revision 守卫（与 addPersonalModel 同口径）；
 * 任一批内 id 与 builtin/既有 personal 重复 → 整批拒绝（UI 预筛之外的服务端双闸）；
 * 序尾追加不重排既有顺序；配置走推荐档解析（overlay 仅 enabled，不猜窗口/上限）。
 */
export async function addPersonalModels(
  context: ProviderConfigServiceOpsContext,
  providerId: ProviderId,
  modelIds: readonly ModelId[],
  membership?: ProviderModelMembership,
  useRecommendedConfig?: boolean,
): Promise<ProviderConfigLayerSnapshot> {
  const normalizedProviderId = normalizeId("providerId", providerId);
  const normalizedModelIds = Array.from(
    new Set(modelIds.map((modelId) => normalizeId("modelId", modelId))),
  );
  if (normalizedModelIds.length === 0) return context.personalRepository.read();
  const acodeBuiltin = await context.acodeBuiltinSource.read();
  return context.updatePersonal((current) => {
    assertMembershipCurrent(membership, normalizedProviderId, current);
    const provider = writableProviderOverlay(acodeBuiltin, current, normalizedProviderId);
    const builtinModelIds =
      membership?.inheritedModelIds ??
      resolveProviderBuiltinModelIds(acodeBuiltin, current.providers, normalizedProviderId);
    const currentModelIds = provider.personalModelIds ?? [];
    for (const modelId of normalizedModelIds) {
      if (builtinModelIds.includes(modelId) || currentModelIds.includes(modelId)) {
        throw new Error(`Model 已存在: ${normalizedProviderId}/${modelId}`);
      }
    }
    const nextModelIds = [...currentModelIds, ...normalizedModelIds];
    let nextModels = current.models;
    for (const modelId of normalizedModelIds) {
      nextModels = nextModels.setExact(
        normalizedProviderId,
        modelId,
        new ModelConfig({ enabled: true }),
        useRecommendedConfig,
      );
    }
    return {
      providers: current.providers.set(
        normalizedProviderId,
        provider.withPersonalModelIds(nextModelIds).withModelOrder(
          // 添加不能重新按成员名单排序，否则会丢掉用户已经保存的顺序。
          normalizeModelOrder(builtinModelIds, nextModelIds, provider.modelOrder ?? []),
        ),
      ),
      models: nextModels,
      providerOrder: current.providerOrder,
    };
  });
}

export async function renamePersonalModel(
  context: ProviderConfigServiceOpsContext,
  providerId: ProviderId,
  currentModelId: ModelId,
  nextModelId: ModelId,
  membership?: ProviderModelMembership,
): Promise<ProviderConfigLayerSnapshot> {
  const normalizedProviderId = normalizeId("providerId", providerId);
  const currentId = normalizeId("modelId", currentModelId);
  const nextId = normalizeId("modelId", nextModelId);
  if (currentId === nextId) return context.personalRepository.read();
  const acodeBuiltin = await context.acodeBuiltinSource.read();
  return context.updatePersonal((current) => {
    assertMembershipCurrent(membership, normalizedProviderId, current);
    const provider = current.providers.get(normalizedProviderId);
    const builtinModelIds =
      membership?.inheritedModelIds ??
      resolveProviderBuiltinModelIds(acodeBuiltin, current.providers, normalizedProviderId);
    // 继承归属保护适用于 Facade 和底层直接调用，不能只在有动态上下文时检查。
    if (builtinModelIds.includes(currentId))
      throw new Error(`Built-in Model 不能重命名: ${normalizedProviderId}/${currentId}`);
    if (!provider?.personalModelIds?.includes(currentId)) {
      throw new Error(`Personal Model 不存在: ${normalizedProviderId}/${currentId}`);
    }
    if (provider.personalModelIds.includes(nextId)) {
      throw new Error(`Model 已存在: ${normalizedProviderId}/${nextId}`);
    }
    if (builtinModelIds.includes(nextId)) {
      throw new Error(`Model 已存在: ${normalizedProviderId}/${nextId}`);
    }
    const modelIds = provider.personalModelIds.map((modelId) =>
      modelId === currentId ? nextId : modelId,
    );
    const requestedOrder = (provider.modelOrder ?? []).map((modelId) =>
      modelId === currentId ? nextId : modelId,
    );
    return {
      providers: current.providers.set(
        normalizedProviderId,
        provider
          .withPersonalModelIds(modelIds)
          .withModelOrder(normalizeModelOrder(builtinModelIds, modelIds, requestedOrder)),
      ),
      models: current.models.renameExactModel(normalizedProviderId, currentId, nextId),
      providerOrder: current.providerOrder,
    };
  });
}

export async function setPersonalModelEnabled(
  context: ProviderConfigServiceOpsContext,
  providerId: ProviderId,
  modelId: ModelId,
  enabled: boolean,
  membership?: ProviderModelMembership,
): Promise<ProviderConfigLayerSnapshot> {
  const id = normalizeId("providerId", providerId);
  const model = normalizeId("modelId", modelId);
  if (typeof enabled !== "boolean") throw new Error("Model enabled 必须是 boolean");
  const builtin = await context.acodeBuiltinSource.read();
  return context.updatePersonal((current) => {
    assertMembershipCurrent(membership, id, current);
    const provider = current.providers.get(id);
    const inherited =
      membership?.inheritedModelIds ??
      resolveProviderBuiltinModelIds(builtin, current.providers, id);
    if (!inherited.includes(model) && !provider?.personalModelIds?.includes(model)) {
      throw new Error(`Model 不存在: ${id}/${model}`);
    }
    // 启停曾复用完整草稿保存，可能覆盖其他编辑或被固定配置完整性阻挡。
    // 在事务内只修改最新 enabled；不改变模式、成员和其他模型字段。
    const config = (current.models.getExact(id, model) ?? new ModelConfig({})).overlay(
      new ModelConfig({ enabled }),
    );
    return {
      providers: current.providers,
      models: current.models.setExact(id, model, config),
      providerOrder: current.providerOrder,
    };
  });
}

/** Model 编辑弹窗的唯一写入边界：成员、顺序、精确 Rule 在同一次 Repository update 中提交。 */
export async function savePersonalModelDraft(
  context: ProviderConfigServiceOpsContext,
  providerId: ProviderId,
  originalModelId: ModelId,
  nextModelId: ModelId,
  config: ModelConfig,
  expectedPersonalRevision: string,
  useRecommendedConfig?: boolean,
  membership?: ProviderModelMembership,
): Promise<ProviderConfigLayerSnapshot> {
  const normalizedProviderId = normalizeId("providerId", providerId);
  const originalId = normalizeId("modelId", originalModelId);
  const nextId = normalizeId("modelId", nextModelId);
  const acodeBuiltin = await context.acodeBuiltinSource.read();
  return context.updatePersonal((current) => {
    assertMembershipCurrent(membership, normalizedProviderId, current);
    if (current.revision !== expectedPersonalRevision) {
      throw new Error(
        `Personal Provider Config revision conflict: expected ${expectedPersonalRevision}, current ${current.revision}`,
      );
    }
    const recommended =
      useRecommendedConfig ??
      current.models.getExactRule(normalizedProviderId, originalId)?.type !==
        "manual-provider-model";
    const provider = current.providers.get(normalizedProviderId);
    const builtinModelIds =
      membership?.inheritedModelIds ??
      resolveProviderBuiltinModelIds(acodeBuiltin, current.providers, normalizedProviderId);
    const builtinSet = new Set(builtinModelIds);
    if (originalId !== nextId && builtinSet.has(originalId)) {
      throw new Error(`Built-in Model 不能重命名: ${normalizedProviderId}/${originalId}`);
    }
    if (originalId !== nextId && builtinSet.has(nextId)) {
      throw new Error(`Model 已存在: ${normalizedProviderId}/${nextId}`);
    }
    const personalModelIds = provider?.personalModelIds ?? [];
    const originalExists = builtinSet.has(originalId) || personalModelIds.includes(originalId);
    if (!originalExists) {
      throw new Error(`Model 不存在: ${normalizedProviderId}/${originalId}`);
    }
    if (originalId !== nextId && (personalModelIds.includes(nextId) || builtinSet.has(nextId))) {
      throw new Error(`Model 已存在: ${normalizedProviderId}/${nextId}`);
    }

    let providers = current.providers;
    let models = current.models;
    if (originalId !== nextId) {
      if (!provider?.personalModelIds?.includes(originalId)) {
        throw new Error(`Personal Model 不存在: ${normalizedProviderId}/${originalId}`);
      }
      const modelIds = provider.personalModelIds.map((modelId) =>
        modelId === originalId ? nextId : modelId,
      );
      const requestedOrder = (provider.modelOrder ?? []).map((modelId) =>
        modelId === originalId ? nextId : modelId,
      );
      providers = providers.set(
        normalizedProviderId,
        provider
          .withPersonalModelIds(modelIds)
          .withModelOrder(normalizeModelOrder(builtinModelIds, modelIds, requestedOrder)),
      );
      models = models.renameExactModel(normalizedProviderId, originalId, nextId);
    }
    models =
      recommended && isStructurallyEmpty(config.toJSON())
        ? models.deleteExact(normalizedProviderId, nextId)
        : models.setExact(normalizedProviderId, nextId, config, recommended);
    return { providers, models, providerOrder: current.providerOrder };
  });
}

export async function deletePersonalModel(
  context: ProviderConfigServiceOpsContext,
  providerId: ProviderId,
  modelId: ModelId,
  membership?: ProviderModelMembership,
): Promise<ProviderConfigLayerSnapshot> {
  const normalizedProviderId = normalizeId("providerId", providerId);
  const normalizedModelId = normalizeId("modelId", modelId);
  const builtin = await context.acodeBuiltinSource.read();
  return context.updatePersonal((current) => {
    assertMembershipCurrent(membership, normalizedProviderId, current);
    const provider = current.providers.get(normalizedProviderId);
    const inherited =
      membership?.inheritedModelIds ??
      resolveProviderBuiltinModelIds(builtin, current.providers, normalizedProviderId);
    if (inherited.includes(normalizedModelId))
      throw new Error(`Built-in Model 不能删除: ${normalizedProviderId}/${normalizedModelId}`);
    if (!provider?.personalModelIds?.includes(normalizedModelId)) {
      throw new Error(`Personal Model 不存在: ${normalizedProviderId}/${normalizedModelId}`);
    }
    return {
      providers: current.providers.set(
        normalizedProviderId,
        provider
          .withPersonalModelIds(
            provider.personalModelIds.filter((candidate) => candidate !== normalizedModelId),
          )
          .withModelOrder(
            normalizeModelOrder(
              inherited,
              provider.personalModelIds.filter((candidate) => candidate !== normalizedModelId),
              provider.modelOrder ?? [],
            ),
          ),
      ),
      models: current.models.deleteExact(normalizedProviderId, normalizedModelId),
      providerOrder: current.providerOrder,
    };
  });
}
