import { createHash, timingSafeEqual } from "node:crypto";
import {
  ANONYMOUS_HOST_CAPABILITY_PRINCIPAL,
  type HostCapabilityPrincipal,
} from "./hostCapability.js";

/**
 * Server 鉴权与升级信任原语（Node-only）。
 *
 * 安全加固 P0-1/P0-2：两套 server 实现（`packages/server`、`packages/acode-server-cli`）
 * 此前各自维护「loopback 判定 + fail-closed 抛错」，且 `packages/server` 缺少非 loopback 无 token
 * 的拒绝启动不变量。这里把同一不变量提到 `@acode/shared/node` 共享层，避免两条实现分叉。
 * 仅含 `node:crypto`，不进浏览器主入口（见 `packages/shared/src/node.ts` 的子路径约定）。
 */

/** loopback 主机名集合：与既有 `server-core/http.ts` 的 fail-closed 先例保持同一定义。 */
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1"]);

/** 去掉 IPv6 字面量的方括号（`new URL("http://[::1]").hostname` 返回 `[::1]`）。 */
function stripIpv6Brackets(value: string): string {
  return value.replace(/^\[/, "").replace(/\]$/, "");
}

/** 主机名（不含端口）是否为 loopback。 */
export function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(stripIpv6Brackets(hostname.trim().toLowerCase()));
}

/**
 * 绑定 host 是否为 loopback。`0.0.0.0` / `::` 绑定所有网卡，属**非** loopback，
 * 必须配 token 才能启动（fail-closed）。
 */
export function isLoopbackBindHost(host: string): boolean {
  return isLoopbackHostname(host);
}

/** 从 `host[:port]` 中取出主机名部分（兼容 IPv6 字面量）。 */
function hostnameFromHostHeader(host: string): string {
  const trimmed = host.trim();
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    return end >= 0 ? stripIpv6Brackets(trimmed.slice(0, end + 1)) : stripIpv6Brackets(trimmed);
  }
  const colon = trimmed.lastIndexOf(":");
  return colon > 0 ? trimmed.slice(0, colon) : trimmed;
}

export interface ServerAuthInvariantInput {
  /** 已解析的具体绑定 host（调用方需先把「未指定」归一为默认值，如 `127.0.0.1`）。 */
  host: string;
  /** 是否要求鉴权（配置了合法 token）。 */
  authRequired: boolean;
}

/**
 * fail-closed 启动不变量：非 loopback 绑定且未配置 token 时拒绝启动。
 * 与 `server-core/http.ts` 既有先例同源，两套 server 共用，避免行为分叉。
 */
export function assertServerAuthInvariant(input: ServerAuthInvariantInput): void {
  if (isLoopbackBindHost(input.host) || input.authRequired) {
    return;
  }
  throw new Error(
    `Non-loopback bind host ${input.host} requires an auth token; refusing to start without authentication`,
  );
}

/** loopback 无 token 启动时的醒目告警文案（两套 server 共用同一串，便于日志检索）。 */
export function describeNoAuthLoopbackWarning(host: string): string {
  return `SECURITY WARNING: no auth token configured — server listens on loopback (${host}) only and is NOT protected. Any local process or browser page can reach it. Set ACODE_SERVER_AUTH_TOKEN to require authentication.`;
}

