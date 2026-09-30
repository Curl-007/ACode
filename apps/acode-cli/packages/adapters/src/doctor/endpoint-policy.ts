// ============================================================
// Provider Doctor 端点策略（J3-1 / spec R4）
// 机制参照 jcode (MIT, github.com/1jehuang/jcode) crates/jcode-provider-doctor，自撰实现。
// ============================================================
//
// 硬约束：由本模块直接构造的 HTTP 请求只允许 http/https，且**发请求前**校验 host——
// 拒绝 localhost、环回、私网、链路本地与保留地址。IP/主机名判定不自己写表，复用
// contracts 的 `getPublicEgressIpBlockReason` 与 adapters 既有的 public egress 策略
// （specs/webfetch-public-egress.md 的同一套语义），避免出现第二套真相。

import {
  getIpAddressVersion,
  getPublicEgressIpBlockReason,
  normalizeIpAddressLiteral,
} from "@acode/contracts";
import { isPlaintextHttpBaseUrl } from "@acode/provider";
import { assertPublicEgressDestination, type DnsLookup } from "../http/public-egress-policy.js";

export type ProviderDoctorEndpointIssueCode =
  | "missing"
  | "invalid_url"
  | "unsupported_protocol"
  | "blocked_host"
  | "blocked_address";

export type ProviderDoctorEndpointVerdict =
  | {
      readonly ok: true;
      readonly url: URL;
      readonly host: string;
      readonly plaintextHttp: boolean;
    }
  | {
      readonly ok: false;
      readonly code: ProviderDoctorEndpointIssueCode;
      readonly reason: string;
    };

/**
 * 纯本地判定（offline 档用，**不做 DNS**——offline 承诺零网络）：
 * 协议白名单 + 主机名字面量 + IP 字面量的私网/保留段。
 */
export function inspectProviderEndpoint(baseUrl: string | undefined): ProviderDoctorEndpointVerdict {
  const trimmed = baseUrl?.trim();
  if (!trimmed) {
    return { ok: false, code: "missing", reason: "provider 配置缺少 api.baseUrl" };
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, code: "invalid_url", reason: `Base URL 无法解析: ${trimmed}` };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return {
      ok: false,
      code: "unsupported_protocol",
      reason: `只允许 http/https 端点，收到 ${url.protocol}`,
    };
  }

  const hostname = normalizeIpAddressLiteral(url.hostname);
  if (hostname.length === 0) {
    return { ok: false, code: "blocked_host", reason: "Base URL 缺少主机名" };
  }

  const hostReason = getBlockedHostnameReason(hostname);
  if (hostReason) {
    return { ok: false, code: "blocked_host", reason: hostReason };
  }

  // 字面量 IP 在本地就能判死；域名留给 catalog 档的 DNS 预检（offline 不解析）。
  if (getIpAddressVersion(hostname) !== 0) {
    const blocked = getPublicEgressIpBlockReason(hostname);
    if (blocked && blocked.version !== 0) {
      return {
        ok: false,
        code: "blocked_address",
        reason: `Base URL 指向非公网地址（${blocked.reason}）`,
      };
    }
  }

  return {
    ok: true,
    url,
    host: url.port ? `${url.hostname}:${url.port}` : url.hostname,
    plaintextHttp: isPlaintextHttpBaseUrl(trimmed),
  };
}

/**
 * catalog 档的出网前校验：域名解析后的**全部**地址必须公网，否则拒绝且不建连。
 * 与 WebFetch 的 public egress 同一实现（DNS 重绑定面同样被覆盖）。
 */
export async function assertProviderEndpointPublicEgress(
  baseUrl: string,
  dnsLookup: DnsLookup,
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  const verdict = inspectProviderEndpoint(baseUrl);
  if (!verdict.ok) {
    throw new Error(verdict.reason);
  }
  await assertPublicEgressDestination(verdict.url, dnsLookup, options);
}

export function providerEndpointHost(baseUrl: string | undefined): string | undefined {
  const verdict = inspectProviderEndpoint(baseUrl);
  return verdict.ok ? verdict.host : undefined;
}

/**
 * 实时模型目录端点（spec R3 #8）：
 * - openai-chat-completions / openai-responses → `{base}/models`
 * - anthropic-messages → 与 adapter 相同的 `/v1` 归一后接 `/models`
 * 其余/未知 api type → undefined（调用方记 skipped，不猜端点）。
 */
export function buildProviderCatalogUrl(
  baseUrl: string,
  apiType: string | undefined,
): string | undefined {
  const verdict = inspectProviderEndpoint(baseUrl);
  if (!verdict.ok) return undefined;
  const pathname = verdict.url.pathname.replace(/\/+$/u, "");

  if (apiType === "anthropic-messages") {
    const anthropicPath = pathname.toLowerCase().endsWith("/v1") ? pathname : `${pathname}/v1`;
    return withPath(verdict.url, `${anthropicPath}/models`);
  }
  if (apiType === "openai-chat-completions" || apiType === "openai-responses") {
    return withPath(verdict.url, `${pathname}/models`);
  }
  return undefined;
}

/** 目录端点的鉴权头按 api type 分流；值来自内存中的运行期凭据，绝不落盘。 */
export function buildProviderCatalogHeaders(
  apiType: string | undefined,
  apiKey: string,
): Record<string, string> {
  if (apiType === "anthropic-messages") {
    return { "x-api-key": apiKey, "anthropic-version": "2023-06-01" };
  }
  return { authorization: `Bearer ${apiKey}` };
}

function withPath(url: URL, pathname: string): string {
  const next = new URL(url.toString());
  next.pathname = pathname;
  next.search = "";
  next.hash = "";
  return next.toString();
}

function getBlockedHostnameReason(hostname: string): string | undefined {
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    return `端点主机名不是公网地址: ${hostname}`;
  }
  // 单标签主机名（http://intranet/…）在公网不可路由，也是 SSRF 常见目标形态。
  if (getIpAddressVersion(hostname) === 0 && hostname.split(".").length < 2) {
    return `端点主机名必须是公网域名: ${hostname}`;
  }
  return undefined;
}
