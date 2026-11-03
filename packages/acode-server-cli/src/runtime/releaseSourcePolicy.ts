// ============================================================
// Release 下载源的出口策略（specs/release-source-egress.md）
// ============================================================
// `ACODE_SERVER_RELEASE_MANIFEST_URL` 决定 server CLI 从哪儿取更新目录，而目录里的
// `archiveUrl` / `manifestUrl` 又决定下一跳去哪儿取**代码**。这条链是代码投递路径，
// 加固前却是裸 `fetch(url, { redirect: "follow" })`：无协议白名单、无主机校验、无内网/环回/
// 链路本地/metadata 阻断（2026-11-03 安全复核缺口一，docs/security/mimosa-findings-triage-2026-11.md
// §6.3.3）。对照事实：桌面侧决定「下载哪份代码」的 `ACODE_UPDATE_FEED_URL` 早有 isPackaged 门禁，
// server-cli 侧一个都没有。
//
// 三条设计决定：
//
// 1. **守卫落在 fetch 层，不落在 env 读取处**。`archiveUrl`/`manifestUrl` 来自目录**内容**，
//    不是来自 env；只在 `updatePreparation.ts` 校验 env 那个 URL 的话，控制目录的人就能把下一跳
//    指向任意地址。放在 `releaseDownload.ts` 的两个 fetch 站点，catalogUrl / archiveUrl /
//    manifestUrl 三条 URL 一次覆盖。
// 2. **`redirect: "manual"` + 逐跳校验**。`redirect: "follow"` 会让首跳的校验形同虚设——服务端
//    一个 302 就能把请求送到 `http://169.254.169.254/latest/meta-data/`。Node 的全局 fetch 在
//    manual 档返回 `type: "basic"` 的 3xx 且 `Location` 可读（2026-11-04 实测），故可以自己走跳。
// 3. **IP 阻断表不在本文件重抄一份**，复用 `@acode/shared/node` 的 `getPublicEgressIpBlockReason`
//    ——那是 doctor endpoint-policy、adapters public-egress-policy、core WebFetch guard 的同一份
//    事实源，补段时四处同时收紧。
//
// 语义与 `apps/acode-cli/packages/adapters/src/doctor/endpoint-policy.ts` 对齐（协议白名单 +
// 主机名字面量 + IP 字面量 + DNS 全地址公网），差别有二：本模块必须自己处理跳转，且提供一个
// 显式放行开关（见 `ACODE_SERVER_RELEASE_ALLOW_PRIVATE_SOURCE`）。
//
// **为什么需要那个开关**：`packages/services/specs/agent-command-env-gate.md` R3(c) 已裁决
// 「独立 acode-server-cli 分发不设打包标记：其管理员对本机有完全控制权，env 配置属合法用法」。
// 全仓只有 `updatePreparation.ts` 一处读这个 env、没有任何代码设置它，即它纯粹是部署方的选择；
// 把更新目录指向内网镜像（自建 / 离线）因此是合法用法，无条件阻断私网会**静默打断**这类部署。
// 开关不削弱威胁模型：能设置它的人本来就能设置 `ACODE_SERVER_RELEASE_MANIFEST_URL` 本身。
// 但开关**只放行主机校验，不放行协议白名单**——`file:` / `data:` / `gopher:` 对内网镜像同样没有
// 合法用途，而它们能把本地文件读进解析器。

import { lookup as defaultDnsLookup } from "node:dns/promises";
import {
  getIpAddressVersion,
  getPublicEgressIpBlockReason,
  normalizeIpAddressLiteral,
} from "@acode/shared/node";

export type ReleaseSourceDnsAddress = { address: string; family: number };
export type ReleaseSourceDnsLookup = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<ReleaseSourceDnsAddress[]>;

export type ReleaseSourceIssueCode =
  | "invalid_url"
  | "unsupported_protocol"
  | "blocked_host"
  | "blocked_address"
  | "dns_no_address"
  | "too_many_redirects";

export type ReleaseSourceVerdict =
  | {
      readonly ok: true;
      readonly url: URL;
      /** 明文 http：策略允许，但代码投递走明文意味着归档可被中途替换（见 spec 残余登记）。 */
      readonly plaintextHttp: boolean;
    }
  | {
      readonly ok: false;
      readonly code: ReleaseSourceIssueCode;
      readonly reason: string;
    };

