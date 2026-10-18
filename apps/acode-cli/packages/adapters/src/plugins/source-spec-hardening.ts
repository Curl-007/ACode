/**
 * 插件/市场来源规格硬化（specs/plugin-install-transactions.md R5）。
 *
 * // Mechanism ported from oh-my-pi (MIT) docs/plugin-manager-installer-plumbing.md,
 * // Copyright (c) 2025 Mario Zechner & Stencil Labs（:82 git 规格主机集合、:84 URL 内嵌
 * // 凭据剥离、:240-241 shell 元字符黑名单）。仅移植机制语义，实现为 ACode Node 栈重写。
 *
 * 三个纯判定/纯变换职责，供 marketplace.ts 在「物化前」与「落盘前」统一执行：
 *  1. shell 元字符黑名单：进入 spawn/git 参数的 url/ref 一律拒绝元字符（execFile
 *     参数数组本不走 shell，这里是纵深防御，防后续实现改 shell 形态或 git 参数注入）；
 *  2. 市场 git 源 host 白名单：市场清单是用户显式添加的个人来源，主机闭集取
 *     omp git 简写主机集合；插件代码源的门（git-source-pinning.ts，github-only）
 *     不在本模块，宽严分层见 spec R5-1；
 *  3. URL 内嵌凭据剥离：user:token@host 在落任何持久化文件前剥离（幂等、深遍历），
 *     剥离后私有仓库认证依赖 git credential helper / SSH（omp 同语义）。
 */

import { isRecord } from "./helpers.js";

/**
 * git 规格元字符黑名单（omp :241 SHELL_METACHARS：; & | ` $ ( ) { } < > \ 换行 CR tab；
 * \s 覆盖空白符全集）。npm 规格集里的方括号不收录：ACode 没有 feature-bracket 语法，
 * 且 git ref/URL 出现方括号应走各 schema 的显式拒绝而不是元字符门。
 */
const PLUGIN_GIT_SPEC_METACHAR_PATTERN = /[\s;|`$(){}<>\\&]/u;

/**
 * 市场 git URL 规格的 host 白名单（omp :82 简写主机集合 + 既有 github www 变体）。
 * 明文 http 与未知协议由协议白名单拒绝（与 git-source-pinning.ts 同规则）。
 */
export const MARKETPLACE_GIT_SPEC_ALLOWED_HOSTS: ReadonlySet<string> = new Set([
  "github.com",
  "www.github.com",
  "gitlab.com",
  "bitbucket.org",
  "codeberg.org",
  "git.sr.ht",
]);

/** 市场 git 规格允许的网络协议；与插件仓库源门保持同一协议闭集。 */
const ALLOWED_MARKETPLACE_GIT_SPEC_PROTOCOLS = new Set(["https:", "ssh:", "git+https:", "git+ssh:"]);

/** 单个值命中黑名单时的可操作拒绝原因；null = 通过。 */
export function describeShellMetacharViolation(value: string, field: string): string | null {
  const match = PLUGIN_GIT_SPEC_METACHAR_PATTERN.exec(value);
  if (!match) return null;
  return (
    `Plugin ${field} contains a shell metacharacter (${JSON.stringify(match[0])}); ` +
    "characters ; & | ` $ ( ) { } < > \\ and whitespace are not allowed in plugin git specs."
  );
}

/** 复用 git-source-pinning 的 host/协议解析口径（URL 与 scp-like 语法同源，避免两套规则漂移）。 */
function parseSourceHostAndProtocol(value: string): { host: string | null; protocol: string | null } {
  const trimmed = value.trim();
  if (!trimmed) return { host: null, protocol: null };
  try {
    const url = new URL(trimmed);
    return { host: url.hostname ? url.hostname.toLowerCase() : null, protocol: url.protocol };
  } catch {
    // scp-like（user@host:path）只可能是 SSH 形态，与插件仓库源门同判。
    const scpLike = /^([^\s/@]+)@([^\s:]+):(.+)$/u.exec(trimmed);
    if (!scpLike) return { host: null, protocol: null };
    return { host: scpLike[2]?.toLowerCase() ?? null, protocol: "ssh:" };
  }
}

export interface MarketplaceGitSourceSpecInput {
  url: string;
  ref?: string;
}

/**
 * 市场 git URL 规格的组合门（spec R5-1/R5-3）：元字符 → 协议 → host 白名单。
 * 返回 violation 原因（可直接作为诊断消息），允许时返回 null。
 */
export function describeMarketplaceGitSourceSpecViolation(
  input: MarketplaceGitSourceSpecInput,
): string | null {
  const metachar =
    describeShellMetacharViolation(input.url, "marketplace git source url") ??
    (input.ref !== undefined
      ? describeShellMetacharViolation(input.ref, "marketplace git source ref")
      : null);
  if (metachar) return metachar;
  const { host, protocol } = parseSourceHostAndProtocol(input.url);
  if (!protocol || !ALLOWED_MARKETPLACE_GIT_SPEC_PROTOCOLS.has(protocol)) {
    return `Plugin marketplace git source protocol is not allowed: ${protocol ?? "unparseable"}. Use https or ssh.`;
  }
  if (!host || !MARKETPLACE_GIT_SPEC_ALLOWED_HOSTS.has(host)) {
    return (
      `Plugin marketplace git source host is not allowed: ${host ?? "unparseable host"}. ` +
      `Allowed hosts: ${[...MARKETPLACE_GIT_SPEC_ALLOWED_HOSTS].join(", ")}.`
    );
  }
  return null;
}

