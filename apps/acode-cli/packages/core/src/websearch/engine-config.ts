// 引擎链配置（specs/websearch-multi-engine.md §3.1）：最小侵入 env 配置面。
// ACODE_WEBSEARCH_ENGINES 未设置/空 → 多引擎层关闭（现状 provider-native 路径）；
// =auto → 内置默认链；否则逗号分隔引擎 id，顺序即优先级。
// 每次调用即时解析（无缓存），与既有 WebSearch budget env 的热改纪律一致。

import { SEARCH_PROVIDER_LABELS, type SearchProviderId } from "./types.js";

const ENGINES_ENV_VAR = "ACODE_WEBSEARCH_ENGINES";

/**
 * 内置默认链：免 key 引擎在前（保底可用），env-key 引擎按「综合质量优先」排列在后；
 * isAvailable=false 的引擎运行时静默跳过，所以顺序只表达偏好、不表达承诺。
 * public 聚合引擎不在默认链（omp 同款：扇出五个抓取引擎是显式选择）。
 */
const DEFAULT_ENGINE_CHAIN: readonly SearchProviderId[] = [
  "duckduckgo",
  "brave",
  "tavily",
  "exa",
  "kagi",
  "deepseek",
  "kimi",
  "jina",
  "firecrawl",
  "perplexity",
  "zai",
  "searxng",
  "startpage",
  "ecosia",
  "google",
  "mojeek",
];

export type EngineChainMode = "off" | "default" | "explicit";

export interface EngineChain {
  mode: EngineChainMode;
  /** mode=default/explicit 时的引擎顺序；mode=off 时为空。 */
  ids: SearchProviderId[];
}

/** 解析 ACODE_WEBSEARCH_ENGINES；未知 id 忽略（不报错——增量配置面要宽容）。 */
export function resolveEngineChain(env: NodeJS.ProcessEnv = process.env): EngineChain {
  const raw = env[ENGINES_ENV_VAR]?.trim();
  if (!raw) return { mode: "off", ids: [] };
  if (raw.toLowerCase() === "auto") return { mode: "default", ids: [...DEFAULT_ENGINE_CHAIN] };
  const ids: SearchProviderId[] = [];
  for (const token of raw.split(",")) {
    const id = token.trim().toLowerCase();
    // 只接受注册表认识的 id（Object.hasOwn 防 prototype 键）。
    if (id && Object.hasOwn(SEARCH_PROVIDER_LABELS, id) && !ids.includes(id as SearchProviderId)) {
      ids.push(id as SearchProviderId);
    }
  }
  return { mode: "explicit", ids };
}

/** 默认链是否包含该 id（仅诊断用）。 */
export function isInDefaultChain(id: SearchProviderId): boolean {
  return DEFAULT_ENGINE_CHAIN.includes(id);
}
