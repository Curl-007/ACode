/**
 * 占位符格式与铸造原语（WI-17 转录密钥混淆·混淆面基础件）。
 *
 * 语义移植自 oh-my-pi（MIT License, Copyright (c) oh-my-pi contributors）
 * `packages/coding-agent/src/secrets/placeholder.ts`；Bun API 降解：
 * `Bun.CryptoHasher("sha256", key)` → `node:crypto` 的 `createHmac`。
 * omp 的 replace 模式（不可逆替换）、SecretValueSet 碰撞索引、流式 pending 后缀
 * 缓冲不在 ACode 落点内（ACode 只做可逆混淆 + 整消息出站投影，见 spec R2/R4），
 * 相应原语不移植。
 */
import { createHmac } from "node:crypto";

const HASH_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
// 基长度取 ~62 bit 熵（keyed digest 的 64 bit 渲染成 12 位 base36），保证不相关
// 秘密不会碰撞到同一个基——碰撞会让持久化占位符在秘密集合变化后还原到错误秘密。
const HASH_LEN = 12;
const MAX_FRIENDLY_NAME_LEN = 32;

/**
 * 可逆混淆的最短匹配长度：plain 值与正则匹配短于 8 字符时忽略（不放占位符），
 * 避免把普通短词/片段吞进脱敏面（omp MIN_OBFUSCATE_SECRET_LEN 同款）。
 */
export const MIN_OBFUSCATE_SECRET_LEN = 8;

type PlaceholderCaseHint = "U" | "L" | "C" | "M";

/**
 * 从秘密原文的 KEYED 摘要派生模型可见基。omp 注释的选型依据照搬：无密钥的内容哈希
 * 对低熵秘密可被转录读取者字典还原；per-install 私钥下的 HMAC-SHA256 不可（攻击者
 * 没有密钥）。仅大小写不同的秘密获得独立基，provider 无法靠改 hint 合成别的占位符。
 */
export function buildHashBase(key: string, value: string): string {
  const digest = createHmac("sha256", key).update(value).digest();
  let v = 0n;
  for (let i = 0; i < 8; i++) v = (v << 8n) | BigInt(digest[i]);
  const radix = BigInt(HASH_CHARS.length);
  let tag = "";
  for (let i = 0; i < HASH_LEN; i++) {
    tag += HASH_CHARS[Number(v % radix)];
    v /= radix;
  }
  return tag;
}

/** 推断大小写提示位（omp inferCaseHint 逐字符语义原样移植）。 */
export function inferCaseHint(secret: string): PlaceholderCaseHint | undefined {
  let hasCased = false;
  let hasUpper = false;
  let hasLower = false;
  let capitalized = true;
  let seenFirstCased = false;

  for (let i = 0; i < secret.length; i++) {
    const code = secret.charCodeAt(i);
    const isUpper = code >= 65 && code <= 90;
    const isLower = code >= 97 && code <= 122;
    if (!isUpper && !isLower) continue;

    hasCased = true;
    if (isUpper) {
      hasUpper = true;
      if (seenFirstCased) capitalized = false;
    } else {
      hasLower = true;
      if (!seenFirstCased) capitalized = false;
    }
    seenFirstCased = true;
  }

  if (!hasCased) return undefined;
  if (hasUpper && !hasLower) return "U";
  if (hasLower && !hasUpper) return "L";
  if (capitalized) return "C";
  return "M";
}

/** 友好名净化为占位符前缀：只留字母数字、大写、截 32；净化后为空则无标签。 */
export function sanitizeSecretFriendlyName(name: string): string | undefined {
  const sanitized = name
    .replace(/[^A-Za-z0-9]/g, "")
    .toUpperCase()
    .slice(0, MAX_FRIENDLY_NAME_LEN);
  return sanitized.length > 0 ? sanitized : undefined;
}

export function buildPlaceholder(
  hint: PlaceholderCaseHint | undefined,
  base: string,
  friendlyName?: string,
): string {
  const prefix = friendlyName ? `${friendlyName}_` : "";
  return hint ? `$$${prefix}${base}:${hint}$$` : `$$${prefix}${base}$$`;
}

/**
 * 匹配 `$$HASH$$`、`$$HASH:U$$`、`$$FRIENDLY_HASH(:hint)$$` 的正则（omp 同款）。
 * 还原面对命中项查表：在表内→还原；不在表内→原样放行（spec R3）。
 * 每次使用新建实例或复位 lastIndex，避免模块级共享正则的 lastIndex 串扰。
 */
const PLACEHOLDER_SOURCE = "\\$\\$(?:[A-Z0-9]+_)?[A-Z0-9]{4,}(?::[ULCM])?\\$\\$";

export function createPlaceholderRegex(): RegExp {
  return new RegExp(PLACEHOLDER_SOURCE, "g");
}

/**
 * 严格铸造形态：基恰为 12 位 base36、可选友好前缀（≤32）与 hint。只有严格形态的
 * 未解析候选计入 unresolvedPlaceholders（fail-loud 提示的触发面）——宽松的
 * PLACEHOLDER_SOURCE 会命中用户文本里恰好像占位符的字面量（`$$FOO$$`、Makefile 的
 * `$$` 转义等），把它们计入会造成误报（spec R3/R8 的误杀边界）。
 */
const STRICT_MINTED_RE = /^\$\$(?:[A-Z0-9]{1,32}_)?[A-Z0-9]{12}(?::[ULCM])?\$\$$/;

export function isStrictMintedPlaceholderShape(candidate: string): boolean {
  return STRICT_MINTED_RE.test(candidate);
}

/** 去掉友好名前缀的别名形态（`$$FRIENDLY_BASE$$` → `$$BASE$$`），还原查表回退用。 */
export function placeholderWithoutFriendlyName(placeholder: string): string | undefined {
  const match = /^\$\$[A-Z0-9]+_([A-Z0-9]{4,}(?::[ULCM])?)\$\$$/.exec(placeholder);
  return match ? `$$${match[1]}$$` : undefined;
}
