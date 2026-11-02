// 契约形状参照 Fynvra（Apache-2.0），见 docs/specs/provider-config-import.md
// provider-config-import 单事务导入（R6）：把外部工具扫描出的多条候选在**一次**
// `updatePersonal` 事务里建 Provider + 模型，产出一个 revision；任一条失败则整批放弃
// （EI-12/EI-40 原子性），绝不留半成品 Provider。
//
// 与 createPersonalProvider 的分工：本方法不重复实现命名/ID 生成与 group 约束，
// 而是复用 config-service-helpers 的同款 helper；明文 apiKey 只进 `ApiKeyAccessConfig.apiKey`，
// 明文 → credentialRef 的迁移由 provider-node repository 的写入漏斗统一承担
// （本方法**不得**预先调用 vault，见 spec R6）。
import {
  ApiKeyAccessConfig,
  ModelConfig,
  ProviderApiConfig,
  ProviderConfig as ProviderConfigValue,
} from "./config/index.js";
import type { ModelId, ProviderApiType, ProviderId } from "./config/index.js";
import type {
  PersonalProviderImportItem,
  PersonalProviderImportOutcome,
  ProviderConfigLayerSnapshot,
  ProviderConfigServiceOpsContext,
  ProviderImportInput,
} from "./config-service-types.js";
import {
  nextPersonalProviderId,
  nextPersonalProviderLabel,
  resolvePersonalProviderBaselines,
} from "./config-service-helpers.js";

/** 归一后的导入入参；`providerName` 去空白，`modelIds` 去空/去重（保序）。 */
interface NormalizedImportInput {
  readonly providerName: string;
  readonly apiType: ProviderApiType;
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly modelIds: readonly ModelId[];
  readonly useRecommendedConfig: boolean;
}

export async function importPersonalProviders(
  context: ProviderConfigServiceOpsContext,
  inputs: readonly ProviderImportInput[],
): Promise<PersonalProviderImportOutcome> {
  const normalized = inputs.map(normalizeImportInput);
  if (normalized.length === 0) {
    // 空批 no-op（与 addPersonalModels 同口径）：不产 revision，不写盘。
    await context.personalRepository.read();
    return Object.freeze({ items: Object.freeze([]) });
  }
  const acodeBuiltin = await context.acodeBuiltinSource.read();
  // 事务内同步收集逐条结果；updatePersonal 的 transform 是同步调用，故外部可安全读取。
  const collected: PersonalProviderImportItem[] = [];
  await context.updatePersonal((current) => {
    const occupied = new Set<ProviderId>([
      ...acodeBuiltin.providers.keys(),
      ...current.providers.keys(),
    ]);
    let providers = current.providers;
    let models = current.models;
    for (const input of normalized) {
      const providerId = nextPersonalProviderId(occupied, undefined);
      occupied.add(providerId);
      // 名称唯一性对「生效后的全量视图」判定，本批已落盘的 Provider 也参与比较。
      const effectiveProviders = resolvePersonalProviderBaselines(acodeBuiltin, providers);
      const providerName = nextPersonalProviderLabel(input.providerName, effectiveProviders);
      const requestedModelIds =
        input.modelIds.length > 0 ? input.modelIds : defaultModelIdsForApi(acodeBuiltin, input.apiType);

      const writtenModelIds: ModelId[] = [];
      const skippedModelIds: ModelId[] = [];
      let nextModels = models;
      for (const modelId of requestedModelIds) {
        // 新建 Provider 没有既有个人模型；这里的重复只可能来自候选内的重复 id，
        // 按 spec「跳过该 id 并记入备注」处理，不用异常打断整批。
        if (writtenModelIds.includes(modelId)) {
          skippedModelIds.push(modelId);
          continue;
        }
        writtenModelIds.push(modelId);
        nextModels = nextModels.setExact(
          providerId,
          modelId,
          // 不编造 contextWindow/maxOutputTokens（EI-9）：目录外模型只落最小 enabled 档，
          // 可推导部分与「需要配置」由规则层与设置视图的 issues 呈现。
          new ModelConfig({ enabled: true }),
          input.useRecommendedConfig,
        );
      }

      const config = new ProviderConfigValue({
        group: "standard-personal",
        access: new ApiKeyAccessConfig(input.apiKey ? { apiKey: input.apiKey } : {}),
        api: new ProviderApiConfig({ type: input.apiType, baseUrl: input.baseUrl }),
        personalModelIds: writtenModelIds,
        modelOrder: writtenModelIds,
      });
      providers = providers.setRule({ providerId, providerName, config });
      models = nextModels;
      collected.push(
        Object.freeze({
          providerName,
          providerId,
          modelIds: Object.freeze([...writtenModelIds]),
          skippedModelIds: Object.freeze([...skippedModelIds]),
        }),
      );
    }
    return {
      providers,
      models,
      // 序尾追加：把本批新 Provider 追加到个人顺序尾部，不重排既有顺序。
      providerOrder: appendImportedProviderOrder(current.providerOrder ?? [], occupied, collected),
    };
  });
  return Object.freeze({ items: Object.freeze([...collected]) });
}

/** 候选未带模型时，按协议取内置目录里首个同协议模板/Provider 的成员名单（保持为空即诚实为空）。 */
function defaultModelIdsForApi(
  builtin: ProviderConfigLayerSnapshot,
  apiType: ProviderApiType,
): readonly ModelId[] {
  for (const [, template] of builtin.providerTemplates?.entries() ?? []) {
    if (template.config.api?.type !== apiType) continue;
    const ids = template.config.builtinModelIds ?? [];
    if (ids.length > 0) return ids;
  }
  for (const [, config] of builtin.providers.entries()) {
    if (config.api?.type !== apiType) continue;
    const ids = config.builtinModelIds ?? [];
    if (ids.length > 0) return ids;
  }
  return [];
}

function appendImportedProviderOrder(
  currentOrder: readonly ProviderId[],
  occupied: ReadonlySet<ProviderId>,
  added: readonly PersonalProviderImportItem[],
): readonly ProviderId[] {
  const kept: ProviderId[] = currentOrder.filter((providerId) => occupied.has(providerId));
  const addedIds = added.map((item) => item.providerId);
  return [...kept.filter((providerId) => !addedIds.includes(providerId)), ...addedIds];
}

function normalizeImportInput(input: ProviderImportInput): NormalizedImportInput {
  const providerName = input.providerName.trim();
  if (!providerName) throw new Error("导入 Provider 名称不能为空");
  const baseUrl = input.api.baseUrl.trim().replace(/\/+$/, "");
  if (!baseUrl) throw new Error("导入 Provider baseUrl 不能为空");
  const seen = new Set<ModelId>();
  const modelIds: ModelId[] = [];
  for (const candidate of input.modelIds) {
    const modelId = candidate.trim();
    if (!modelId || seen.has(modelId)) continue;
    seen.add(modelId);
    modelIds.push(modelId);
  }
  return {
    providerName,
    apiType: input.api.type,
    baseUrl,
    ...(input.apiKey && input.apiKey.trim() ? { apiKey: input.apiKey } : {}),
    modelIds,
    useRecommendedConfig: input.useRecommendedConfig ?? true,
  };
}