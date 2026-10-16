/**
 * 深链/argv 入口硬化簇（specs/desktop-startup-hardening.md §4b–4f）。
 *
 * 深链与 second-instance argv 是外部应用可控输入：本模块集中提供去重、
 * 盘符相对路径拒绝、UNC hop 断言（防 SMB NTLM 凭据外泄）、失败 toast 限频
 * 与日志安全 URL 渲染的判定纯函数。所有判定 fail-closed：无法验证即拒绝。
 */
import { lstatSync, readlinkSync } from "node:fs";
import { dirname, join, parse as parsePath, resolve as resolvePath } from "node:path";
import { isDriveRelativeWindowsPath } from "./desktopDeepLinkUrl.js";

// ── §4b second-instance 500ms 同键去重 ──

export const SECOND_INSTANCE_DEDUPE_WINDOW_MS = 500;

export interface SecondInstanceArgvDedupe {
  /** 键 = argv + cwd 以 \0 连接；同键且间隔 < 窗口 → 重复（单槽记忆，与证据同构）。 */
  isDuplicate(argv: readonly string[], workingDirectory?: string): boolean;
}

export function createSecondInstanceArgvDedupe(
  options: { windowMs?: number; now?: () => number } = {},
): SecondInstanceArgvDedupe {
  const windowMs = options.windowMs ?? SECOND_INSTANCE_DEDUPE_WINDOW_MS;
  const now = options.now ?? Date.now;
  let previous: { key: string; at: number } | undefined;

  return {
    isDuplicate(argv, workingDirectory) {
      const key = [...argv, workingDirectory ?? ""].join("\0");
      const at = now();
      const duplicate = previous !== undefined && previous.key === key && at - previous.at < windowMs;
      previous = { key, at };
      return duplicate;
    },
  };
}

// ── §4c 盘符相对路径显式拒绝（Windows 每 drive CWD 注入面） ──
// 谓词单一事实源在 desktopDeepLinkUrl.ts（提取层同点拒绝），本模块 import 复用。

// ── §4d UNC hop 断言 ──

/**
 * UNC 网络路径谓词（单一事实源）。原居于 desktopOAuthDeepLink.ts；收敛到本模块
 * 是因为 §4d 断言与深链路由侧（desktopOAuthDeepLink 消费本模块的 toast 限频/
 * 分类/安全 URL 渲染）互为依赖会形成模块环——路由侧改为 re-export 本实现，
 * 既有 import 面（经 desktopOAuthDeepLink 取值）保持不变。
 */
export function isNetworkWorkspacePath(path: string): boolean {
  // 仅当原路径以 // 或 \\ 开头时规范化后才会以 \\ 开头；
  // 单 / 的 Unix 绝对路径不会被误判为 UNC 网络路径。
  const normalized = path.replace(/\//gu, "\\");
  return normalized.startsWith("\\\\") || /^\\\\\?\\UNC\\/iu.test(normalized);
}

/** Windows 设备命名空间前缀（\\?\、\\.\、\??\、\Device\）：可编码 UNC 或绕过形状检查。 */
export function isWindowsDeviceNamespacePath(value: string): boolean {
  return (
    /^[\\/]{2}[?.][\\/]/.test(value) ||
    /^[\\/]\?\?[\\/]/i.test(value) ||
    /^[\\/]device[\\/]/i.test(value)
  );
}

export type DeepLinkPathRejectionReason =
  | "drive_relative"
  | "unsafe_unc"
  | "unsafe_device_path"
  | "unc_hop"
  | "unverifiable";

export type DeepLinkWorkspacePathInspection =
  | { ok: true }
  | { ok: false; reason: DeepLinkPathRejectionReason };

/** 符号链接 hop 上限（与证据同值）；超限 fail-closed 拒绝。 */
const SYMLINK_HOP_LIMIT = 40;
const PATH_SEGMENT_SPLIT_RE = process.platform === "win32" ? /[\\/]+/ : /\/+/;

function classifyUnsafePathShape(value: string): "unc" | "device" | null {
  // 顺序：先 UNC（isNetworkWorkspacePath 显式覆盖 \\?\UNC\ 形态），再其余设备命名空间。
  if (isNetworkWorkspacePath(value)) {
    return "unc";
  }
  if (isWindowsDeviceNamespacePath(value)) {
    return "device";
  }
  return null;
}

/**
 * 链接目标文本的命名空间归一化（Windows）：
 * - `\\?\UNC\server\share` → `\\server\share`（还原 UNC 形态供分类拒绝）；
 * - `\\?\<本地绝对路径>` → 去前缀——目录 junction 的 readlink 目标是该形态，
 *   本地路径不应误拒（对证据的显式适配偏离：证据对一切 `\\?\` 目标直接拒绝，
 *   ACode 的 Windows 工作区中 junction 常见，fail-closed 会造成真实回归）；
 * - 其余原样返回（`\\.\` 设备形态由分类器拒绝）。
 */
function normalizeWin32NamespaceLinkTarget(target: string): string {
  const uncMatch = /^[\\/]{2}\?[\\/]UNC[\\/]/i.exec(target);
  if (uncMatch) {
    return `\\\\${target.slice(uncMatch[0].length)}`;
  }
  if (/^[\\/]{2}\?[\\/]/.test(target)) {
    return target.slice(4);
  }
  return target;
}

function readErrnoCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null
    ? (error as { code?: unknown }).code as string | undefined
    : undefined;
}

