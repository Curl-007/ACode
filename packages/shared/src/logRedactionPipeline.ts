/**
 * 日志脱敏管线（specs/log-privacy-redaction.md R3/R4/R5/R7/R9-R12 的编排层）。
 *
 * 单一漏斗消费点（desktop main logger.write / services serviceLogger.write /
 * exportLogs 支持包）通过 createLogRedactor 拿到 redactLine，按固定阶段顺序
 * 处理每一行日志文本；任何阶段抛异常 → 整行改发 `<withheld>`（fail-closed，
 * 不存在「脱敏失败就发原文」的路径）。
 *
 * 阶段顺序（前者为后者创造安全前提）：
 * ① 设备/UNC 前缀归一 → ② SID → ③ URL userinfo 剥除 → ④ URL origin 收敛
 * → ⑤ 会话 token 泄漏门（必须先于机密形态：blob 规则会吞掉超长非法 token）
 * → ⑥ 身份路径占位符（<home>/<user>/<vol>/<unc>/<drv>:，跳过 URL authority 区间）
 * → ⑦ email/IP → ⑧ 机密值形态（词表走 sensitiveKeyNames 单源）
 * → ⑨ 主机名组合正则（注册表引用+size 缓存）。
 *
 * 脱敏是幂等的：占位符词汇在收名排除名单里，二次过管线输出不变
 * （serviceLogger 与 desktop main 双漏斗串联依赖此不变量）。
 *
 * 纯函数工厂，无 IO、无 node 依赖。
 */

import {
  createHostNameRegistry,
  casefoldName,
  type HostNameRegistry,
} from "./logRedactionHostNames.js";
import type { LogRedactionIdentity } from "./logRedactionIdentity.js";
import { redactEmailsAndIps, redactSecretValueShapes } from "./logRedactionSecrets.js";
import {
  normalizeDeviceAndUncPaths,
  redactUrlsInText,
  redactUserInfoInUrls,
  redactWindowsSids,
} from "./logRedactionUrls.js";
import { detectSuspectedSessionTokenLeak } from "./sessionEgressGate.js";

/** fail-closed 整行抑制占位符。 */
export const WITHHELD_LINE_PLACEHOLDER = "<withheld>";

/**
 * 收名排除名单：占位符词汇、日志级别词、errno/信号名、平台与 fs 动词。
 * 这些词即使被误登记进注册表也不参与组合正则，防止 `<host>` 等占位符
 * 被再次替换、防止 ENOENT 等排障关键词变形。
 */
const RESERVED_REDACTION_WORDS: ReadonlySet<string> = new Set(
  [
    // 占位符词汇（本管线与导出/反馈面共用的全部尖括号占位名）。
    "home",
    "user",
    "vol",
    "unc",
    "drv",
    "path",
    "sid",
    "url",
    "userinfo",
    "token",
    "jwt",
    "blob",
    "redacted",
    "email",
    "ip",
    "host",
    "withheld",
    "truncated",
    // 日志级别与流名。
    "stderr",
    "stdout",
    "tail",
    "error",
    "warn",
    "info",
    "debug",
    "verbose",
    "silly",
    "fatal",
    "trace",
    // 平台/架构/布尔。
    "true",
    "false",
    "null",
    "undefined",
    "darwin",
    "win32",
    "linux",
    "x64",
    "arm64",
    "ia32",
    // fs/net 动词（日志高频词，误替换会毁掉排障语义）。
    "open",
    "spawn",
    "unlink",
    "stat",
    "lstat",
    "mkdir",
    "rmdir",
    "rename",
    "rm",
    "read",
    "write",
    "connect",
    "access",
    "scandir",
    "realpath",
    "readlink",
    "symlink",
    "readdir",
    "watch",
    "listen",
    "bind",
    "copyfile",
    "chmod",
    "kill",
    "getaddrinfo",
    // errno/信号码。
    "ABORT_ERR",
    "UNKNOWN",
    "EINTR",
    "E2BIG",
    "ECHILD",
    "ENOENT",
    "EACCES",
    "EPERM",
    "EEXIST",
    "EISDIR",
    "ENOTDIR",
    "ENOTEMPTY",
    "EBUSY",
    "EMFILE",
    "ENFILE",
    "ENOSPC",
    "EROFS",
    "EXDEV",
    "EINVAL",
    "EIO",
    "EAGAIN",
    "EPIPE",
    "ELOOP",
    "ENAMETOOLONG",
    "EBADF",
    "ENOTSUP",
    "ECANCELED",
    "ECONNREFUSED",
    "ECONNRESET",
    "ECONNABORTED",
    "ETIMEDOUT",
    "EADDRINUSE",
    "EADDRNOTAVAIL",
    "ENOTFOUND",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "ENOTCONN",
    "EPROTO",
    "ESRCH",
    "ENOMEM",
    "EFBIG",
    "ETXTBSY",
    "EDQUOT",
    "ESTALE",
    "ENOEXEC",
    "SIGTERM",
    "SIGKILL",
    "SIGINT",
    "SIGHUP",
    "SIGSEGV",
    "SIGABRT",
    "SIGPIPE",
    "SIGQUIT",
    "SIGBUS",
    "SIGUSR1",
    "SIGUSR2",
  ].map((word) => word.toLowerCase()),
);

