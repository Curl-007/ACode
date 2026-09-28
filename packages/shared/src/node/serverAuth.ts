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
