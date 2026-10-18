// Ported from oh-my-pi (MIT) — packages/coding-agent/src/web/search/providers/browser-page.ts（fetch 半部）
// Copyright (c) 2025 Mario Zechner & Stencil Labs
// 降解：omp 的 browserFetch 在 fetch 失败/被墙时回退 puppeteer 隐身浏览器；ACode core
// 不含浏览器基础设施，只保留 fetch 路径。被墙引擎返回错误后由回退链换下一个引擎——
// 引擎间兜底替代了 omp 的引擎内浏览器兜底。

import { buildBrowserNavigationHeaders } from "./browser-headers.js";
import { SEARCH_HARD_TIMEOUT_MS } from "./provider-utils.js";

/** 重定向后的 HTML、状态码与最终 URL。 */
export interface LoadedHtmlPage {
  html: string;
  status: number;
  url: string;
}

export interface BrowserFetchOptions {
  fetch?: typeof fetch;
  signal: AbortSignal;
  timeoutMs?: number;
  randomizeHeaders?: boolean;
  referer?: string;
  init?: Omit<RequestInit, "headers" | "signal">;
  headers?: Readonly<Record<string, string>>;
}

/** 带浏览器导航指纹的一次 fetch（omp 侧含隐身浏览器回退，此处降解为纯 fetch）。 */
export async function browserFetch(url: string, options: BrowserFetchOptions): Promise<LoadedHtmlPage> {
  const fetchImpl = options.fetch ?? fetch;
  const response = await fetchImpl(url, {
    ...options.init,
    headers: {
      ...buildBrowserNavigationHeaders({ randomized: options.randomizeHeaders }),
      ...(options.referer ? { Referer: options.referer, "Sec-Fetch-Site": "same-origin" } : {}),
      ...options.headers,
    },
    signal: options.signal,
  });
  return { html: await response.text(), status: response.status, url: response.url || url };
}

export { SEARCH_HARD_TIMEOUT_MS };
