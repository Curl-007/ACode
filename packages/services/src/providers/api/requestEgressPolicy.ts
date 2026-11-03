// ============================================================
// 携凭据出站请求的目标校验（services/specs/credentialed-egress-origin.md）
// ============================================================
// `NodeApiClient.request` 是 services 侧所有 ACode 后端出站请求的**唯一咽喉**：OAuth/config/billing/
// quota/snapshot 等链路都经 `dependencies.apiClient.request(...)` 或 `readApiJson(apiClient, …)`，
// 且 `packages/services/src/node.ts` 只创建一个 NodeApiClient 实例。而它请求的目标 origin 由
// env（`ACODE_BASE_URL` / `ACODE_ENDPOINT_ORIGIN` / `ZAI_BUSINESS_BASE_URL` / `BIGMODEL_API_BASE_URL`
// 等）或设置项 `acodeEndpointOrigin` 决定，加固前统一校验只有 `normalizeACodeEndpointOrigin`
// ——非空 + `new URL()` 可解析 + http/https，**无主机校验、无环回/私网/链路本地/metadata 阻断**。
// 这些请求携带 OAuth/login access token。
//
// 主次必须说清楚（否则会误判本模块的价值）：
// - **主威胁是 token 外泄，而攻击者的 origin 通常是公网的**，本模块的私网阻断**挡不住**那种情况。
//   对症的主防线是「打包态不让不可信 shell env 决定 origin」，即
//   `packages/desktop/src/main/startupSanitation.ts` 的 `PACKAGED_BOOT_ENV_DROP_KEYS`（同批扩充）。
// - 本模块是**纵深防御 + 具体 SSRF 面**：把凭据送到 `169.254.169.254`（云 metadata）、`127.0.0.1`
//   或内网主机是另一类真实滥用（凭据落进元数据服务、以 server 的网络位置探测内网），这类目标
//   **就是**非公网地址，本模块正好挡住。
//
// 判定表不在本文件重抄：复用 `@acode/shared/node` 的 `getPublicEgressIpBlockReason`，与 doctor
// endpoint-policy、adapters public-egress-policy、core WebFetch guard、以及 acode-server-cli 的
// release 下载源守卫是同一份事实源。

import { resolveRuntimeACodeEnv } from "@acode/shared";
import {
  getIpAddressVersion,
  getPublicEgressIpBlockReason,
  normalizeIpAddressLiteral,
} from "@acode/shared/node";

export type RequestTargetIssueCode = "invalid_url" | "unsupported_protocol" | "blocked_host" | "blocked_address";

export type RequestTargetVerdict =
  | { readonly ok: true; readonly url: URL }
  | { readonly ok: false; readonly code: RequestTargetIssueCode; readonly reason: string };

export interface RequestTargetEgressOptions {
  /**
   * 显式决定「是否允许非公网目标」。缺省时按 env 推导（见 `resolveAllowNonPublicRequestTarget`）。
   * 调用方可以用 `false` 强制收紧；反向不成立——不能用选项放宽到 env 未授权的范围之外。
   */
  allowNonPublic?: boolean;
  /** 读 env 用的对象，测试注入用；缺省 `process.env`。 */
  env?: NodeJS.ProcessEnv;
}

/**
 * 自建/私有 ACode 后端的显式放行开关。
 *
 * 为什么需要：把 origin 指向私有后端是合法用法，无条件阻断会把这类部署锁在门外（而且症状是
 * 登录/计费/配额全失败，很难归因）。为什么不削弱威胁模型：它只在**非打包**运行时有意义——
 * `ACODE_ENV` 与 endpoint 族 env 键都在 `PACKAGED_BOOT_ENV_DROP_KEYS` 里，打包桌面启动即被删除，
 * 攻击者拿不到这条通道；而能设置本开关的人本来就能设置 `ACODE_BASE_URL` 本身。
 */
export const ENDPOINT_ALLOW_PRIVATE_ORIGIN_ENV = "ACODE_ENDPOINT_ALLOW_PRIVATE_ORIGIN";

export class RequestTargetBlockedError extends Error {
  public constructor(
    public readonly code: RequestTargetIssueCode,
    message: string,
  ) {
    super(message);
    this.name = "RequestTargetBlockedError";
  }
}

