// 2026-12-31 例外债务偿还：自 config-service.ts 按职责拆出 —— 配置服务纯函数 helper 族
// （成员守卫、可写 Overlay 解析、ID/顺序规范化、模板基线与内置成员解析、标签唯一性与命名）。
// 逐字迁移（仅补 export 供服务本体与方法族叶子复用），行为零改动。
import { ProviderConfig as ProviderConfigValue } from "./config/index.js";
import type {
  ModelId,
  ProviderConfig,
  ProviderConfigMap,
  ProviderId,
  ProviderTemplateId,
} from "./config/index.js";
import { resolveOwnedOrder } from "./owned-order.js";
import type {
  ProviderConfigLayerSnapshot,
  ProviderModelMembership,
} from "./config-service-types.js";

export function assertMembershipCurrent(
  membership: ProviderModelMembership | undefined,
  providerId: ProviderId,
  current: ProviderConfigLayerSnapshot,
): void {
  if (!membership) return;
  membership.assertCurrent();
  if (membership.providerId !== providerId || membership.personalRevision !== current.revision) {
    throw new Error("Provider Settings membership revision conflict");
  }
}

/** Personal 根记录只是覆盖层，不是 Provider 存在性的依据；仅继承 Provider 可按需创建覆盖。 */
export function writableProviderOverlay(
  builtin: ProviderConfigLayerSnapshot,
  current: ProviderConfigLayerSnapshot,
  providerId: ProviderId,
): ProviderConfig {
  const provider = current.providers.get(providerId);
  if (provider) return provider;
  if (builtin.providers.has(providerId)) return new ProviderConfigValue({});
  // 已删除的自定义/模板实例没有继承 Provider 身份，迟到操作不能把它复活。
  throw new Error(`Provider 不存在: ${providerId}`);
}

export function isStructurallyEmpty(value: unknown): boolean {
  if (value === undefined) return true;
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.length === 0;
  return Object.values(value).every(isStructurallyEmpty);
}

export function assertProviderLabelMutationIsUnique(
  providerId: ProviderId,
  currentProviders: ProviderConfigMap,
  nextProviders: ProviderConfigMap,
): void {
  const currentLabel = currentProviders.getRule(providerId)?.providerName?.trim();
  const nextLabel = nextProviders.getRule(providerId)?.providerName?.trim();
  const currentKey = currentLabel?.toLocaleLowerCase();
  const nextKey = nextLabel?.toLocaleLowerCase();
  if (!nextKey || nextKey === currentKey) return;
  for (const candidate of nextProviders.rules()) {
    const candidateId = candidate.providerId;
    if (candidateId === providerId) continue;
    if (candidate.providerName?.trim().toLocaleLowerCase() === nextKey) {
      throw new Error(`Provider 名称已存在: ${nextLabel}`);
    }
  }
}

export function normalizePersonalProviderMembership(
  personal: ProviderConfig | undefined,
  builtin: ProviderConfig | undefined,
  inheritedModelIds?: readonly ModelId[],
): ProviderConfig | undefined {
  if (!personal) return undefined;
  const builtinModelIds = uniqueInOrder(inheritedModelIds ?? builtin?.builtinModelIds ?? []);
  const builtinSet = new Set(builtinModelIds);
  const personalModelIds = uniqueInOrder(personal.personalModelIds ?? []).filter(
    (modelId) => !builtinSet.has(modelId),
  );
  let normalized = personal.withPersonalModelIds(personalModelIds);
  if (personal.modelOrder !== undefined && personal.modelOrder !== null) {
    normalized = normalized.withModelOrder(
      normalizeModelOrder(builtinModelIds, personalModelIds, personal.modelOrder),
    );
  }
  return normalized;
}

export function assertNonEmptyId(label: string, value: string): void {
  if (!value.trim()) throw new Error(`${label} 不能为空`);
}

export function normalizeId(label: string, value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} 不能为空`);
  return normalized;
}

export function uniqueInOrder<T extends string>(values: readonly T[]): T[] {
  const result: T[] = [];
  for (const value of values) if (!result.includes(value)) result.push(value);
  return result;
}

export function normalizeProviderOrder(
  _acodeBuiltinProviders: ProviderConfigMap,
  personalProviders: ProviderConfigMap,
  requested: readonly ProviderId[],
): ProviderId[] {
  const personalIds = personalProviders
    .entries()
    .filter(([, config]) => config.group === "standard-personal")
    .map(([providerId]) => providerId);
  return [...resolveOwnedOrder([], personalIds, requested)];
}

export function appendCurrentProviderOrder(
  acodeBuiltinProviders: ProviderConfigMap,
  personalProviders: ProviderConfigMap,
  currentOrder: readonly ProviderId[] | undefined,
  addedProviderId: ProviderId,
): ProviderId[] {
  const current = normalizeProviderOrder(
    acodeBuiltinProviders,
    personalProviders,
    currentOrder ?? [],
  );
  return normalizeProviderOrder(acodeBuiltinProviders, personalProviders, [
    ...current.filter((providerId) => providerId !== addedProviderId),
    addedProviderId,
  ]);
}

export function normalizeModelOrder(
  builtinModelIds: readonly ModelId[],
  personalModelIds: readonly ModelId[],
  requested: readonly ModelId[],
): ModelId[] {
  return [...resolveOwnedOrder(builtinModelIds, personalModelIds, requested)];
}

export function nextPersonalProviderId(
  occupied: ReadonlySet<ProviderId>,
  templateId?: ProviderTemplateId,
): ProviderId {
  const base = templateId ? normalizeProviderIdSeed(templateId) : "new-provider";
  if (!occupied.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!occupied.has(candidate)) return candidate;
  }
}

export function normalizeProviderIdSeed(value: string): string {
  return (
    value
      .trim()
      .toLocaleLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "new-provider"
  );
}

export function resolvePersonalProviderBaselines(
  acodeBuiltin: ProviderConfigLayerSnapshot,
  personalProviders: ProviderConfigMap,
): ProviderConfigMap {
  const personal = personalProviders.mapConfigs((config, _id, rule) => {
    const template = rule.templateId
      ? acodeBuiltin.providerTemplates?.get(rule.templateId)
      : undefined;
    return template ? template.config.overlay(config) : config;
  });
  return acodeBuiltin.providers.overlay(personal);
}

export function resolveTemplateBaseline(
  builtin: ProviderConfigLayerSnapshot,
  providers: ProviderConfigMap,
  providerId: ProviderId,
): ProviderConfig | undefined {
  const templateId = providers.getRule(providerId)?.templateId;
  return templateId ? builtin.providerTemplates?.get(templateId)?.config : undefined;
}

export function resolveProviderBuiltinModelIds(
  builtin: ProviderConfigLayerSnapshot,
  personalProviders: ProviderConfigMap,
  providerId: ProviderId,
): readonly ModelId[] {
  return (
    builtin.providers.get(providerId)?.builtinModelIds ??
    resolveTemplateBaseline(builtin, personalProviders, providerId)?.builtinModelIds ??
    []
  );
}

export function nextPersonalProviderLabel(seed: string, providers: ProviderConfigMap): string {
  const base = seed.trim() || "new-provider";
  const labels = new Set(
    providers
      .rules()
      .map((provider) => provider.providerName?.trim().toLocaleLowerCase())
      .filter((label): label is string => Boolean(label)),
  );
  if (!labels.has(base.toLocaleLowerCase())) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base} ${suffix}`;
    if (!labels.has(candidate.toLocaleLowerCase())) return candidate;
  }
}