export interface UrlCredentialStripResult {
  /** 剥离后的字符串；无凭据时与输入相同。 */
  redacted: string;
  /** 是否剥掉了凭据（调用方据此告警）。 */
  hadCredentials: boolean;
}

/** 探测字符串是否携带 URL userinfo（WHATWG 与正则兜底两种形态），并返回凭据前的 host。 */
function detectUrlCredentials(value: string): { host: string } | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  // WHATWG 解析成立且存在 authority host 时才信任 URL 形态；非 special scheme 的
  // opaque 解析（myuser:tok@host:path 会被当成 protocol "myuser:" 的不透明路径）
  // 不携带 username，落回正则形态判定。
  try {
    const url = new URL(trimmed);
    if ((url.username || url.password) && url.hostname) {
      return { host: url.hostname.toLowerCase() };
    }
  } catch {
    // 正则兜底处理。
  }
  const schemeForm = /^[a-zA-Z][\w+.-]*:\/\/[^\s/@:]+:[^\s/@]+@([^\s:/]+)/u.exec(trimmed);
  if (schemeForm?.[1]) return { host: schemeForm[1].toLowerCase() };
  const scpForm = /^([^\s/:@]+):([^\s/@]+)@([^\s:]+):.+$/u.exec(trimmed);
  if (scpForm?.[3]) return { host: scpForm[3].toLowerCase() };
  return null;
}

/**
 * 剥离单个字符串里的 URL userinfo（omp :84）。WHATWG 可解析且有 authority 的走
 * username/password 置空；不可解析的 scheme://user:pass@ 走正则兜底；scp-like
 * user:pass@host:path 保留用户段只剥口令段（git@host:path 里的 user 是约定
 * 用户名不是凭据，剥口令即可满足「token 不落盘」）。
 */
export function stripUserInfoFromString(value: string): UrlCredentialStripResult {
  if (!detectUrlCredentials(value)) return { redacted: value, hadCredentials: false };
  const trimmed = value.trim();
  try {
    const url = new URL(trimmed);
    if ((url.username || url.password) && url.hostname) {
      url.username = "";
      url.password = "";
      return { redacted: url.toString(), hadCredentials: true };
    }
  } catch {
    // 下方正则兜底处理。
  }
  const schemeForm = /^([a-zA-Z][\w+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/u.exec(trimmed);
  if (schemeForm?.[1]) {
    return {
      redacted: trimmed.replace(/^([a-zA-Z][\w+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/u, schemeForm[1]),
      hadCredentials: true,
    };
  }
  const scpForm = /^([^\s/:@]+):([^\s/@]+)@/u.exec(trimmed);
  if (scpForm) {
    return { redacted: trimmed.replace(/^([^\s/:@]+):[^\s/@]+@/u, `${scpForm[1]}@`), hadCredentials: true };
  }
  return { redacted: value, hadCredentials: false };
}

export interface SourceCredentialStripOutcome {
  /** 剥离后的值；结构与非命中部分保持原样（新对象，不改输入）。 */
  value: unknown;
  /** 命中并剥离凭据的 host 列表（去重，供告警面使用）。 */
  redactedHosts: string[];
}

/**
 * 深遍历 source 形态值（对象/数组/字符串），剥离全部 URL userinfo（spec R5-2）。
 * 幂等：对已剥离值原样返回（redactedHosts 为空）。只重写「确实解析出凭据」的
 * 字符串，其余内容逐字节保留——目录清单里的非 URL 文本不会被误改。
 */
export function stripPluginSourceCredentials(value: unknown): SourceCredentialStripOutcome {
  const redactedHosts = new Set<string>();
  const walk = (current: unknown): unknown => {
    if (typeof current === "string") {
      const detected = detectUrlCredentials(current);
      if (!detected) return current;
      const stripped = stripUserInfoFromString(current);
      if (!stripped.hadCredentials) return current;
      redactedHosts.add(detected.host);
      return stripped.redacted;
    }
    if (Array.isArray(current)) return current.map(walk);
    if (isRecord(current)) {
      const next: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(current)) next[key] = walk(item);
      return next;
    }
    return current;
  };
  return { value: walk(value), redactedHosts: [...redactedHosts] };
}

/** 只检测不重写：source 形态值里携带凭据的 host 列表（供校验诊断告警）。 */
export function collectPluginSourceCredentialHosts(value: unknown): string[] {
  const hosts = new Set<string>();
  const walk = (current: unknown): void => {
    if (typeof current === "string") {
      const detected = detectUrlCredentials(current);
      if (detected) hosts.add(detected.host);
      return;
    }
    if (Array.isArray(current)) {
      for (const item of current) walk(item);
      return;
    }
    if (isRecord(current)) {
      for (const item of Object.values(current)) walk(item);
    }
  };
  walk(value);
  return [...hosts];
}