/**
 * 是否允许把携凭据请求发往非公网目标。三个来源，优先级从高到低：
 * 1. 调用方显式传入（只能收紧）；
 * 2. `ACODE_ENDPOINT_ALLOW_PRIVATE_ORIGIN=1`（自建后端）；
 * 3. 运行时是 test 姿态（`ACODE_ENV=test`）——开发/e2e 要打本地 server。
 *
 * 第 3 条与既有机制咬合：`ACODE_ENV` 在 `PACKAGED_BOOT_ENV_DROP_KEYS` 里（该集合的注释正是
 * 「运行时『自称测试』键」），且 `isTrustedCodingPlanWebviewOrigin` 也只在 e2e 旗标下才信任
 * loopback。故打包态既不能自称 test、也不能用放行开关，本模块在打包态**总是**强制。
 */
export function resolveAllowNonPublicRequestTarget(options: RequestTargetEgressOptions = {}): boolean {
  if (options.allowNonPublic !== undefined) return options.allowNonPublic;
  const env = options.env ?? process.env;
  if (env[ENDPOINT_ALLOW_PRIVATE_ORIGIN_ENV] === "1") return true;
  return resolveRuntimeACodeEnv(env) === "test";
}

/**
 * 纯本地判定（**不做 DNS**）：协议白名单 + 主机名字面量 + IP 字面量的私网/保留段。
 *
 * 刻意不做 DNS 预检：本函数在每个 API 请求的热路径上，逐请求解析会引入一次网络往返与新的失败
 * 模式（adapters 那条路做预检，是因为它按 `egressPolicy: "public"` 显式选择了那个代价）。
 * 后果如实登记在 spec 的残余里：指向「解析到私网地址的公网域名」不在本模块射程内。
 *
 * 放行开关（`resolveAllowNonPublicRequestTarget`）**只作用于主机名与地址校验，不作用于协议白名单**
 * ——`file:` / `data:` 对自建后端与 e2e 同样没有合法用途。这与 acode-server-cli 的
 * `releaseSourcePolicy` R2/R5 是同一形态。
 */
export function inspectRequestTarget(
  input: string | URL,
  options: RequestTargetEgressOptions = {},
): RequestTargetVerdict {
  const raw = typeof input === "string" ? input.trim() : input.toString();
  if (raw === "") return { ok: false, code: "invalid_url", reason: "request target is empty" };

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, code: "invalid_url", reason: "request target is not parseable" };
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return {
      ok: false,
      code: "unsupported_protocol",
      reason: `credentialed request target must be http/https, got ${url.protocol}`,
    };
  }

  const hostname = normalizeIpAddressLiteral(url.hostname);
  if (hostname.length === 0) {
    return { ok: false, code: "blocked_host", reason: "request target has no hostname" };
  }

  if (resolveAllowNonPublicRequestTarget(options)) return { ok: true, url };

  const hostReason = getBlockedHostnameReason(hostname);
  if (hostReason) return { ok: false, code: "blocked_host", reason: hostReason };

  // 字面量 IP 在本地就能判死；域名不做解析（见上面的取舍说明）。
  if (getIpAddressVersion(hostname) !== 0) {
    const blocked = getPublicEgressIpBlockReason(hostname);
    if (blocked && blocked.version !== 0) {
      return {
        ok: false,
        code: "blocked_address",
        reason: `credentialed request target is a non-public address (${blocked.reason})`,
      };
    }
  }

  return { ok: true, url };
}

/**
 * 出站前断言。**只判目标，不看是否真的带了凭据**：`NodeApiClient` 的请求绝大多数携凭据，
 * 而逐个判断「这次有没有 token」会把安全属性绑在调用方的 header 组装顺序上——那正是本仓库
 * 反复踩过的形态（header 工厂让 `grep Authorization` 都找不全站点）。宁可多判。
 */
export function assertPublicRequestTarget(
  input: string | URL,
  options: RequestTargetEgressOptions = {},
): void {
  const verdict = inspectRequestTarget(input, options);
  if (!verdict.ok) throw new RequestTargetBlockedError(verdict.code, verdict.reason);
}

function getBlockedHostnameReason(hostname: string): string | undefined {
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    return `credentialed request target is not a public host: ${hostname}`;
  }
  if (getIpAddressVersion(hostname) === 0 && hostname.split(".").length < 2) {
    return `credentialed request target must be a public domain: ${hostname}`;
  }
  return undefined;
}
