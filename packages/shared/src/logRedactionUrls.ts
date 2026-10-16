/**
 * URL / UNC / SID 脱敏策略（specs/log-privacy-redaction.md R9/R10）。
 *
 * 规则来源是「内部服务地址不落日志」纪律的机制化：
 * - http(s)/ws(s) URL 只留 origin：`scheme://host[:port]/<path>`——
 *   排障需要知道打到了哪个服务，但 query/fragment/路径可能带签名与租户信息。
 * - host 为 IP 字面量、无点主机（localhost 除外）、.local/.lan/.internal 等
 *   内网域 → 整段 `<url>`：这些是用户内网拓扑，不是可公开的服务身份。
 * - userinfo 剥除且识别编码绕过（%40、%25*40、\u0040、\x40）——
 *   凭据藏在 authority 里时整段 `<url>`，不做部分保留。
 * - 非 http(s)/ws(s) scheme：仅当「scheme 是简单小写连字符拼写（≤20 字符）
 *   且脱敏后不变形」才保留 `scheme:` 前缀，其余 `<url>`。
 * - `\\?\` / `\\.\` / `\\?\UNC\` 设备前缀先归一再进后续脱敏，
 *   防止用设备路径形态绕过 UNC/主机名替换。
 * - Windows SID → `<sid>`。
 *
 * 纯函数，无 IO、无 node 依赖。
 */

/** Windows SID 形态：S-1-5-21-…（至少 4 段子标识符）。 */
const WINDOWS_SID_PATTERN = /\bS-1-\d+(?:-\d+){4,}\b/gi;

/** URL 尾部常见的句读：截断时先剥掉，避免把标点算进 URL。 */
const URL_TRAILING_PUNCTUATION = ")].,;:'\"}";

/**
 * 文本中的 http(s)/ws(s) URL 匹配：覆盖字面 `scheme://`、反斜杠转义
 * `scheme:\/\`、percent 编码 `scheme:%2f%2f` / `https%3a%2f%2f` 等
 * 日志常见变形，防止编码形态绕过 origin 收敛。
 */
const TEXT_URL_PATTERN = new RegExp(
  `(${[
    // https:// https:\/\ https:%2f%2f
    String.raw`https?(?::|%3a)(?:\\?\/|%2f){2}`,
    // ws:// wss://（同变形）
    String.raw`(?<!\w)wss?(?::|%3a)(?:\\?\/|%2f){2}`,
    // 半编码：`https:\/host` 形态
    String.raw`(?<![\w-])(?:https?|wss?)(?::|%3a)(?:\\?\/|%2f)(?=[a-z0-9[]])`,
    // 仅编码冒号：`https:%2f…` / `https:/\…`
    String.raw`(?<![\w-])(?:https?|wss?)(?::|%3a)(?=\/?[\\%&])`,
  ].join("|")})\\S+`,
  "gi",
);

/** 任意 scheme 的 `scheme://` 形态（自定义协议走「简单小写」门）。 */
const GENERIC_SCHEME_URL_PATTERN = /\b([a-z][a-z0-9+.-]{0,30}):\/\/(\S*)/gi;

/** IP 字面量主机（v4 点分/横线变体 + v6 方括号形态）。 */
const IP_LITERAL_HOST_PATTERN = /(?:^|[.-])(?:\d{1,3}[.-]){3}\d{1,3}(?:[.-]|$)|^\[[0-9a-f:.]+\]$/i;

/** 内网/链路本地域后缀：命中即整段 <url>。 */
const INTERNAL_DOMAIN_PATTERN = /\.(?:local|lan|home|home\.arpa|internal|localdomain|localhost)$/i;

/** userinfo 编码绕过形态：@ 的 percent/unicode 转义拼写。 */
const USERINFO_BYPASS_PATTERN = /@|%(?:25)*40|\\(?:u0040|x40)/i;

/** 已由前置阶段剥除的 userinfo 占位（不再视为绕过证据）。 */
const USERINFO_PLACEHOLDER = "<userinfo>@";

/** 单个 token 内 `://` 出现次数上限：超过视为「稠密 URL 拼接」整体抑制。 */
const DENSE_URL_LIMIT = 32;