export interface ReleaseSourceEgressOptions {
  /** DNS 解析实现，测试注入用；缺省走 `node:dns/promises` 的 lookup。 */
  dnsLookup?: ReleaseSourceDnsLookup;
  /** 最多跟随几跳；缺省 5，与主流 HTTP 客户端一致。超出即拒，不静默截断。 */
  maxRedirects?: number;
  /** 继承调用方的超时/取消边界（DNS 预检也必须能被同一个 signal 中断）。 */
  signal?: AbortSignal;
  /** fetch 实现，测试注入用。 */
  fetchImpl?: typeof fetch;
  /**
   * 允许非公网下载源（内网镜像）。缺省从 `env`（或 `process.env`）的
   * `ACODE_SERVER_RELEASE_ALLOW_PRIVATE_SOURCE === "1"` 读，与本包
   * `serviceRegistration.ts` 的 `ACODE_SERVER_SKIP_SERVICE_REGISTRATION` 同一形态。
   */
  allowPrivateSource?: boolean;
  /** 读上述开关用的 env，测试注入用。 */
  env?: NodeJS.ProcessEnv;
}

/** 只允许 http/https：`z.string().url()` 会放行 `file:` / `data:` / `gopher:`，那些不是下载源。 */
const ALLOWED_PROTOCOLS = new Set(["https:", "http:"]);

/** 内网镜像放行开关。只放行主机校验，不放行协议白名单（理由见文件头）。 */
export const RELEASE_SOURCE_ALLOW_PRIVATE_ENV = "ACODE_SERVER_RELEASE_ALLOW_PRIVATE_SOURCE";

const DEFAULT_MAX_REDIRECTS = 5;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * 被拒的下载源。刻意做成**不可重试**的错误：`releaseDownload.ts` 的
 * `isRetryableDownloadError` 只认网络抖动与 5xx，本错误的 name 不在其中，
 * 于是一次「指向内网」的配置错误会立刻失败，而不是重试三次后才失败。
 */
export class ReleaseSourceBlockedError extends Error {
  public constructor(
    public readonly code: ReleaseSourceIssueCode,
    message: string,
  ) {
    super(message);
    this.name = "ReleaseSourceBlockedError";
  }
}

export function resolveAllowPrivateReleaseSource(options: ReleaseSourceEgressOptions = {}): boolean {
  if (options.allowPrivateSource !== undefined) return options.allowPrivateSource;
  return (options.env ?? process.env)[RELEASE_SOURCE_ALLOW_PRIVATE_ENV] === "1";
}

/**
 * 纯本地判定（**不做 DNS**）：协议白名单 + 主机名字面量 + IP 字面量的私网/保留段。
 * 与 doctor 的 `inspectProviderEndpoint` 同一套语义，理由也同一条：能在本地判死的不要等 DNS。
 */
export function inspectReleaseSourceUrl(
  rawUrl: string,
  options: ReleaseSourceEgressOptions = {},
): ReleaseSourceVerdict {
  const trimmed = rawUrl.trim();
  if (trimmed === "") {
    return { ok: false, code: "invalid_url", reason: "release source URL is empty" };
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, code: "invalid_url", reason: "release source URL is not parseable" };
  }

  // 协议白名单不受放行开关影响：见文件头「开关只放行主机校验」。
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    return {
      ok: false,
      code: "unsupported_protocol",
      reason: `release source must be http/https, got ${url.protocol}`,
    };
  }

  const hostname = normalizeIpAddressLiteral(url.hostname);
  if (hostname.length === 0) {
    return { ok: false, code: "blocked_host", reason: "release source has no hostname" };
  }

  if (resolveAllowPrivateReleaseSource(options)) {
    return { ok: true, url, plaintextHttp: url.protocol === "http:" };
  }

  const hostReason = getBlockedHostnameReason(hostname);
  if (hostReason) return { ok: false, code: "blocked_host", reason: hostReason };

  // 字面量 IP 在本地就能判死；域名交给 assertPublicReleaseSource 的 DNS 预检。
  if (getIpAddressVersion(hostname) !== 0) {
    const blocked = getPublicEgressIpBlockReason(hostname);
    if (blocked && blocked.version !== 0) {
      return {
        ok: false,
        code: "blocked_address",
        reason: `release source points at a non-public address (${blocked.reason})`,
      };
    }
  }

  return { ok: true, url, plaintextHttp: url.protocol === "http:" };
}

/**
 * 出网前校验：本地判定 + **域名解析出的全部地址**都必须公网，否则拒绝且不建连。
 * 只查第一个地址是不够的——攻击者可以让公网地址排在前、内网地址排在后。
 */
