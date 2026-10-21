import {
  validateModelSelectionOptions,
  type ModelSelection,
  type ProviderRegistryView,
} from "./registry.js";

/** 可固定的具体推理档位，按从低到高排列；模型不支持时向下降级。 */
export const DEFAULT_REASONING_LEVEL_PICK_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

/**
 * 主动选模型 / 新建任务时推理强度的默认取法：列表第一项、最高档（最后一项），
 * 或某个具体档位（模型不支持时自动降级到最近的更低档）。
 */
export type DefaultReasoningLevelPick =
  | "first"
  | "highest"
  | (typeof DEFAULT_REASONING_LEVEL_PICK_LEVELS)[number];

/** 各厂商档位别名归一到同一阶梯；on/enabled 这类二值开关视作中档。 */
const REASONING_LEVEL_RANK: Record<string, number> = {
  off: 0,
  disabled: 0,
  false: 0,
  no: 0,
  none: 0,
  nothink: 0,
  "no-think": 0,
  no_think: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  on: 3,
  enable: 3,
  enabled: 3,
  true: 3,
  high: 4,
  xhigh: 5,
  "extra-high": 5,
  extra_high: 5,
  max: 6,
  ultra: 7,
};

function reasoningLevelRank(value: string): number | undefined {
  return REASONING_LEVEL_RANK[value.trim().toLowerCase()];
}

function pickReasoningLevel(
  values: readonly string[] | undefined,
  pick: DefaultReasoningLevelPick | undefined,
): string | undefined {
  if (!values || values.length === 0) return undefined;
  if (pick === undefined || pick === "first") return values[0];
  if (pick === "highest") return values.at(-1);
  const target = reasoningLevelRank(pick);
  if (target === undefined) return values[0];
  let below: { value: string; rank: number } | undefined;
  let above: { value: string; rank: number } | undefined;
  for (const value of values) {
    const rank = reasoningLevelRank(value);
    if (rank === undefined) continue;
    if (rank === target) return value;
    if (rank < target && (!below || rank > below.rank)) below = { value, rank };
    if (rank > target && (!above || rank < above.rank)) above = { value, rank };
  }
  // 没有更低档时（如模型最低就是「中」）取最接近的更高档，仍不认识则回落第一项。
  return below?.value ?? above?.value ?? values[0];
}

export type InitialModelSelectionResolution =
  | {
      readonly source: "configured-default" | "registry-fallback";
      readonly selection: ModelSelection;
    }
  | { readonly source: "none" };

interface ModelSelectionCompletionView {
  readonly providers: readonly {
    readonly providerId: string;
    readonly models: readonly {
      readonly modelId: string;
      readonly config: {
        readonly optionSpecs: {
          readonly reasoningLevel: { readonly values: readonly string[] };
          readonly speed?: { readonly values: readonly string[] };
        };
      };
    }[];
  }[];
}

export function resolveInitialModelSelection(input: {
  readonly configuredDefault?: ModelSelection;
  readonly registry: ProviderRegistryView;
}): InitialModelSelectionResolution {
  // 这里只构造 Host 的初始推荐，不解析已有会话意图。失效默认是可丢弃偏好，
  // 应继续按 Registry 顺序推荐；不能把历史选择留空的规则误用于新草稿初始化。
  if (input.configuredDefault) {
    if (isSelectable(input.registry, input.configuredDefault)) {
      return {
        source: "configured-default",
        selection: freezeSelection(input.configuredDefault),
      };
    }
  }

  // 仅用于全新草稿的 Host 初始推荐；历史未绑定状态不能进入这个初始化分支。
  for (const provider of input.registry.providers) {
    if (provider.config.visibility === "hidden") continue;
    for (const model of provider.models) {
      const selection = completeNewModelSelection(input.registry, {
        providerId: provider.providerId,
        modelId: model.modelId,
      });
      if (selection) return { source: "registry-fallback", selection: freezeSelection(selection) };
    }
  }
  return { source: "none" };
}

/**
 * 仅在用户主动选模型或全新初始化时构造默认档位；不能用于恢复/重解析已有选择。
 *
 * 修复原因：原先推理取列表最后一项，与「模型配置里排在最前面的即默认」的产品规则不一致。
 * 修复依据：默认推理强度可在设置里改为「最高档」或具体档位；未配置时取第一项。
 */
export function completeNewModelSelection(
  registry: ModelSelectionCompletionView,
  selection: ModelSelection,
  defaults: { readonly reasoningLevel?: DefaultReasoningLevelPick } = {},
): ModelSelection | undefined {
  const model = registry.providers
    .find((provider) => provider.providerId === selection.providerId)
    ?.models.find((candidate) => candidate.modelId === selection.modelId);
  const reasoningLevel = pickReasoningLevel(
    model?.config.optionSpecs.reasoningLevel.values,
    defaults.reasoningLevel,
  );
  if (!model || !reasoningLevel) return undefined;
  const speed = model.config.optionSpecs.speed?.values[0];
  return {
    providerId: selection.providerId,
    modelId: selection.modelId,
    options: { reasoningLevel, ...(speed ? { speed } : {}) },
  };
}

/**
 * 规范化一份待提交的 Selection。
 * 已有选择缺失或失效时只保留模型身份，等待用户选择档位；主动选模型另走 completion。
 * 任何执行入口都必须在此之后再次确认 Selection 完整，不能静默补档位。
 */
export function normalizeModelSelection(
  registry: ModelSelectionCompletionView,
  selection: ModelSelection,
): ModelSelection | undefined {
  const model = registry.providers
    .find((provider) => provider.providerId === selection.providerId)
    ?.models.find((candidate) => candidate.modelId === selection.modelId);
  if (!model) return undefined;
  const values = model.config.optionSpecs.reasoningLevel.values;
  const reasoningLevel = selection.options?.reasoningLevel;
  const speedValues = model.config.optionSpecs.speed?.values;
  const speed = selection.options?.speed;
  const reasoningValid = reasoningLevel !== undefined && values.includes(reasoningLevel);
  const speedValid = speedValues
    ? speed !== undefined && speedValues.includes(speed)
    : speed === undefined;
  if (reasoningValid && speedValid) return selection;
  return {
    providerId: selection.providerId,
    modelId: selection.modelId,
  };
}

function isSelectable(registry: ProviderRegistryView, selection: ModelSelection): boolean {
  const provider = registry.providers.find(
    (candidate) => candidate.providerId === selection.providerId,
  );
  if (provider?.config.visibility === "hidden") return false;
  const model = provider?.models.find((candidate) => candidate.modelId === selection.modelId);
  if (!model) return false;
  return validateModelSelectionOptions(model, selection).ok;
}

function freezeSelection(selection: ModelSelection): ModelSelection {
  return Object.freeze({
    providerId: selection.providerId,
    modelId: selection.modelId,
    ...(selection.options ? { options: Object.freeze({ ...selection.options }) } : {}),
  });
}