export function redactWindowsSids(text: string): string {
  if (!text.includes("-1-")) {
    return text;
  }
  return text.replace(WINDOWS_SID_PATTERN, "<sid>");
}

/**
 * 设备/UNC 前缀归一：`\\?\UNC\server\share` → `\\server\share`；
 * `\\?\C:\x` / `\\.\C:\x` → `C:\x`。归一后由路径占位符阶段接管（<unc>/<drv>:），
 * 防止用设备路径形态绕过 UNC/主机名替换。
 */
export function normalizeDeviceAndUncPaths(text: string): string {
  if (!text.includes("\\\\")) {
    return text;
  }
  return text.replace(/\\\\\?\\UNC\\/gi, "\\\\").replace(/\\\\[?.]\\(?=[A-Za-z]:)/g, "");
}

/**
 * URL userinfo 剥除：`scheme://user:pass@host` → `scheme://<userinfo>@host`。
 * 单 token 内 `://` 超过 32 次视为稠密拼接（正则放大风险），整体替换为
 * `<redacted:dense-urls:Nb>`。
 */
export function redactUserInfoInUrls(text: string): string {
  if (!text.includes("@")) {
    return text;
  }
  return text.replace(/\S+/g, (token) => {
    if (!token.includes("@")) {
      return token;
    }
    let schemeCount = 0;
    for (let index = token.indexOf("://"); index !== -1; index = token.indexOf("://", index + 3)) {
      schemeCount += 1;
      if (schemeCount > DENSE_URL_LIMIT) {
        return `<redacted:dense-urls:${token.length}b>`;
      }
    }
    if (schemeCount === 0) {
      return token;
    }
    // 口令段允许空（redis://:pass@host）；贪婪到最后一个 @，host 段不含 @。
    return token.replace(
      /:\/\/(?!\[)[^\s/:]*(?::[^\s/]{0,8192})?@(?=[^@\s?#]*(?:[/:?#\s]|$))/g,
      `://${USERINFO_PLACEHOLDER}`,
    );
  });
}

function trimUrlTrailingPunctuation(raw: string): { url: string; tail: string } {
  let end = raw.length;
  while (end > 0 && URL_TRAILING_PUNCTUATION.includes(raw.charAt(end - 1))) {
    end -= 1;
  }
  let url = raw.slice(0, end);
  let tail = raw.slice(end);
  // IPv6 字面量方括号平衡：`[::1]:8080/x]` 形态把闭合括号还给 URL。
  if (url.includes("[") && !url.includes("]")) {
    const close = tail.indexOf("]");
    if (close !== -1) {
      url += tail.slice(0, close + 1);
      tail = tail.slice(close + 1);
    }
  }
  return { url, tail };
}

/** 主机名策略：IP 字面量 / 无点主机（localhost 除外）/ 内网域 → true（须整段 <url>）。 */
function isInternalOrRawIpAddress(hostname: string): boolean {
  const host = hostname.replace(/\.$/, "");
  if (host.length === 0) {
    return true;
  }
  if (IP_LITERAL_HOST_PATTERN.test(host)) {
    return true;
  }
  if (!host.includes(".") && host !== "localhost") {
    return true;
  }
  return INTERNAL_DOMAIN_PATTERN.test(host);
}

/** scheme 稳定性门：简单小写连字符拼写（≤20 字符）且无编码绕过形态。 */
function isStableSimpleScheme(scheme: string, urlText: string): boolean {
  return (
    /^[a-z]+(?:-[a-z]+)*$/.test(scheme) &&
    scheme.length <= 20 &&
    !USERINFO_BYPASS_PATTERN.test(urlText) &&
    !urlText.includes("%40") &&
    !WINDOWS_SID_PATTERN.test(urlText)
  );
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * 单个 URL token 的脱敏判决（供文本替换与「值就是 URL」的调用方复用）。
 * matchedScheme 是正则命中的原始 scheme 前缀（可能带编码变形）；
 * raw 是完整命中 token。前置阶段已把真实 userinfo 换成 `<userinfo>@` 占位，
 * 这里若仍见真实 `@`（编码绕过或漏网），整段 <url>——不做部分保留。
 */
export function redactUrlToken(matchedScheme: string, raw: string): string {
  const { url, tail } = trimUrlTrailingPunctuation(raw);
  // 编码冒号结尾（`https%3`/`https:` 半截形态）：无法可靠解析，整段 <url>。
  if (/[:a]$/i.test(matchedScheme)) {
    return `<url>${tail}`;
  }
  let candidate = url;
  if (!/^[a-z]+:\/\//i.test(matchedScheme)) {
    // 变形前缀（`:\/\`、`:%2f%2f`）：还原成标准 `scheme://rest` 再解析。
    const schemeEnd = matchedScheme.search(/:|%3a/i);
    const scheme = matchedScheme.slice(0, schemeEnd === -1 ? undefined : schemeEnd);
    const rest = url.slice(matchedScheme.length);
    const decodedRest = matchedScheme.includes("%") ? safeDecode(rest) : rest;
    if (USERINFO_BYPASS_PATTERN.test(decodedRest) || /^[^/?#\\]*[^\x21-\x7e]/.test(decodedRest)) {
      return `<url>${tail}`;
    }
    candidate = `${scheme}://${decodedRest}`;
  }
  if (!/^(?:https?|wss?):\/\//i.test(candidate)) {
    // 自定义 scheme：仅「简单小写且脱敏后不变形」保留 `scheme:`，其余 <url>。
    const schemeMatch = /^([a-z][a-z0-9+.-]*):\/\//i.exec(candidate);
    if (!schemeMatch) {
      return `<url>${tail}`;
    }
    const scheme = schemeMatch[1]!.toLowerCase();
    return isStableSimpleScheme(scheme, url) ? `${scheme}:${tail}` : `<url>${tail}`;
  }
  // authority 段仍含真实 @（非 <userinfo>@ 占位）→ 凭据在 URL 里，整段抑制。
  // 注意 authority 起点必须跳过 scheme 的 `://`，否则斜杠会把 authority 切成空串。
  const schemeSeparatorEnd = candidate.indexOf("://") + 3;
  const restAfterAuthority = candidate.slice(schemeSeparatorEnd);
  const authorityEndOffset = restAfterAuthority.search(/[/?#]/);
  const authority =
    authorityEndOffset === -1
      ? restAfterAuthority
      : restAfterAuthority.slice(0, authorityEndOffset);
  if (authority.includes("@") && !authority.includes(USERINFO_PLACEHOLDER)) {
    return `<url>${tail}`;
  }
  // <userinfo>@ 占位剥除后再解析：origin 收敛不因占位失败。
  const parseTarget = candidate.replaceAll(USERINFO_PLACEHOLDER, "");
  try {
    const parsed = new URL(parseTarget);
    if (!parsed.hostname || isInternalOrRawIpAddress(parsed.hostname)) {
      return `<url>${tail}`;
    }
    const port = parsed.port ? `:${parsed.port}` : "";
    // origin-only：路径/query/fragment 一律收敛为 <path> 占位。
    return `${parsed.protocol}//${parsed.hostname}${port}/<path>${tail}`;
  } catch {
    return `<url>${tail}`;
  }
}

/**
 * 文本级 URL 脱敏：http(s)/ws(s)（含编码变形）→ origin-only 或 <url>；
 * 其余 `scheme://` → 简单小写稳定 scheme 保留 `scheme:`，否则 <url>。
 */
export function redactUrlsInText(text: string): string {
  let result = text.replace(TEXT_URL_PATTERN, (match, schemePrefix: string) =>
    redactUrlToken(schemePrefix, match),
  );
  // 任意 scheme 兜底：字面 `scheme://` 若未被上一轮命中（自定义协议或行首粘连），
  // 仍走同一判决（http 族 origin 收敛 / 自定义 scheme 稳定性门）。
  result = result.replace(GENERIC_SCHEME_URL_PATTERN, (match, scheme: string) =>
    redactUrlToken(`${scheme}://`, match),
  );
  return result;
}