export async function assertPublicReleaseSource(
  rawUrl: string,
  options: ReleaseSourceEgressOptions = {},
): Promise<URL> {
  const verdict = inspectReleaseSourceUrl(rawUrl, options);
  if (!verdict.ok) throw new ReleaseSourceBlockedError(verdict.code, verdict.reason);
  if (resolveAllowPrivateReleaseSource(options)) return verdict.url;

  const hostname = normalizeIpAddressLiteral(verdict.url.hostname);
  if (getIpAddressVersion(hostname) !== 0) return verdict.url;

  const addresses = await lookupAllAddresses(hostname, options);
  if (addresses.length === 0) {
    throw new ReleaseSourceBlockedError(
      "dns_no_address",
      `release source host ${hostname} resolved to no addresses`,
    );
  }
  for (const address of addresses) {
    const blocked = getPublicEgressIpBlockReason(address.address);
    if (blocked && blocked.version !== 0) {
      throw new ReleaseSourceBlockedError(
        "blocked_address",
        `release source host ${hostname} resolved to a non-public address (${blocked.reason})`,
      );
    }
  }
  return verdict.url;
}

/**
 * 带出口守卫的 fetch：`redirect: "manual"`，**每一跳都重新过 `assertPublicReleaseSource`**。
 *
 * 返回的 Response 是最终那一跳的响应；3xx 但没有 `Location` 的情况按原样交回调用方
 * （那不是跳转，是服务端在返回一个 3xx 状态，让调用方按 HTTP 错误处理）。
 */
export async function fetchPublicReleaseSource(
  rawUrl: string,
  init: RequestInit = {},
  options: ReleaseSourceEgressOptions = {},
): Promise<Response> {
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const doFetch = options.fetchImpl ?? fetch;
  let current = rawUrl;

  for (let redirects = 0; ; redirects += 1) {
    const url = await assertPublicReleaseSource(current, options);
    const response = await doFetch(url.toString(), { ...init, redirect: "manual" });
    if (!REDIRECT_STATUSES.has(response.status)) return response;

    const location = response.headers.get("location");
    // 先把 3xx 的 body 收干，否则 socket 不会归还连接池。
    await response.body?.cancel().catch(() => undefined);
    if (location === null) return response;
    if (redirects >= maxRedirects) {
      throw new ReleaseSourceBlockedError(
        "too_many_redirects",
        `release source exceeded ${maxRedirects} redirects`,
      );
    }
    // 相对 Location 按当前跳的 URL 解析；解析失败会在下一轮的 inspect 里被判 invalid_url。
    current = new URL(location, url).toString();
  }
}

function getBlockedHostnameReason(hostname: string): string | undefined {
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    return `release source hostname is not a public address: ${hostname}`;
  }
  // 单标签主机名（http://intranet/…）在公网不可路由，也是 SSRF 的常见目标形态。
  if (getIpAddressVersion(hostname) === 0 && hostname.split(".").length < 2) {
    return `release source hostname must be a public domain: ${hostname}`;
  }
  return undefined;
}

/**
 * 把 `node:dns/promises` 的重载 `lookup` 收窄成本模块的单一签名。直接写
 * `options.dnsLookup ?? defaultDnsLookup` 会让调用结果退化成 `LookupAddress[] | LookupAddress`
 * 联合（TS2322/TS2345），与 adapters 的 `defaultPublicDnsLookup()` 是同一手法。
 */
function resolveDnsLookup(options: ReleaseSourceEgressOptions): ReleaseSourceDnsLookup {
  if (options.dnsLookup) return options.dnsLookup;
  return defaultDnsLookup;
}

async function lookupAllAddresses(
  hostname: string,
  options: ReleaseSourceEgressOptions,
): Promise<ReleaseSourceDnsAddress[]> {
  const dnsLookup = resolveDnsLookup(options);
  const signal = options.signal;
  throwIfAborted(signal);
  const lookup = dnsLookup(hostname, { all: true, verbatim: true });
  if (!signal) return lookup;

  // DNS 预检发生在建连之前，但必须继承同一个超时/取消边界，否则一次挂死的解析
  // 会绕过调用方给 fetch 设的 idle/overall 超时。
  return await new Promise<ReleaseSourceDnsAddress[]>((resolve, reject) => {
    const onAbort = (): void => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    lookup.then(
      (addresses) => {
        signal.removeEventListener("abort", onAbort);
        resolve(addresses);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortReason(signal);
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("release source request was cancelled");
}
