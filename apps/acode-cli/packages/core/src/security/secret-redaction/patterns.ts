/**
 * 内置凭据正则族（WI-17 转录密钥混淆·收集面）。
 *
 * 语义移植自 oh-my-pi（MIT License, Copyright (c) oh-my-pi contributors）
 * `packages/coding-agent/src/secrets/patterns.ts` 与 `packages/ai/src/providers/
 * transform-messages.ts` 的 SENSITIVE_TOKEN_RE；本文件按 ACode 落点裁剪：
 *   - 不依赖 pi-ai（SENSITIVE_TOKEN_RE 的 source 直接内联，署名保留）；
 *   - 不含 omp 的流式 CREDENTIAL_PREFIX_RULES（ACode 无流式增量脱敏面，
 *     出站投影是整消息级的，见 specs/transcript-secret-obfuscation.md R2）。
 *
 * 纪律（照 omp 注释）：只收**锚定厂商前缀**的凭据形态，不做通用关键词/熵规则——
 * 编码代理必须还能读 `token_expiry_seconds` 这类普通标识符。假阳性只会过度混淆，
 * 而混淆可逆（还原面在执行前查表还原），代价透明。
 */

interface CredentialPattern {
  /** 模型可见的占位符友好标签（净化为大写字母数字前缀）。 */
  name: string;
  source: string;
  flags?: string;
  /**
   * 该正则任何匹配都必然包含的字面子串（至少其一）。混淆器对不含任何字面量的
   * 文本直接跳过该正则（includes 比 lookbehind 正则快一个量级，而出站投影每个
   * 请求都要扫整个 provider 上下文——omp patterns.ts 同款性能纪律）。
   * 必须对正则的全部 alternative 穷尽；缺省该字段的 pattern 总是被扫描。
   * 大小写不敏感的 pattern 用小写形态做门。
   */
  literalPrefixes?: readonly string[];
}

const B = "(?<![A-Za-z0-9_-])"; // 左边界：前面不能是 token 字符
const E = "(?![A-Za-z0-9_-])"; // 右边界：后面不能是 token 字符

// 标准 PEM 私钥块：五连杠 BEGIN、可选算法标签、PRIVATE KEY、五连杠，惰性体，配对 END。
const PEM_PRIVATE_KEY_SOURCE =
  "-----BEGIN [A-Z ]*PRIVATE KEY-----[\\s\\S]*?-----END [A-Z ]*PRIVATE KEY-----";

// omp pi-ai SENSITIVE_TOKEN_RE 的内联（MIT，见文件头）：GitHub/GitLab/OpenAI 系
// 厂商 token 的最小可辨形态，带 token 字符边界防粘连。
const VENDOR_TOKEN_SOURCE =
  "(?<![a-zA-Z0-9_*-])(?:gh[opusr]_[a-zA-Z0-9_*]{36,}|github_pat_[a-zA-Z0-9_*]{36,}|glpat-[a-zA-Z0-9_*-]{20,}|sk-proj-[a-zA-Z0-9_*-]{36,}|sk-ant-[a-zA-Z0-9_*-]{36,}|sk-[a-zA-Z0-9_*-]{48,})(?![a-zA-Z0-9_*-])";

export const CREDENTIAL_PATTERNS: readonly CredentialPattern[] = [
  {
    name: "Credential",
    source: VENDOR_TOKEN_SOURCE,
    flags: "i",
    literalPrefixes: ["gho_", "ghp_", "ghu_", "ghs_", "ghr_", "github_pat_", "glpat-", "sk-"],
  },
  {
    name: "AWSAccessKey",
    source: `${B}(?:AKIA|ASIA)[A-Z0-9]{16}${E}`,
    literalPrefixes: ["AKIA", "ASIA"],
  },
  { name: "GoogleAPIKey", source: `${B}AIza[A-Za-z0-9_-]{30,}${E}`, literalPrefixes: ["AIza"] },
  {
    name: "SlackToken",
    source: `${B}xox[abprs]-[A-Za-z0-9-]{10,}${E}`,
    literalPrefixes: ["xoxa-", "xoxb-", "xoxp-", "xoxr-", "xoxs-"],
  },
  { name: "NpmToken", source: `${B}npm_[A-Za-z0-9]{30,}${E}`, literalPrefixes: ["npm_"] },
  {
    name: "StripeKey",
    source: `${B}(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}${E}`,
    literalPrefixes: ["sk_live_", "sk_test_", "rk_live_", "rk_test_"],
  },
  {
    name: "StripeWebhookSecret",
    source: `${B}whsec_[A-Za-z0-9]{20,}${E}`,
    literalPrefixes: ["whsec_"],
  },
  { name: "HuggingFaceToken", source: `${B}hf_[A-Za-z0-9]{30,}${E}`, literalPrefixes: ["hf_"] },
  {
    name: "SendGridKey",
    source: `${B}SG\\.[A-Za-z0-9_-]{22}\\.[A-Za-z0-9_-]{43}${E}`,
    literalPrefixes: ["SG."],
  },
  {
    name: "JWT",
    source: `${B}eyJ[A-Za-z0-9_-]{10,}\\.eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}${E}`,
    literalPrefixes: ["eyJ"],
  },
  {
    name: "BearerToken",
    source: `(?<=\\bBearer )[A-Za-z0-9._~+/=-]{20,}${E}`,
    flags: "i",
    literalPrefixes: ["Bearer "],
  },
  { name: "PrivateKey", source: PEM_PRIVATE_KEY_SOURCE, literalPrefixes: ["-----BEGIN "] },
];