/**
 * 深链路径 UNC hop 断言（同步——深链投递链是同步的）。规则（spec §4d）：
 * 1. 原始形状命中 UNC / 设备命名空间 / 盘符相对 → 直接拒绝，绝不先 stat；
 * 2. 逐段 lstat 行走（lstat 不跟随链接，本地段安全）；遇符号链接只取 readlink
 *    **文本**判形状——对 `\\remote\share` 目标的任何 stat 都会触发 SMB 认证、
 *    外泄 NTLM hash，必须在触网前拒绝；本地目标继续行走，hop 上限 40；
 * 3. lstat/readlink 无法验证（权限等）或 hop 超限 → `unverifiable`（fail-closed）；
 * 4. ENOENT/ENOTDIR → `{ ok: true }`，存在性语义交回下游既有校验。
 */
export function inspectDeepLinkWorkspacePath(path: string): DeepLinkWorkspacePathInspection {
  if (!path || path.includes("\0")) {
    return { ok: false, reason: "unverifiable" };
  }
  if (isDriveRelativeWindowsPath(path)) {
    return { ok: false, reason: "drive_relative" };
  }
  const rawShape = classifyUnsafePathShape(path);
  if (rawShape === "unc") {
    return { ok: false, reason: "unsafe_unc" };
  }
  if (rawShape === "device") {
    return { ok: false, reason: "unsafe_device_path" };
  }

  let current: string;
  try {
    current = resolvePath(path);
  } catch {
    return { ok: false, reason: "unverifiable" };
  }

  for (let hops = 0; ; ) {
    const walkedShape = classifyUnsafePathShape(current);
    if (walkedShape === "unc") {
      return { ok: false, reason: hops > 0 ? "unc_hop" : "unsafe_unc" };
    }
    if (walkedShape === "device") {
      return { ok: false, reason: hops > 0 ? "unc_hop" : "unsafe_device_path" };
    }

    const { root } = parsePath(current);
    const segments = current.slice(root.length).split(PATH_SEGMENT_SPLIT_RE).filter(Boolean);
    let prefix = root;
    let index = 0;
    for (; index < segments.length; index++) {
      prefix = join(prefix, segments[index]!);
      let stats;
      try {
        stats = lstatSync(prefix, { throwIfNoEntry: false });
      } catch (error) {
        const code = readErrnoCode(error);
        if (code === "ENOENT" || code === "ENOTDIR") {
          return { ok: true };
        }
        return { ok: false, reason: "unverifiable" };
      }
      if (!stats) {
        return { ok: true };
      }
      if (stats.isSymbolicLink()) {
        break;
      }
    }
    if (index === segments.length) {
      // 全链无符号链接：本地路径，放行（存在性由下游校验）。
      return { ok: true };
    }

    if (++hops > SYMLINK_HOP_LIMIT) {
      return { ok: false, reason: "unverifiable" };
    }
    let linkTarget: string;
    try {
      linkTarget = readlinkSync(prefix);
    } catch {
      return { ok: false, reason: "unverifiable" };
    }
    const normalizedTarget = normalizeWin32NamespaceLinkTarget(linkTarget);
    // 只对链接文本判形状，绝不 stat 目标本身（防 SMB 触发）。
    if (classifyUnsafePathShape(normalizedTarget) !== null) {
      return { ok: false, reason: "unc_hop" };
    }
    try {
      current = resolvePath(dirname(prefix), normalizedTarget, ...segments.slice(index + 1));
    } catch {
      return { ok: false, reason: "unverifiable" };
    }
  }
}

// ── §4e 深链失败 toast：闭集分类 + (键,类别) 5 分钟限频 + 本地化文案 ──

export type DeepLinkFailureCategory = "auth_expired" | "network" | "missing" | "other";

export const DEEP_LINK_FAILURE_TOAST_WINDOW_MS = 300_000;

