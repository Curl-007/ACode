/**
 * 机密值形态脱敏（specs/log-privacy-redaction.md R11）。
 *
 * 与键名词表（sensitiveKeyNames.ts）互补：词表判「键名是否敏感」，
 * 本模块按「值形态」直接识别凭据——Bearer/Basic 头、私钥块、常见厂商
 * key 拼写、JWT 三段式、长 base64 blob、email、IP 字面量。
 * 值形态脱敏不依赖日志格式，对自由文本同样生效。
 *
 * 纯函数，无 IO、无 node 依赖。
 */

import { ACODE_ID_TOKEN_PREFIX_SOURCE } from "./sessionEgressGate.js";
import { isSensitiveLogKeyName } from "./sensitiveKeyNames.js";

const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const IPV4_PATTERN = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const IPV6_PATTERN = /\b(?:[A-Fa-f0-9]{1,4}:){2,7}(?::?[A-Fa-f0-9]{1,4}){1,7}\b/g;
/** `HH:MM:SS` 时间形态会被 IPv6 正则误命中，先豁免。 */
const TIME_PATTERN = /^\d{1,2}:\d{2}:\d{2}$/;

/** 通用 kv 形态：`key: value` / `key=value`（引号可选，值到分隔符为止）。 */
const KEY_VALUE_PATTERN =
  /(["']?)([\w.@$/-]{1,64})\1(\s*[:=]\s*)("(?:[^"\\]|\\.)*"|'[^']*'|[^\s,;|)"'`]*)/g;

/**
 * 值形态脱敏规则表（顺序即应用顺序）：
 * 私钥块 → Bearer/Basic → 厂商 key 拼写 → JWT → 敏感 kv → 长 blob。
 */
const SECRET_SHAPE_RULES: ReadonlyArray<
  readonly [RegExp, string | ((...args: string[]) => string)]
> = [
  // 私钥块（含未闭合形态：日志截断时 END 行可能缺失）。
  [
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
    "<redacted>",
  ],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer <token>"],
  [/(:\s*)Basic\s+[A-Za-z0-9+/=]{8,}/gi, "$1Basic <token>"],
  // 厂商 key 拼写：长 token 形态，命中即整值替换。
  [/\bsk-[A-Za-z0-9_-]{20,}/g, "<token>"],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "<token>"],
  [/\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g, "<token>"],
  [/\bgh[opusr]_[A-Za-z0-9]{36,}/g, "<token>"],
  [/\bgithub_pat_[A-Za-z0-9_]{22,}/g, "<token>"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, "<token>"],
  [/\bglpat-[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/g, "<token>"],
  // JWT 三段式（eyJ 头段 base64）。
  [/\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "<jwt>"],
  // 长 base64/base64url blob（≥40 字符）：高熵串按凭据处理。
  // ACode 自己的 id token（sess_<uuid> 等 ≥40 字符形态）不是秘密，
  // 本地日志需要保留做排障关联——用 id 前缀负向前瞻豁免；
  // 不合格式的伪 id token 由管线的会话泄漏门先行整行抑制。
  [
    new RegExp(
      String.raw`(?<![A-Za-z0-9+/_-])(?!${ACODE_ID_TOKEN_PREFIX_SOURCE})[A-Za-z0-9+/]{40,}={0,2}(?![A-Za-z0-9+/_-])`,
      "g",
    ),
    "<blob>",
  ],
  [
    new RegExp(
      String.raw`(?<![A-Za-z0-9+_-])(?!${ACODE_ID_TOKEN_PREFIX_SOURCE})[A-Za-z0-9+_-]{40,}={0,2}(?![A-Za-z0-9+_-])`,
      "g",
    ),
    "<blob>",
  ],
];

/**
 * 敏感键 kv 脱敏：键名判定走 sensitiveKeyNames 单源（R1），
 * 命中即值替换 `<redacted>`，保留键名与分隔符便于排障。
 */
export function redactSensitiveKeyValuePairs(text: string): string {
  return text.replace(
    KEY_VALUE_PATTERN,
    (match, quote: string, key: string, separator: string, value: string) => {
      if (!isSensitiveLogKeyName(key)) {
        return match;
      }
      // 已脱敏的占位值不再重复处理（幂等不变量）。
      if (/^(?:<(?:token|redacted|jwt|blob)>|\[REDACTED\]|\*{3}REDACTED\*{3})$/.test(value)) {
        return match;
      }
      return `${quote}${key}${quote}${separator}${quote}<redacted>${quote}`;
    },
  );
}

/** email → <email>；IPv4/IPv6 字面量 → <ip>（HH:MM:SS 时间豁免）。 */
export function redactEmailsAndIps(text: string): string {
  return text
    .replace(EMAIL_PATTERN, "<email>")
    .replace(IPV4_PATTERN, "<ip>")
    .replace(IPV6_PATTERN, (match) => (TIME_PATTERN.test(match) ? match : "<ip>"));
}

/** 机密值形态脱敏总入口：规则表顺序应用 + 敏感 kv。 */
export function redactSecretValueShapes(text: string): string {
  let result = text;
  for (const [pattern, replacement] of SECRET_SHAPE_RULES) {
    result = result.replace(pattern, replacement as string);
  }
  return redactSensitiveKeyValuePairs(result);
}