/** 定长比较，长度不等直接假，避免 token 比较的时序侧信道。 */
export function timingSafeTokenEquals(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** 解析 `Authorization: Bearer <token>`；非 Bearer 或缺失返回 undefined。 */
export function parseBearerToken(header: string | undefined): string | undefined {
  const value = header?.trim();
  if (!value) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(value);
  const token = match?.[1]?.trim();
  return token ? token : undefined;
}

// ── 请求 token 裁决单一实现（M1 配套：Server Core 接入 token 时从 packages/server 提取）──
//
// 此前「cookie 名 / cookie 安全解码 / 凭据接受顺序 / 受保护路径判定」只存在于
// packages/server/src/http.ts。Server Core 接入同一 token 能力时若再写一份，就是第二套
// 可分叉的实现（server-auth.md 明确禁止）。提取到这里后两套 server 共用同一裁决，
// 语义与原 http.ts 完全一致（既有 server-auth 测试即回归护栏）。

/** lite token cookie 名（浏览器兼容路径；与历史写入端同名）。 */
export const SERVER_LITE_TOKEN_COOKIE_NAME = "acode_lite_token";

/** WebSocket 升级路径（`/ws`、`/ws/**`）；R2 收缩后 query token 的唯一有效面。 */
export function isWebSocketUpgradePathname(pathname: string): boolean {
  return pathname === "/ws" || pathname.startsWith("/ws/");
}

/** 配置 token 后必须携带合法凭据的路径：`/ws*` 升级与 `/api/**`；静态资源/SPA fallback 不在内。 */
export function isTokenProtectedPathname(pathname: string): boolean {
  return isWebSocketUpgradePathname(pathname) || pathname.startsWith("/api/");
}

function parseCookieHeaderValue(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!header) {
    return cookies;
  }
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name) {
      cookies.set(name, value);
    }
  }
  return cookies;
}

/**
 * 读取 `acode_lite_token` cookie 的值，与写入端（`encodeURIComponent`）对称地安全解码。
 *
 * **为什么必须有这一个 helper**：鉴权（`resolveServerTokenAuth`）与主体绑定
 * （`readPresentedServerToken`）必须对「本次请求出示的是哪个 token」给出**完全相同**的答案。
 * 历史上两处各自读 cookie——一处比较原值、一处 `decodeURIComponent`——导致含 `%XX` 的 token
 * 会出现「中间件认可、绑定校验算出不同主体」的分叉：合法 cookie 升级被 403（principal-mismatch），
 * 含裸 `%` 的 token 还会让 `decodeURIComponent` 抛 URIError → 500。
 *
 * 解码失败时回退原值而不是抛错：cookie 可能来自旧客户端或非本服务写入，
 * 鉴权/绑定都不应因为一个畸形值而 500，比较不上自然就是「不匹配」。
 */
