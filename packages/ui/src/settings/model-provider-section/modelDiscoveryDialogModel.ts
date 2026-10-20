import type { ProviderModelDiscoveryErrorKind } from "@acode/services";

// 获取模型对话框的纯逻辑层（specs/provider-model-discovery.md 产品规则 5）：
// 勾选集合计算与错误 kind → i18n 文案映射。无 React/DOM 依赖，纯函数可直接单测。

/**
 * 发现列表展示上限（UI 展示口径）。与 host 侧 `DISCOVERY_MAX_MODELS`
 * （packages/services provider-model-discovery.ts，spec 产品规则 3 的 500 条截断）
 * 保持一致；截断注记文案 `discover.truncated` 的 {max} 占位用它填充。
 */
export const DISCOVERY_MODEL_LIST_LIMIT = 500;

export interface DiscoverySelection {
  /** fetched 中尚未配置的模型 id：保持 fetched 原序、去重。 */
  addable: string[];
  /** 默认勾选集 = addable 全量（spec：未配置 id 默认勾选）。 */
  preselected: string[];
  /** fetched 中已配置的模型 id：保持原序、去重；行内禁用勾选并弱化标注。 */
  configuredHits: string[];
}

/** 保序去重（配置集与已见集合都不改变 fetched 顺序）。 */
function dedupeKeepOrder(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

/**
 * 三分集计算：addable（可新增，默认全勾）/ preselected（= addable）/
 * configuredHits（已配置，绝不覆盖或重复添加，spec 产品规则 5、7）。
 */
export function computeDiscoverySelection(
  fetched: readonly string[],
  configured: readonly string[],
): DiscoverySelection {
  const configuredSet = new Set(configured);
  const addable: string[] = [];
  const configuredHits: string[] = [];
  for (const id of dedupeKeepOrder(fetched)) {
    if (configuredSet.has(id)) {
      configuredHits.push(id);
    } else {
      addable.push(id);
    }
  }
  return { addable, preselected: [...addable], configuredHits };
}

/** 错误 kind → i18n key 全量映射（新增 kind 时 Record 类型会强制补齐）。 */
const DISCOVERY_ERROR_MESSAGE_IDS: Record<ProviderModelDiscoveryErrorKind, string> = {
  network: "settings.modelProvider.discover.error.network",
  timeout: "settings.modelProvider.discover.error.timeout",
  unauthorized: "settings.modelProvider.discover.error.unauthorized",
  forbidden: "settings.modelProvider.discover.error.forbidden",
  "not-found": "settings.modelProvider.discover.error.notFound",
  "unsupported-shape": "settings.modelProvider.discover.error.unsupportedShape",
  "too-large": "settings.modelProvider.discover.error.tooLarge",
  "insecure-url": "settings.modelProvider.discover.error.insecureUrl",
  "redirect-cross-origin": "settings.modelProvider.discover.error.redirectCrossOrigin",
  "no-base-url": "settings.modelProvider.discover.error.noBaseUrl",
  http: "settings.modelProvider.discover.error.http",
};

/**
 * kind → 文案 key。类型层已穷尽；运行时兜底（host 返回未知 kind 的旧/新版本偏差）
 * 回退 network 文案——同为"联系不上/请求未成"语义，避免把原始 kind 直接漏给用户。
 */
export function mapDiscoveryErrorKindToMessageId(kind: ProviderModelDiscoveryErrorKind): string {
  return DISCOVERY_ERROR_MESSAGE_IDS[kind] ?? DISCOVERY_ERROR_MESSAGE_IDS.network;
}
