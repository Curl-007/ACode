export const WEBFETCH_TOOL_NAME = "WebFetch";
export const DEFAULT_WEBFETCH_TIMEOUT_MS = 60_000;
export const MAX_WEBFETCH_URL_CHARS = 2_000;
export const MAX_WEBFETCH_RESPONSE_BYTES = 10 * 1024 * 1024;
export const MAX_MODEL_INPUT_CHARS = 100_000;
export const MAX_WEBFETCH_MODEL_BYTES = 100_000;
export const CACHE_TTL_MS = 15 * 60 * 1000;
export const CACHE_MAX_BYTES = 50 * 1024 * 1024;
export const MAX_REDIRECTS = 10;

// 修复依据（docs/prompt-corpus-audit-2026-10.md F1）：原 UA 携带上游产品品牌 URL
// （zcode.ai），随每次 WebFetch 外发给全部目标站点。移除外部 URL 段——ACode 当前
// 无官方域名，宁缺勿错；保留「产品名/版本 + 类别标识」的 UA 惯例结构。
export const WEBFETCH_USER_AGENT = "ACode-WebFetch/0.1 (coding-agent-cli)";
