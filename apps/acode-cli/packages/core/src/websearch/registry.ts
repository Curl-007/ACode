// Ported from oh-my-pi (MIT) — packages/coding-agent/src/web/search/provider.ts
// Copyright (c) 2025 Mario Zechner & Stencil Labs
// 搜索首次使用边界：每个引擎模块（及其 HTTP/抓取依赖）只在某次搜索真正选中它时
// 才加载，~20 个引擎模块不进交互启动路径。实例按 id memoize，对齐 omp 的
// singleton-per-provider 行为。

import type { SearchProvider } from "./providers/base.js";
import { SearchProviderError, getSearchProviderLabel, type SearchProviderId } from "./types.js";

type ProviderLoader = () => Promise<SearchProvider>;

const PROVIDER_LOADERS: Record<SearchProviderId, ProviderLoader> = {
  duckduckgo: () => import("./providers/duckduckgo.js").then(m => new m.DuckDuckGoProvider()),
  searxng: () => import("./providers/searxng.js").then(m => new m.SearXNGProvider()),
  startpage: () => import("./providers/startpage.js").then(m => new m.StartpageProvider()),
  ecosia: () => import("./providers/ecosia.js").then(m => new m.EcosiaProvider()),
  google: () => import("./providers/google.js").then(m => new m.GoogleProvider()),
  mojeek: () => import("./providers/mojeek.js").then(m => new m.MojeekProvider()),
  public: () => import("./providers/public.js").then(m => new m.PublicWebProvider()),
  brave: () => import("./providers/brave.js").then(m => new m.BraveProvider()),
  deepseek: () => import("./providers/deepseek.js").then(m => new m.DeepSeekProvider()),
  kimi: () => import("./providers/kimi.js").then(m => new m.KimiProvider()),
  jina: () => import("./providers/jina.js").then(m => new m.JinaProvider()),
  kagi: () => import("./providers/kagi.js").then(m => new m.KagiProvider()),
  tavily: () => import("./providers/tavily.js").then(m => new m.TavilyProvider()),
  exa: () => import("./providers/exa.js").then(m => new m.ExaProvider()),
  firecrawl: () => import("./providers/firecrawl.js").then(m => new m.FirecrawlProvider()),
  perplexity: () => import("./providers/perplexity.js").then(m => new m.PerplexityProvider()),
  ollama: () => import("./providers/ollama.js").then(m => new m.OllamaProvider()),
  synthetic: () => import("./providers/synthetic.js").then(m => new m.SyntheticProvider()),
  zai: () => import("./providers/zai.js").then(m => new m.ZaiProvider()),
  tinyfish: () => import("./providers/tinyfish.js").then(m => new m.TinyFishProvider()),
  parallel: () => import("./providers/parallel.js").then(m => new m.ParallelProvider()),
};

const providerInstances = new Map<string, Promise<SearchProvider>>();

function loadProvider(id: string, loader: ProviderLoader): Promise<SearchProvider> {
  let instance = providerInstances.get(id);
  if (!instance) {
    instance = loader();
    providerInstances.set(id, instance);
  }
  return instance;
}

/** 为用户可见的回退汇总格式化单个引擎失败。 */
export function formatSearchProviderFailure(error: unknown, provider: { id: string; label: string }): string {
  if (error instanceof SearchProviderError) {
    if (error.status === 401 || error.status === 403) {
      return `${getSearchProviderLabel(error.provider)} authorization failed (${error.status}). Check its API key env.`;
    }
    return error.message;
  }
  if (error instanceof Error) return error.message;
  return `Unknown error from ${provider.label}`;
}

/** 为终端/工具输出格式化有序的引擎回退失败清单。 */
export function formatSearchProviderFailures(
  failures: readonly { provider: { id: string; label: string }; error: unknown }[],
): string {
  return failures.map(f => `${f.provider.id}: ${formatSearchProviderFailure(f.error, f.provider)}`).join("; ");
}

/** `id` 是否是注册表里的纯搜索引擎。 */
export function isRegisteredSearchEngine(id: string): id is SearchProviderId {
  return Object.hasOwn(PROVIDER_LOADERS, id);
}

/** 校验目录 id 后解析纯搜索引擎（首次调用触发该引擎模块的动态 import）。 */
export function getSearchProvider(id: string): Promise<SearchProvider> {
  if (!isRegisteredSearchEngine(id)) return Promise.reject(new Error(`Unknown search provider: ${id}`));
  return loadProvider(id, PROVIDER_LOADERS[id]);
}

/** 仅供测试：清空实例 memo（不影响已加载的模块）。 */
export function resetSearchProviderInstancesForTest(): void {
  providerInstances.clear();
}
