// 2026-12-31 例外债务偿还：自 config-service.ts 按方法族拆出 —— Provider 生命周期操作族
// （Overlay 保存 / 创建 / 删除 / 调序）。函数体逐字迁移，仅把原类内私有访问
// `this.#acodeBuiltinSource` / `#personalRepository` / `#updatePersonal` 机械改写为
// 首参 context 的同名能力（见 config-service-types.ts ProviderConfigServiceOpsContext），
// 领域逻辑、校验顺序与注释一字未动；ProviderConfigService 同名方法逐字保留签名并一行委托。
import {
  ApiKeyAccessConfig,
  ProviderConfig as ProviderConfigValue,
  resolveProviderTemplateName,
} from "./config/index.js";
import type {
  ProviderConfig,
  ProviderConfigRule,
  ProviderId,
} from "./config/index.js";
import type {
  CreatePersonalProviderInput,
  PersonalProviderCreation,
  ProviderConfigLayerSnapshot,
  ProviderConfigServiceOpsContext,
  ProviderModelMembership,
} from "./config-service-types.js";
import {
  appendCurrentProviderOrder,
  assertMembershipCurrent,
  assertNonEmptyId,
  assertProviderLabelMutationIsUnique,
  nextPersonalProviderId,
  nextPersonalProviderLabel,
  normalizePersonalProviderMembership,
  normalizeProviderOrder,
  resolvePersonalProviderBaselines,
  resolveTemplateBaseline,
} from "./config-service-helpers.js";

export async function savePersonalProviderOverlay(
  context: ProviderConfigServiceOpsContext,
  providerId: ProviderId,
  config: ProviderConfig,
  membership?: ProviderModelMembership,
  metadata?: Pick<ProviderConfigRule, "providerName" | "templateId" | "enabled">,
): Promise<ProviderConfigLayerSnapshot> {
  assertNonEmptyId("providerId", providerId);
  const acodeBuiltin = await context.acodeBuiltinSource.read();
  return context.updatePersonal((current) => {
    assertMembershipCurrent(membership, providerId, current);
    const builtin = acodeBuiltin.providers.get(providerId);
    const currentPersonal = current.providers.get(providerId);
    const currentEffectiveProviders = acodeBuiltin.providers.overlay(current.providers);
    // 账号总禁用已撤销；在公共写入边界拒绝新操作，避免隐藏 UI 后仍能写出无效状态。
    if (builtin?.access?.type === "zhipu-account" && metadata?.enabled === false) {
      throw new Error(`Account Provider 不允许禁用: ${providerId}`);
    }
    if (builtin?.access?.type === "zhipu-account" && config.access !== undefined) {
      // 通用保存入口只解析 ProviderConfig，曾绕过 Personal Source Schema，
      // 允许固定 Account Provider 的 access 被写盘，直到下次读取才整份拒绝。
      throw new Error(
        `固定 Account Provider 的 Access 只能由 ACode Built-in Config 声明: ${providerId}`,
      );
    }
    // 普通保存曾同时承担创建语义，删除后的迟到保存可以凭空复活 Overlay。
    // 创建已经是明确的领域操作，普通保存只更新现有配置，不存在即拒绝。
    if (!currentPersonal && !builtin) {
      throw new Error(`Personal Provider 尚未创建: ${providerId}`);
    }
    let normalized = config;
    if (builtin) {
      if (normalized.group != null && normalized.group !== builtin.group) {
        throw new Error(`Personal Overlay 不能改写 Built-in Provider group: ${providerId}`);
      }
      normalized = normalized.withoutGroup();
    } else {
      const group = normalized.group ?? currentPersonal?.group;
      if (group !== "standard-personal") {
        throw new Error(`Personal-only Provider 必须使用 standard-personal group: ${providerId}`);
      }
      normalized = normalized.overlay(new ProviderConfigValue({ group }));
    }
    const membershipBaseline =
      builtin ?? resolveTemplateBaseline(acodeBuiltin, current.providers, providerId);
    const next = normalized.withModelMembershipFrom(
      // 普通 Provider 保存也保留动态成员顺序；不能改名称时又按静态名单删掉已保存的调序。
      normalizePersonalProviderMembership(
        currentPersonal,
        membershipBaseline,
        membership?.inheritedModelIds,
      ),
    );
    const currentRule = current.providers.getRule(providerId);
    const providers = current.providers.setRule({
      ...currentRule,
      providerId,
      ...(metadata?.templateId === undefined ? {} : { templateId: metadata.templateId }),
      ...(metadata?.enabled === undefined ? {} : { enabled: metadata.enabled }),
      ...(metadata?.providerName === undefined
        ? {}
        : { providerName: metadata.providerName?.trim() || null }),
      config: next,
    });
    const nextEffectiveProviders = acodeBuiltin.providers.overlay(providers);
    // 旧版本可能已经留下重名 Provider。全量校验会让这些历史问题阻断
    // 任意无关 Provider 的保存；这里仅禁止本次名称变更新引入重名。
    assertProviderLabelMutationIsUnique(
      providerId,
      currentEffectiveProviders,
      nextEffectiveProviders,
    );
    return {
      providers,
      models: current.models,
      providerOrder: current.providerOrder,
    };
  });
}

