// Ported from oh-my-pi (MIT) — packages/coding-agent/src/web/search/types.ts + packages/tui/src/tools/web-search-types.ts
// Copyright (c) 2025 Mario Zechner & Stencil Labs
// 适配：grounding 后端（gemini/anthropic/codex/xai/openai/openrouter）不在 ACode 多引擎层范围，
// 只保留 21 个纯搜索引擎 id；SearchSource/SearchResponse 形状保持一致。

/** 纯搜索引擎 id（`ACODE_WEBSEARCH_ENGINES` 的合法取值）。 */
export const SEARCH_PROVIDER_LABELS = {
  perplexity: "Perplexity",
  zai: "Z.AI",
  exa: "Exa",
  tinyfish: "TinyFish",
  jina: "Jina",
  kagi: "Kagi",
  tavily: "Tavily",
  firecrawl: "Firecrawl",
  brave: "Brave",
  deepseek: "DeepSeek",
  kimi: "Kimi",
  parallel: "Parallel",
  synthetic: "Synthetic",
  ollama: "Ollama",
  searxng: "SearXNG",
  startpage: "Startpage",
  duckduckgo: "DuckDuckGo",
  ecosia: "Ecosia",
  google: "Google",
  mojeek: "Mojeek",
  public: "Public Web",
} as const;

/** 搜索引擎 id；见 {@link SEARCH_PROVIDER_LABELS}。 */
export type SearchProviderId = keyof typeof SEARCH_PROVIDER_LABELS;

/** 引擎 id 的展示标签；旧转录里的未知 id 回落为原始 id。 */
export function getSearchProviderLabel(id: SearchProviderId): string {
  return SEARCH_PROVIDER_LABELS[id] ?? id;
}

/** 各引擎统一返回的搜索来源。 */
export interface SearchSource {
  title: string;
  url: string;
  snippet?: string;
  /** ISO 日期或相对时间（"2d ago"）。 */
  publishedDate?: string;
  /** 秒龄，统一格式化用。 */
  ageSeconds?: number;
  author?: string;
}

/** 引擎统一的响应形状（grounding 类的 citations/usage 不在纯引擎层）。 */
export interface SearchResponse {
  provider: SearchProviderId | "none";
  /** LLM 中介类引擎的合成答案文本。 */
  answer?: string;
  sources: SearchSource[];
  relatedQuestions?: string[];
  /** 请求 id（调试用）。 */
  requestId?: string;
  /** 凭据模式（如 api-key）。 */
  authMode?: string;
}

/** 引擎专属错误，带可选 HTTP 状态。 */
export class SearchProviderError extends Error {
  constructor(
    public readonly provider: SearchProviderId,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "SearchProviderError";
  }
}

/** 每次 web-search 引擎传输的默认硬超时。 */
export const DEFAULT_WEB_SEARCH_TIMEOUT_SECONDS = 60;

/** 每次 web-search 引擎传输的最大可配置硬超时。 */
export const MAX_WEB_SEARCH_TIMEOUT_SECONDS = 300;