const WORD_CHAR_CLASS = String.raw`[\p{L}\p{N}_-]`;

function escapeRegExpText(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

interface HostNameRegexCache {
  namesRef: ReadonlyMap<string, unknown> | undefined;
  size: number;
  regex: RegExp | null | undefined;
}

/**
 * 主机名组合正则：注册名按长度降序拼接（长的先命中，防止子串抢跑），
 * 边界守卫含 percent-encoded 边界（`(?<=%[0-9a-f]{2})`），编码形态也命中。
 * 缓存键 =（names Map 引用, size）：仅注册表变化时重建，绝不逐行重建。
 */
function buildHostNameRegex(registry: HostNameRegistry): RegExp | null {
  const escapedNames = [...registry.names.keys()]
    .filter((name) => !RESERVED_REDACTION_WORDS.has(name))
    .sort((left, right) => right.length - left.length)
    .map(escapeRegExpText);
  if (escapedNames.length === 0) {
    return null;
  }
  return new RegExp(
    `(?:(?<=%[0-9a-f]{2})|(?<!${WORD_CHAR_CLASS})(?<!${WORD_CHAR_CLASS}\\.))` +
      `(?:${escapedNames.join("|")})` +
      `(?!${WORD_CHAR_CLASS})(?!\\.${WORD_CHAR_CLASS})`,
    "giu",
  );
}

/** 文本中 http(s)/ws(s) URL authority 区间（路径占位符替换须跳过，防劈碎 URL）。 */
function collectUrlAuthoritySpans(text: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  const pattern = /(https?:\/\/|wss?:\/\/)[^\s"',;|()]*/gi;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    const authorityStart = index + (match[1]?.length ?? 0);
    spans.push({ start: authorityStart, end: index + match[0].length });
  }
  return spans;
}

function isInUrlAuthoritySpan(
  spans: Array<{ start: number; end: number }>,
  position: number,
): boolean {
  // spans 按出现顺序即升序；日志行内 URL 数量小，线性扫描足够。
  for (const span of spans) {
    if (span.start <= position && position <= span.end) {
      return true;
    }
  }
  return false;
}

/** 身份路径占位符：<home>/<user>/<vol>/<unc>/<drv>:（R7）。 */
function redactIdentityPaths(text: string, identity: LogRedactionIdentity): string {
  const spans = collectUrlAuthoritySpans(text);
  let result = text;
  for (const homeDir of identity.homeDirs) {
    // 过短目录（如 `C:`）不做整串替换，防止把盘符前缀全部吞掉。
    if (homeDir.length >= 4) {
      result = result.split(homeDir).join("<home>");
    }
  }
  result = result
    .replace(
      /(?<![/\\])([/\\]+(?:Users|home)[/\\]+)([^/\\\n]+)/gi,
      (match, prefix: string, _segment: string, offset: number) =>
        isInUrlAuthoritySpan(spans, offset) ? match : `${prefix}<user>`,
    )
    .replace(
      /(\/(?:Volumes|mnt|media)\/)([^/\n]+)/g,
      (match, prefix: string, _segment: string, offset: number) =>
        isInUrlAuthoritySpan(spans, offset) ? match : `${prefix}<vol>`,
    )
    .replace(
      /((?:\/etc\/profiles|\/nix\/var\/nix\/profiles)\/per-user\/)([^/\n]+)/g,
      (match, prefix: string, _segment: string, offset: number) =>
        isInUrlAuthoritySpan(spans, offset) ? match : `${prefix}<user>`,
    )
    .replace(/\b([A-Za-z]):([\\/])/g, "<drv>:$2")
    .replace(/\\\\[^\\]+\\[^\\\s'",:()]+/g, "<unc>");
  return result;
}

export interface LogRedactor {
  /** 单行文本脱敏；任何异常 → `<withheld>`（R5）。 */
  redactLine(text: string): string;
  /** 单个日志参数脱敏：字符串/Error 展平脱敏；对象 JSON 化后脱敏。 */
  redactArgValue(arg: unknown): string;
}

export interface LogRedactorOptions {
  identity?: LogRedactionIdentity;
  /** 主机名注册表；缺省时创建空注册表（仍可运行期收名）。 */
  registry?: HostNameRegistry;
  /** fail-closed 触发时的诊断回调（自身异常也会被吞掉）。 */
  onError?: (error: unknown) => void;
}

const EMPTY_IDENTITY: LogRedactionIdentity = {
  homeDirs: [],
  userNames: [],
  hostNames: [],
  profileDirs: [],
};

export function createLogRedactor(options: LogRedactorOptions = {}): LogRedactor {
  const identity = options.identity ?? EMPTY_IDENTITY;
  const registry = options.registry ?? createHostNameRegistry();
  const onError = options.onError;
  // 身份名收名进注册表：userNames → <user>，hostNames（机器名/域名）→ <host>。
  registry.registerAll([
    ...identity.userNames.map((name) => [name, "user"] as const),
    ...identity.hostNames.map((name) => [name, "host"] as const),
  ]);
  const cache: HostNameRegexCache = { namesRef: undefined, size: -1, regex: undefined };

  function redactHostNames(text: string): string {
    if (cache.namesRef !== registry.names || cache.size !== registry.names.size) {
      cache.namesRef = registry.names;
      cache.size = registry.names.size;
      cache.regex = buildHostNameRegex(registry);
    }
    const regex = cache.regex;
    if (!regex) {
      return text;
    }
    return text
      .normalize("NFC")
      .replace(regex, (match) =>
        registry.names.get(casefoldName(match)) === "user" ? "<user>" : "<host>",
      );
  }

  function redactLine(text: string): string {
    if (typeof text !== "string" || text.length === 0) {
      return text;
    }
    try {
      let result = normalizeDeviceAndUncPaths(text);
      result = redactWindowsSids(result);
      result = redactUserInfoInUrls(result);
      result = redactUrlsInText(result);
      // 会话 token 泄漏门必须在机密形态（blob）替换之前：
      // 超长非法 token 会先被 base64 blob 规则吞掉，门就看不到它了。
      // 判定基于 URL 收敛后的文本——percent 编码绕过形态已在 URL 阶段还原/抑制。
      if (detectSuspectedSessionTokenLeak(result)) {
        return WITHHELD_LINE_PLACEHOLDER;
      }
      result = redactIdentityPaths(result, identity);
      result = redactEmailsAndIps(result);
      result = redactSecretValueShapes(result);
      result = redactHostNames(result);
      return result;
    } catch (error) {
      // fail-closed：脱敏链任何一步异常都整行抑制，绝不回退发原文（R5）。
      try {
        onError?.(error);
      } catch {
        // 诊断回调自身异常不影响抑制语义。
      }
      return WITHHELD_LINE_PLACEHOLDER;
    }
  }

  function redactArgValue(arg: unknown): string {
    if (typeof arg === "string") {
      return redactLine(arg);
    }
    if (arg instanceof Error) {
      const stack = typeof arg.stack === "string" && arg.stack.length > 0 ? `\n${arg.stack}` : "";
      return redactLine(`${arg.name}: ${arg.message}${stack}`);
    }
    try {
      return redactLine(JSON.stringify(arg) ?? String(arg));
    } catch {
      return redactLine(String(arg));
    }
  }

  return { redactLine, redactArgValue };
}