export async function createPersonalProvider(
  context: ProviderConfigServiceOpsContext,
  input: CreatePersonalProviderInput = {},
): Promise<PersonalProviderCreation> {
  const acodeBuiltin = await context.acodeBuiltinSource.read();
  const templateId = input.templateId?.trim();
  const template = templateId ? acodeBuiltin.providerTemplates?.get(templateId) : undefined;
  if (templateId && !template) throw new Error(`Provider Template 不存在: ${templateId}`);
  if (input.initialConfig?.group !== undefined) {
    throw new Error("initialConfig 不能包含 group");
  }
  if (input.initialConfig?.builtinModelIds !== undefined) {
    throw new Error("initialConfig 不能包含 builtinModelIds");
  }
  let createdProviderId: ProviderId | undefined;
  await context.updatePersonal((current) => {
    const occupied = new Set([...acodeBuiltin.providers.keys(), ...current.providers.keys()]);
    const providerId = nextPersonalProviderId(occupied, templateId);
    createdProviderId = providerId;
    const effectiveProviders = resolvePersonalProviderBaselines(acodeBuiltin, current.providers);
    const label = nextPersonalProviderLabel(
      input.providerName ??
        (template && templateId
          ? resolveProviderTemplateName(templateId, template, input.locale ?? "en-US")
          : "new-provider"),
      effectiveProviders,
    );
    const initial = input.initialConfig ?? new ProviderConfigValue();
    const providers = current.providers.setRule({
      providerId,
      ...(templateId ? { templateId } : {}),
      providerName: label,
      config: new ProviderConfigValue({
        group: "standard-personal",
        access: templateId ? undefined : new ApiKeyAccessConfig(),
        personalModelIds: [],
        modelOrder: [],
      }).overlay(initial),
    });
    return {
      providers,
      models: current.models,
      providerOrder: appendCurrentProviderOrder(
        acodeBuiltin.providers,
        providers,
        current.providerOrder,
        providerId,
      ),
    };
  });
  if (!createdProviderId) throw new Error("Personal Provider 创建失败");
  return Object.freeze({ providerId: createdProviderId });
}

export function deletePersonalProvider(
  context: ProviderConfigServiceOpsContext,
  providerId: ProviderId,
): Promise<ProviderConfigLayerSnapshot> {
  assertNonEmptyId("providerId", providerId);
  return context.updatePersonal((current) => ({
    providers: current.providers.delete(providerId),
    models: current.models.deleteExactForProvider(providerId),
    providerOrder: current.providerOrder?.filter((candidate) => candidate !== providerId),
  }));
}

export async function reorderPersonalProviders(
  context: ProviderConfigServiceOpsContext,
  providerIds: readonly ProviderId[],
): Promise<ProviderConfigLayerSnapshot> {
  const acodeBuiltin = await context.acodeBuiltinSource.read();
  return context.updatePersonal((current) => ({
    providers: current.providers,
    models: current.models,
    providerOrder: normalizeProviderOrder(acodeBuiltin.providers, current.providers, providerIds),
  }));
}
