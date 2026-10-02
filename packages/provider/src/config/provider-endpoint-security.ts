/**
 * Provider 连接端点的安全判定（安全加固 P2 #7：http 明文端点告警）。
 *
 * 背景：自定义 Provider 的 baseUrl 允许 `http:`（provider-data-schema 只校验 URL 形态，
 * 不限制协议）。明文 HTTP 会把 API Key 和对话内容暴露给链路上的中间节点。
 * 这里提供与框架无关的纯判定函数：UI 设置表单用它渲染非阻断的内联警告；
 * 数据/诊断层的接入边界见 packages/provider/specs/provider-http-endpoint-warning.md。
 */

/**
 * 判定 Provider Base URL 是否为明文 http 端点。
 *
 * 语义约定：
 * - 空值、非字符串、无法解析的值一律返回 false——非法 URL 的报错由
 *   `completeProviderApiDataSchema` 的 url 校验负责，本函数只对「合法且为 http:」负责，
 *   避免把「还没输完的草稿」误报成安全问题。
 * - 大小写按 WHATWG URL 规范归一（`HTTP://` 的 protocol 解析后是小写 `http:`）。
 */
export function isPlaintextHttpBaseUrl(value: string | null | undefined): boolean {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  try {
    return new URL(trimmed).protocol === "http:";
  } catch {
    return false;
  }
}
