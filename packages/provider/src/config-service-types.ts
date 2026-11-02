// 2026-12-31 例外债务偿还：自 config-service.ts 按职责拆出 —— 配置服务契约类型族
// （层快照/更新、Personal Repository、服务依赖与创建/成员接口）。
// 接口逐字迁移，行为零改动；纯函数 helper 见 config-service-helpers.ts，
// 方法族实现见 config-service-provider-ops.ts / config-service-model-ops.ts。
import type {
  ModelConfigRules,
  ModelId,
  ProviderApiType,
  ProviderConfig,
  ProviderConfigMap,
  ProviderId,
  ProviderTemplateId,
  ProviderTemplateMap,
  ProviderTemplateLocale,
} from "./config/index.js";
import type { ModelSelection } from "@acode/shared/model-selection";
import type { ProviderSource } from "./sources.js";

export interface ProviderConfigLayerSnapshot {
  readonly revision: string;
  readonly providers: ProviderConfigMap;
  readonly providerTemplates?: ProviderTemplateMap;
  readonly models: ModelConfigRules;
  readonly providerOrder?: readonly ProviderId[];
  readonly defaultModelSelection?: ModelSelection;
}

export interface ProviderConfigLayerUpdate {
  readonly providers: ProviderConfigMap;
  readonly providerTemplates?: ProviderTemplateMap;
  readonly models: ModelConfigRules;
  readonly providerOrder?: readonly ProviderId[];
  readonly defaultModelSelection?: ModelSelection;
}

export interface PersonalProviderConfigRepository extends ProviderSource<ProviderConfigLayerSnapshot> {
  update(
    transform: (current: ProviderConfigLayerSnapshot) => ProviderConfigLayerUpdate,
  ): Promise<ProviderConfigLayerSnapshot>;
}

export interface ProviderConfigServiceDependencies {
  readonly acodeBuiltinSource: ProviderSource<ProviderConfigLayerSnapshot>;
  readonly personalRepository: PersonalProviderConfigRepository;
}

export interface PersonalProviderCreation {
  readonly providerId: ProviderId;
}

export interface CreatePersonalProviderInput {
  readonly templateId?: ProviderTemplateId;
  readonly providerName?: string;
  readonly locale?: ProviderTemplateLocale;
  readonly initialConfig?: ProviderConfig;
}

/**
 * provider 配置导入的单条写入入参（docs/specs/provider-config-import.md R6）。
 * `apiKey` 是明文，只经本结构流向 repository 写入漏斗（→ vault），
 * 绝不出现在 RPC 视图/日志/结果清单中；上游 provider-import 服务在宿主内存里构造。
 */
export interface ProviderImportInput {
  readonly providerName: string;
  readonly api: { readonly type: ProviderApiType; readonly baseUrl: string };
  readonly apiKey?: string;
  readonly modelIds: readonly ModelId[];
  readonly useRecommendedConfig?: boolean;
}

/** 单条候选的导入结果；与入参数组顺序一一对应，便于上游按候选 id 回换。 */
export interface PersonalProviderImportItem {
  /** 实际落盘的唯一名（重名时已追加后缀）。 */
  readonly providerName: string;
  readonly providerId: ProviderId;
  /** 最终写入的模型 id（含按协议补的默认模型）。 */
  readonly modelIds: readonly ModelId[];
  /** 因与本条已写入模型重复而被跳过的 id。 */
  readonly skippedModelIds: readonly ModelId[];
}

export interface PersonalProviderImportOutcome {
  readonly items: readonly PersonalProviderImportItem[];
}

/** Facade 提供的 Host 内部成员事实；不得接受 Renderer 自报的模型名单。 */
export interface ProviderModelMembership {
  readonly providerId: ProviderId;
  readonly inheritedModelIds: readonly ModelId[];
  readonly personalRevision: string;
  /** 在 Personal 事务内检查发布快照未过期，不触发网络请求。 */
  readonly assertCurrent: () => void;
}

/**
 * 2026-12-31 例外债务偿还的拆分支架：ProviderConfigService 方法族叶子
 * （config-service-provider-ops.ts / config-service-model-ops.ts）与服务本体之间的
 * 内部协作上下文。三个能力逐字对应原私有成员 #acodeBuiltinSource / #personalRepository /
 * #updatePersonal；dispose 断言仍由 #updatePersonal 内部既有检查承担，语义不变。
 * 内部契约：config-service.ts 不 re-export 本接口，包导出面保持不变。
 */
export interface ProviderConfigServiceOpsContext {
  readonly acodeBuiltinSource: ProviderSource<ProviderConfigLayerSnapshot>;
  readonly personalRepository: PersonalProviderConfigRepository;
  readonly updatePersonal: (
    transform: (current: ProviderConfigLayerSnapshot) => ProviderConfigLayerUpdate,
  ) => Promise<ProviderConfigLayerSnapshot>;
}