/** 错误子串 → 闭集类别（首中即归；表集中一处，扩展只改这里）。 */
const DEEP_LINK_FAILURE_CATEGORY_SUBSTRINGS: readonly (readonly [DeepLinkFailureCategory, string])[] =
  [
    ["auth_expired", "登录已过期"],
    ["auth_expired", "sign-in has expired"],
    ["auth_expired", "auth expired"],
    ["auth_expired", "token expired"],
    ["auth_expired", "oauth state expired"],
    ["network", "网络"],
    ["network", "network"],
    ["network", "ECONNREFUSED"],
    ["network", "ENOTFOUND"],
    ["network", "ETIMEDOUT"],
    ["network", "ECONNRESET"],
    ["network", "fetch failed"],
    ["network", "socket hang up"],
    ["missing", "不存在"],
    ["missing", "已移除"],
    ["missing", "not found"],
    ["missing", "missing"],
    ["missing", "ENOENT"],
  ];

export function classifyDeepLinkFailureCategory(message: string): DeepLinkFailureCategory {
  for (const [category, substring] of DEEP_LINK_FAILURE_CATEGORY_SUBSTRINGS) {
    if (message.includes(substring)) {
      return category;
    }
  }
  return "other";
}

export interface DeepLinkFailureToastDecision {
  /** (键,类别) 5 分钟窗口内是否放行展示。 */
  showToast: boolean;
  /** 键级窗口内是否重复（遥测/日志维度，与展示抑制独立记账）。 */
  isRepeat: boolean;
}

export interface DeepLinkFailureToastGate {
  recordFailure(key: string, category: DeepLinkFailureCategory): DeepLinkFailureToastDecision;
}

/** 双账本限频（与证据同构）：键级产出 isRepeat；(键,类别) 级产出 showToast。 */
export function createDeepLinkFailureToastGate(
  options: { windowMs?: number; now?: () => number } = {},
): DeepLinkFailureToastGate {
  const windowMs = options.windowMs ?? DEEP_LINK_FAILURE_TOAST_WINDOW_MS;
  const now = options.now ?? Date.now;
  const keyLevelLastShown = new Map<string, number>();
  const keyCategoryLevelLastShown = new Map<string, number>();

  const recordWithinWindow = (ledger: Map<string, number>, key: string): boolean => {
    const at = now();
    const previous = ledger.get(key);
    ledger.set(key, at);
    for (const [entryKey, entryAt] of ledger) {
      if (at - entryAt >= windowMs) {
        ledger.delete(entryKey);
      }
    }
    return previous !== undefined && at - previous < windowMs;
  };

  return {
    recordFailure(key, category) {
      const isRepeat = recordWithinWindow(keyLevelLastShown, key);
      const suppressed = recordWithinWindow(keyCategoryLevelLastShown, `${key}:${category}`);
      return { showToast: !suppressed, isRepeat };
    },
  };
}

/**
 * main 进程无 i18n runtime，沿用 resolveExternalWorkspaceOpenDialogCopy 的 locale
 * 分支模式；迁入 UI locales 时的键名登记见 spec「locale 键需求」。
 */
export function resolveDeepLinkFailureToastCopy(
  category: DeepLinkFailureCategory,
  locale: string,
): { title: string; body: string } {
  if (locale === "zh-CN") {
    switch (category) {
      case "auth_expired":
        return { title: "登录已过期", body: "请重新登录 ACode 后，再尝试打开该链接。" };
      case "network":
        return { title: "网络不可用", body: "请检查网络连接后，再尝试打开该链接。" };
      case "missing":
        return { title: "目标不存在", body: "该链接指向的内容可能已被移除。" };
      case "other":
        return { title: "无法打开链接", body: "ACode 未能处理该链接。" };
    }
  }
  switch (category) {
    case "auth_expired":
      return { title: "Sign-in expired", body: "Sign in to ACode again, then try opening this link." };
    case "network":
      return { title: "Network unavailable", body: "Check your connection, then try opening this link again." };
    case "missing":
      return { title: "Target not found", body: "The content this link points to may have been removed." };
    case "other":
      return { title: "Couldn't open link", body: "ACode couldn't handle this link." };
  }
}

// ── §4f 日志安全 URL 渲染 ──

/**
 * 只保留 protocol/host/首段路径；query → `?…`、hash → `#…`——深链 query 携带
 * OAuth code/state、支付回调参数，绝不允许原样落日志。解析失败 → `(unparseable)`
 * （外部输入的原始垃圾串同样不进日志）。
 */
export function renderSafeUrlForLog(value: string): string {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(value);
  } catch {
    return "(unparseable)";
  }
  const [firstSegment] = parsedUrl.pathname.split("/").filter(Boolean);
  // host 后固定补 "/"，首段路径可为空（根 URL 渲染成 `host/`，与证据同构）。
  return `${parsedUrl.protocol}//${parsedUrl.host}/${firstSegment ?? ""}${
    parsedUrl.search ? "?…" : ""
  }${parsedUrl.hash ? "#…" : ""}`;
}