function readLiteTokenCookieValue(cookieHeader: string | undefined): string | undefined {
  const raw = parseCookieHeaderValue(cookieHeader).get(SERVER_LITE_TOKEN_COOKIE_NAME);
  if (raw === undefined) {
    return undefined;
  }
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** 请求侧只读视图：两套 server 从各自框架（hono Context）适配出这三项后交给共享裁决。 */
export interface ServerTokenRequestView {
  /** `Authorization` 请求头原值。 */
  authorizationHeader?: string;
  /** `Cookie` 请求头原值。 */
  cookieHeader?: string;
  /** 完整请求 URL（含 pathname 与 query）。 */
  url: string;
}

export interface ServerTokenAuthResult {
  valid: boolean;
  /**
   * HTTP 路由上出示了**合法**的 `?token=` query 并被拒绝（R2 收缩后 query 只在 WebSocket
   * 升级握手有效）；调用点据此打印一次性「已移除」告警，给旧客户端明确迁移路径。
   */
  viaDeprecatedQuery: boolean;
}

/**
 * 裁决请求出示的 token 是否合法：`Authorization: Bearer` 优先，其次 `acode_lite_token`
 * cookie（浏览器兼容），最后 `?token=` query——query 仅在 `/ws*` 升级路径构成有效凭据；
 * HTTP 路由出示合法 query 返回 `{valid:false, viaDeprecatedQuery:true}`（query 会泄漏进
 * 日志/历史/Referer，兼容窗已按 server-auth.md R2 关闭）。
 */
export function resolveServerTokenAuth(
  view: ServerTokenRequestView,
  expectedToken: string,
): ServerTokenAuthResult {
  const bearer = parseBearerToken(view.authorizationHeader);
  if (timingSafeTokenEquals(bearer, expectedToken)) {
    return { valid: true, viaDeprecatedQuery: false };
  }
  if (timingSafeTokenEquals(readLiteTokenCookieValue(view.cookieHeader), expectedToken)) {
    return { valid: true, viaDeprecatedQuery: false };
  }
  const url = new URL(view.url);
  const queryToken = url.searchParams.get("token") ?? undefined;
  if (!timingSafeTokenEquals(queryToken, expectedToken)) {
    return { valid: false, viaDeprecatedQuery: false };
  }
  if (isWebSocketUpgradePathname(url.pathname)) {
    return { valid: true, viaDeprecatedQuery: false };
  }
  return { valid: false, viaDeprecatedQuery: true };
}

/**
 * 取出本次请求实际出示的 token（`Authorization: Bearer` > cookie > query）。
 *
 * 主体绑定校验要的是「出示的是哪一个主体」，必须与 `resolveServerTokenAuth` **同源**读取——
 * cookie 一律经 `readLiteTokenCookieValue`，避免「中间件认可 A、绑定校验取到 B」的分叉。
 * R2 收缩后 query 只在 WS 升级路径构成有效凭据，优先级顺序保持两者答案一致。
 */
export function readPresentedServerToken(view: ServerTokenRequestView): string | undefined {
  const bearer = parseBearerToken(view.authorizationHeader);
  if (bearer) {
    return bearer;
  }
  const fromCookie = readLiteTokenCookieValue(view.cookieHeader);
  if (fromCookie) {
    return fromCookie;
  }
  return new URL(view.url).searchParams.get("token") ?? undefined;
}

/**
 * 已认证主体指纹：`sha256(token)` 前 16 hex。用于把铸造的 host capability 绑定到主体，
 * **绝不**含原始 token，可安全落日志。
 */
export function fingerprintPrincipal(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

/**
 * 能力与主体绑定校验（安全加固 P0-1）。
 *
 * 能力在铸造时绑定到已认证主体指纹；兑换时必须核对「本次升级出示的主体」与
 * 「铸造该能力的主体」一致，否则 A 主体铸造的能力可被持有 nonce 的 B 主体在 TTL 内
 * 兑换（主体混淆）。
 *
 * **为什么是共享 helper 而不是各 server 内联**：`packages/server` 与 `packages/acode-server-cli`
 * 是两套 server 实现。对抗评审核实过两侧此前都把 `consume()` 的返回值丢弃，
 * 使绑定形同虚设——同一个 bug 在两处各犯一次。收敛到单一实现后，将来
 * server-core 接入 token 时绑定会**自动生效**，无需再改两处，也不会再分叉。
 *
 * 未配置 token（`configuredToken` 为空）时返回 allow：该场景下所有主体都是 anonymous，
 * 比较恒成立、不提供任何屏障。此时真正的边界是 loopback 绑定本身 + fail-closed 不变量
 * + 启动告警（见 `assertServerAuthInvariant`），不是这条校验。
 */
export interface HostCapabilityBindingInput {
  /** 能力上绑定的主体（`consume()` 的返回值）。 */
  boundPrincipal: HostCapabilityPrincipal;
  /** 本 server 配置的 token；未配置（loopback 无鉴权）时为空。 */
  configuredToken?: string | null;
  /** 本次升级请求实际出示的 token（Bearer > cookie > 已弃用 query）。 */
  presentedToken?: string | null;
}

export interface HostCapabilityBindingResult {
  allowed: boolean;
  reason?: "principal-mismatch";
}

export function resolveHostCapabilityBinding(
  input: HostCapabilityBindingInput,
): HostCapabilityBindingResult {
  const configuredToken = input.configuredToken?.trim();
  if (!configuredToken) {
    return { allowed: true };
  }
  const presentedToken = input.presentedToken?.trim();
  const presentedPrincipal: HostCapabilityPrincipal = presentedToken
    ? { fingerprint: fingerprintPrincipal(presentedToken) }
    : ANONYMOUS_HOST_CAPABILITY_PRINCIPAL;
  if (presentedPrincipal.fingerprint !== input.boundPrincipal.fingerprint) {
    return { allowed: false, reason: "principal-mismatch" };
  }
  return { allowed: true };
}

export interface RequestOriginTrustInput {
  /** 升级请求的 `Origin` 头（浏览器跨源 WS 必带；原生客户端通常不带）。 */
  origin?: string | null;
  /** 升级请求的 `Host` 头。 */
  host?: string | null;
  /** 显式配置的允许来源（完整 origin，如 `http://192.168.1.10:3030`）。 */
  allowedOrigins?: readonly string[];
}

export interface RequestOriginTrustResult {
  allowed: boolean;
  reason?: "origin" | "host";
}

/**
 * 敏感入口的 Origin/Host 裁决（防 DNS-rebinding / 恶意网页驱动请求）。
 *
 * 用于两类入口，策略一致：
 * - `/ws/host` 升级（trusted-host-relay 提权路径）；
 * - `POST /api/rpc-host-capability` 铸造（该端点在默认无 token 的 loopback 配置下无鉴权，
 *   而浏览器跨源 simple POST 不需要 CORS 预检——不拦 Origin 的话，恶意网页即使读不到响应
 *   也能灌满能力槽位，把内存耗尽 DoS 换成可用性 DoS）。
 *
 * 裁决规则：
 * - 无 `Origin`：原生客户端（Node `ws` / SSH 隧道内的 desktop host / 进程内 fetch），放行，
 *   由能力 ticket 与鉴权把关。
 * - 有 `Origin`（浏览器）：仅允许 loopback origin 或显式白名单 origin；否则拒绝（reason=origin）。
 *   浏览器上下文下再校验 `Host`：必须为 loopback 或白名单派生 host，否则拒绝（reason=host）。
 *
 * 只在浏览器上下文（带 Origin）才强制 Host，避免误伤经隧道/LAN 的原生受信客户端。
 */
export function resolveRequestOriginTrust(
  input: RequestOriginTrustInput,
): RequestOriginTrustResult {
  const allowedOrigins = (input.allowedOrigins ?? [])
    .map((origin) => origin.trim().toLowerCase())
    .filter((origin) => origin.length > 0);
  const allowedOriginSet = new Set(allowedOrigins);
  // Host 白名单由 allowedOrigins 派生（取其 host 部分），叠加 loopback。
  const allowedHosts = new Set<string>();
  for (const origin of allowedOrigins) {
    try {
      const parsed = new URL(origin);
      allowedHosts.add(parsed.host.toLowerCase());
      allowedHosts.add(parsed.hostname.toLowerCase());
    } catch {
      allowedHosts.add(origin);
    }
  }

  const origin = input.origin?.trim();
  if (!origin) {
    // 原生客户端无 Origin（Node `ws` / SSH 隧道内的 desktop host）；放行，由能力 ticket 把关。
    // 注意：浏览器沙箱 iframe 会发送字面量 `Origin: null`，它**不是** loopback 也不在白名单，
    // 故不在此放行——落到下方 URL 解析失败分支被拒（reason=origin）。
    return { allowed: true };
  }

  let originHostname: string;
  let originNormalized: string;
  try {
    const parsed = new URL(origin);
    originHostname = stripIpv6Brackets(parsed.hostname.toLowerCase());
    originNormalized = parsed.origin.toLowerCase();
  } catch {
    // 无法解析的 Origin 视为不可信浏览器来源。
    return { allowed: false, reason: "origin" };
  }

  const originIsLoopback = LOOPBACK_HOSTNAMES.has(originHostname);
  if (!originIsLoopback && !allowedOriginSet.has(originNormalized) && !allowedOriginSet.has(origin.toLowerCase())) {
    return { allowed: false, reason: "origin" };
  }

  const host = input.host?.trim();
  if (host) {
    const hostHostname = stripIpv6Brackets(hostnameFromHostHeader(host).toLowerCase());
    const hostIsLoopback = LOOPBACK_HOSTNAMES.has(hostHostname);
    if (!hostIsLoopback && !allowedHosts.has(host.toLowerCase()) && !allowedHosts.has(hostHostname)) {
      return { allowed: false, reason: "host" };
    }
  }

  return { allowed: true };
}
