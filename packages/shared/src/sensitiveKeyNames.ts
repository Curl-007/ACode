/**
 * 敏感键名词表的单一事实源（specs/log-privacy-redaction.md R1）。
 *
 * 背景：仓库里此前存在多套「哪些键名属于机密」的词表——feedbackPrivacy.ts 的
 * sensitiveKey、desktop exportLogs.ts 的 SENSITIVE_KEY_SUBSTRING_PATTERN、
 * CLI DefaultLogRedactor、acodeAgentProcessManager 的 stderr 正则。词表分叉的
 * 结果是同一份日志在不同出口脱敏强度不一致。本模块把词表收敛为单一导出：
 * 反馈面（feedbackPrivacy）、日志脱敏管线（logRedactionPipeline）、
 * 日志导出（exportLogs）必须同源消费，禁止再新增第二套。
 *
 * 词表构成：
 * - 族子串（SENSITIVE_KEY_NAME_PATTERN）：归一化键名包含即视为敏感。
 *   合并原 feedbackPrivacy 族与 exportLogs 族，并补充组合词干
 *   （signingkey/licensekey/sessionkey/masterkey/encryptionkey/clientsecret/
 *   secretkey/subscriptionkey/signature 等 header 与云厂商长尾拼写）。
 * - 精确键 + 版本号（SENSITIVE_KEY_EXACT_NAME_PATTERN）：authorization/cookie/
 *   token/x-api-key/x-amz-security-token 等 header 拼写，允许 `-v2`/`_v10`
 *   版本号后缀（归一化后形态 `v?\d+`）。
 * - 组合后缀 + 版本号（SENSITIVE_KEY_SUFFIX_PATTERN）：以 `-keys/-secrets/-tokens`
 *   等结尾的复合键（api/secret/access/private/signing/auth/license/master/
 *   encryption/session/client 前缀组合），同样允许版本号。
 * - 白名单（NON_SENSITIVE_LOG_KEY_ALLOWLIST_PATTERN）：命中敏感子串但实际
 *   并非机密的键——LLM token 计数/预算（max_tokens/input_tokens 等，排障需要
 *   保留以判断 provider 限流）、author/authority、public_key、keywords、
 *   tokenizer。白名单优先于族/精确/后缀判定。
 *
 * 纯函数与常量，无任何 import：可被 node --test 直接加载，浏览器/渲染进程可安全引用。
 */

/** 键名归一化：剥掉所有非字母数字字符并小写（`X-Api-Key-v2` → `xapikeyv2`）。 */
export function normalizeLogKeyName(key: string): string {
  return key.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

/**
 * 族子串词表（作用于归一化键名，包含即命中）。
 * 宽松子串 + 下方白名单排除误伤项，覆盖自定义命名（db_password、my_secret 等）。
 */
export const SENSITIVE_KEY_NAME_PATTERN = new RegExp(
  [
    "password",
    "passwd",
    "passphrase",
    "pwd",
    "secret",
    "token",
    "credential",
    "authorization",
    "auth",
    "cookie",
    "apikey",
    "accesskey",
    "privatekey",
    "secretkey",
    "signingkey",
    "licensekey",
    "sessionkey",
    "masterkey",
    "encryptionkey",
    "clientsecret",
    "subscriptionkey",
    "signature",
    "dsn",
    // conn_str / connection-string 等连接串拼写（归一化后两种词干都要列）。
    "connstr",
    "connectionstr",
    "databaseurl",
    "dburl",
  ].join("|"),
  "i",
);

/**
 * 精确 header 键（作用于归一化键名，整键锚定），允许版本号后缀。
 * 覆盖族子串表达不了的厂商专有 header（如 ocp-apim-subscription-key、
 * x-honeycomb-team），与 SENSITIVE_KEY_SUFFIX_PATTERN 一起构成
 * 「精确 + 组合后缀 + 版本号」的收敛形态。
 */
export const SENSITIVE_KEY_EXACT_NAME_PATTERN =
  /^(?:authorization|proxyauthorization|cookie|setcookie|token|secret|password|passwd|apikey|xapikey|xauthtoken|xamzsecuritytoken|xgoogapikey|ocpapimsubscriptionkey|xsubscriptiontoken|privatetoken|xfunctionskey|xhoneycombteam)(?:v?\d+)?$/i;

/**
 * 组合后缀（作用于归一化键名，尾部锚定），允许版本号后缀：
 * `*-keys` / `*-secrets` / `*-tokens` 以及 signature/credentials/authorization
 * 结尾的复合键（如 client-signing-keys-v2 → clientsigningkeysv2）。
 */
export const SENSITIVE_KEY_SUFFIX_PATTERN = new RegExp(
  "(?:tokens?|secrets?|password|passwd|signature|credentials?|authorization|" +
    "(?:api|secret|access|private|signing|auth|license|master|encryption|session|client)" +
    "(?:keys?|secrets?))(?:v?\\d+)?$",
  "i",
);

/**
 * 白名单（作用于归一化键名，整键锚定）：命中敏感子串但并非机密的常见键。
 * 不能把任意 `*tokens` 都白名单化——access_tokens/session_tokens 必须继续脱敏；
 * 这里只放行明确的 LLM token 计数/预算字段与 author/public_key 类普通词。
 */
export const NON_SENSITIVE_LOG_KEY_ALLOWLIST_PATTERN =
  /^(?:publickey|keywords?|tokenizer|tokencount|(?:prompt|completion|total|input|output|cached|reasoning|max|budget|acceptedprediction|rejectedprediction|tooluseprompt)tokens|authors?|authority|authed)$/i;

/**
 * 键名是否属于敏感凭据（大小写与分隔符不敏感）。
 * 判定顺序：白名单 → 族子串 → 精确键 → 组合后缀；白名单优先，
 * 防止 max_tokens 这类排障上下文字段被过度抑制。
 */
export function isSensitiveLogKeyName(key: string): boolean {
  const normalized = normalizeLogKeyName(key);
  if (normalized.length === 0) {
    return false;
  }
  if (NON_SENSITIVE_LOG_KEY_ALLOWLIST_PATTERN.test(normalized)) {
    return false;
  }
  return (
    SENSITIVE_KEY_NAME_PATTERN.test(normalized) ||
    SENSITIVE_KEY_EXACT_NAME_PATTERN.test(normalized) ||
    SENSITIVE_KEY_SUFFIX_PATTERN.test(normalized)
  );
}
