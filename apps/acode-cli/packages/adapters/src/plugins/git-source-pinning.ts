import { PLUGIN_REPOSITORY_ALLOWED_HOSTS } from "./github-archive-source.js";

/**
 * 插件 git 源的供应锚定（pin）与 host 白名单策略（安全加固 P2 #8）。
 *
 * 背景：zip 源已强制 sha256（`readRequiredZipPluginSourceSha256`），但 git 源仍
 * `--depth 1` clone 浮动 branch/HEAD，清单被篡改或仓库被投毒时，用户每次"安装/更新"
 * 拿到的代码都可能不同，无法审计也无法复现。本模块把「是否允许安装」收敛为纯函数判定，
 * 由 `marketplace.ts` 在仓库源物化（archive/git）之前统一执行，不真正跑 git。
 *
 * 单一事实源：
 * - host 白名单常量来自 `github-archive-source.ts`（与 Archive 快路径同源）；
 * - commit pin 的字段解析复用 `marketplace.ts` 的 `readPluginSourceIdentityPin`
 *   （sha / commit / zip sha256 兼容写法），本模块只做决策。
 */

/** 与 GitHub Archive 快路径共用的 host 白名单（github.com 起，见 spec 取舍记录）。 */
export const PLUGIN_REPOSITORY_SOURCE_ALLOWED_HOSTS = PLUGIN_REPOSITORY_ALLOWED_HOSTS;

/** git clone `--branch` 无法取完整 commit SHA；ref 是 40 位 hex 时按「已锚定」处理。 */
const COMMIT_SHA_PATTERN = /^[a-f0-9]{40}$/u;

/** 允许物化插件源的网络协议；明文 http 一律拒绝（凭据与内容会明文过网）。 */
const ALLOWED_PLUGIN_SOURCE_PROTOCOLS = new Set(["https:", "ssh:", "git+https:", "git+ssh:"]);

export interface PluginRepositorySourcePinInput {
  /** 声明的浮动 ref（branch/tag）；tag 同样可被移动，只有 commit SHA 是不可变锚点。 */
  ref?: string;
  /** 声明的 commit 锚点（来源字段 sha/commit/zip sha256，已由调用方解析）。 */
  sha?: string;
  /** 清单作者显式接受浮动 ref 供应链风险的逃生门（source 对象里的 `allowFloatingRef: true`）。 */
  allowFloatingRef?: unknown;
}

export type PluginRepositorySourcePinDecision =
  | { readonly action: "install-pinned"; readonly pin: string }
  | { readonly action: "install-floating" }
  | { readonly action: "reject-floating"; readonly reason: string };

/**
 * 决定一个仓库型插件源是否允许安装：
 * - 有 commit SHA（sha/commit 字段，或 ref 本身是 40 位 hex）→ 允许，按锚点物化（现状保留）；
 * - 无锚点且声明 `allowFloatingRef: true` → 允许浮动 clone（显式 opt-in，行为同旧版）；
 * - 其余浮动 ref/HEAD → 拒绝，reason 面向清单作者给出可操作的修复方式。
 *
 * 向后兼容取舍：拒绝是 fail-closed 的默认值。已安装插件的缓存不受影响，只有新的
 * 安装/更新需要清单作者补 sha 或显式 opt-in；这样存量被投毒的浮动清单无法继续
 * 静默分发新代码。完整取舍见 apps/acode-cli/specs/plugin-git-source-pinning.md。
 */
export function resolvePluginRepositorySourcePinDecision(
  input: PluginRepositorySourcePinInput,
): PluginRepositorySourcePinDecision {
  const sha = typeof input.sha === "string" ? input.sha.trim() : "";
  if (sha) return { action: "install-pinned", pin: sha };
  const ref = typeof input.ref === "string" ? input.ref.trim() : "";
  if (COMMIT_SHA_PATTERN.test(ref)) return { action: "install-pinned", pin: ref };
  if (input.allowFloatingRef === true) return { action: "install-floating" };
  const floating = ref || "HEAD";
  return {
    action: "reject-floating",
    reason:
      `Plugin git source pins floating ref "${floating}". Add an immutable "sha" (or "commit") to the source, ` +
      'or set "allowFloatingRef": true to explicitly accept the supply-chain risk of a floating ref.',
  };
}

/**
 * 解析插件源 URL 的 host（小写）。兼容三类形态：
 * - WHATWG URL（https://、ssh://、git+https:// 等）；
 * - scp-like Git SSH 语法 `git@host:path`（不是合法 URL，单独取 host 段）；
 * - 解析失败返回 null（调用方按不允许处理）。
 */
export function parsePluginRepositorySourceHost(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    return url.hostname ? url.hostname.toLowerCase() : null;
  } catch {
    const at = trimmed.indexOf("@");
    if (at <= 0) return null;
    const colon = trimmed.indexOf(":", at);
    if (colon <= at) return null;
    const host = trimmed.slice(at + 1, colon).trim().toLowerCase();
    return host || null;
  }
}

/** host 与协议是否都在白名单内。host 大小写归一；明文 http 与未知协议一律拒绝。 */
export function isPluginGitSourceHostAllowed(url: string): boolean {
  const trimmed = url.trim();
  if (!trimmed) return false;
  let protocol: string;
  try {
    protocol = new URL(trimmed).protocol;
  } catch {
    // scp-like 语法（git@host:path）只可能是 SSH 形态。
    protocol = "ssh:";
  }
  if (!ALLOWED_PLUGIN_SOURCE_PROTOCOLS.has(protocol)) return false;
  const host = parsePluginRepositorySourceHost(trimmed);
  return host !== null && PLUGIN_REPOSITORY_SOURCE_ALLOWED_HOSTS.has(host);
}

/**
 * 组合校验：返回违规原因（可直接作为诊断消息），允许安装时返回 null。
 * host 白名单优先于 pin 检查——host 不受信时锚定也没有意义。
 */
export function describePluginRepositorySourcePolicyViolation(input: {
  ref?: string;
  sha?: string;
  allowFloatingRef?: unknown;
  url: string;
}): string | null {
  if (!isPluginGitSourceHostAllowed(input.url)) {
    const host = parsePluginRepositorySourceHost(input.url) ?? "unparseable host";
    return (
      `Plugin git source host is not allowed: ${host}. Allowed hosts: ` +
      `${[...PLUGIN_REPOSITORY_SOURCE_ALLOWED_HOSTS].join(", ")}. ` +
      "Use an allowed host, or distribute via a sha256-verified ZIP source."
    );
  }
  const decision = resolvePluginRepositorySourcePinDecision(input);
  return decision.action === "reject-floating" ? decision.reason : null;
}
