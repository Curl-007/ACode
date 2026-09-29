// ============================================================
// HTTP Client Port - network I/O boundary
// ============================================================

import type { ExecutionContext, TraceContext } from "../tracing/tracer.js";

export type HttpClientMethod = "GET" | "HEAD" | "POST";
export type HttpClientRedirectPolicy = "manual" | "follow";
export type HttpClientEgressPolicy = "public";

export type HttpClientErrorCode =
  | "invalid_url"
  | "unsupported_protocol"
  | "timeout"
  | "cancelled"
  | "too_large"
  | "egress_blocked"
  | "network_error"
  | "proxy_error";

export interface HttpClientErrorDetails {
  code: HttpClientErrorCode;
  url?: string;
  status?: number;
  message: string;
  cause?: unknown;
}

export class HttpClientPortError extends Error {
  readonly code: HttpClientErrorCode;
  readonly url?: string;
  readonly status?: number;
  override readonly cause?: unknown;

  constructor(details: HttpClientErrorDetails) {
    super(details.message);
    this.name = "HttpClientPortError";
    this.code = details.code;
    this.url = details.url;
    this.status = details.status;
    this.cause = details.cause;
  }
}

export function createHttpClientError(details: HttpClientErrorDetails): HttpClientPortError {
  return new HttpClientPortError(details);
}

export function isHttpClientPortError(error: unknown): error is HttpClientPortError {
  return error instanceof HttpClientPortError;
}

export interface HttpClientRequest {
  url: string;
  method?: HttpClientMethod;
  headers?: Record<string, string>;
  body?: Uint8Array;
  timeoutMs?: number;
  maxResponseBytes?: number;
  redirect?: HttpClientRedirectPolicy;
  egressPolicy?: HttpClientEgressPolicy;
  /**
   * 仅对 `egressPolicy: "public"` 有意义：解析出代理时是否允许**显式降级**继续请求
   * （代理侧 DNS 不可本地验证，降级后防线只剩调用方的 URL 字面守卫，
   * 响应 `egress.publicEgressDnsVerified` 为 false 如实记录）。
   * 缺省 false=严格档：public + 代理 → egress_blocked 拒绝。
   * 授权面窄：当前仅 WebFetch 允许设置（specs/webfetch-public-egress.md R4）。
   */
  allowProxiedPublicEgress?: boolean;
  trace?: TraceContext;
}

export interface HttpClientEgressInfo {
  proxied: boolean;
  proxySource?: string;
  proxyHost?: string;
  noProxyMatched?: boolean;
  customCa?: boolean;
  /**
   * 仅 `egressPolicy: "public"` 的请求携带：true = 建连前公网 DNS 预检已执行且
   * 连接使用过检解析（TOCTOU-safe）；false = 走了代理降级路径（R2 opt-in），
   * DNS 未经本地验证。可观察性要求见 specs/webfetch-public-egress.md。
   */
  publicEgressDnsVerified?: boolean;
}

export interface HttpClientResponse {
  url: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: Uint8Array;
  bytes: number;
  durationMs: number;
  egress?: HttpClientEgressInfo;
}

export interface HttpClientRunOptions {
  signal?: AbortSignal;
  context?: ExecutionContext;
}

export interface HttpClientPort {
  request(
    request: HttpClientRequest,
    options?: HttpClientRunOptions,
  ): Promise<HttpClientResponse>;
}
