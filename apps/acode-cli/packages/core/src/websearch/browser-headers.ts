// Ported from oh-my-pi (MIT) — packages/coding-agent/src/web/search/providers/browser-headers.ts
// Copyright (c) 2025 Mario Zechner & Stencil Labs
// 降解：omp 用 @oh-my-pi/pi-utils HeaderGenerator 随机化指纹；ACode core 无该依赖，
// 改为固定桌面 Chrome 导航指纹（确定性、可缓存路径稳定），防随机漂移。

/** 与 omp 非随机路径一致的桌面 Mac Chrome 导航指纹。 */
const CHROME_FALLBACK_HEADERS: Record<string, string> = {
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
  "Accept-Encoding": "gzip, deflate, br, zstd",
  "Accept-Language": "en-US,en;q=0.9",
  "Cache-Control": "max-age=0",
  Priority: "u=0, i",
  "Sec-Ch-Ua": '"Google Chrome";v="149", "Chromium";v="149", ";Not A Brand";v="99"',
  "Sec-Ch-Ua-Mobile": "?0",
  "Sec-Ch-Ua-Platform": '"macOS"',
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
  "Upgrade-Insecure-Requests": "1",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
};

/**
 * 为一次 HTTP 请求构建桌面导航指纹。参数仅为兼容 omp 调用形；ACode 侧恒为
 * 确定性指纹（不随机化），使 bot 墙行为可复现、失败可诊断。
 */
export function buildBrowserNavigationHeaders(_options?: { randomized?: boolean }): Record<string, string> {
  return { ...CHROME_FALLBACK_HEADERS };
}
