// ============================================================
// Provider Doctor 脱敏（J3-1 / spec R5）
// 机制参照 jcode (MIT, github.com/1jehuang/jcode) crates/jcode-provider-doctor，自撰实现。
// ============================================================
//
// 诊断要输出失败原因才有用，但失败原因来自 provider 报文与本地异常文本——两者都可能
// 回显请求头或 Key。这里的策略是「白名单字段 + 双层剔除」：
//   1) 本次运行内存里出现过的凭据真值逐字剔除（最强证据，因为我们确切知道它长什么样）；
//   2) 常见密钥字面量形态按模式剔除（覆盖我们从没见过的凭据，例如 provider 回显的用户输入）。
// 账本与 stdout 走同一个 redactor；账本额外只保留非通过项的 detail 且截断更短。

const DETAIL_MAX_LENGTH = 200;
const LEDGER_DETAIL_MAX_LENGTH = 160;
const REDACTED = "[redacted]";
/** 短于该长度的真值不参与逐字剔除：短串（如 "zai"）会把正常文案打成筛子。 */
const MIN_SECRET_LENGTH_FOR_SCRUB = 6;

// 对抗复核 F2：本清单与 core 反射门审计脱敏（packages/core/src/permission/
// bash-confirm-reflex-gate.ts 的 AUDIT_REDACTION_PATTERNS）是同一份形态清单的两处
// 落地（core 不能 import adapters），任一侧新增/修正形态必须同步另一侧（两处注释
// 互相指向，specs/provider-doctor.md R5 / specs/bash-confirm-reflexive-gate.md R6）。
// 对抗复核 F3：三处漂移已对齐（2026-09-30）——JSON 引号键补 x-api-key /
// anthropic-auth-token、JWT 第三段改 optional（两三段皆认）、auth-scheme 值类改
// core 同款 `[^\s"\[]+`（doctor 保留 `\[redacted\]` 分支：本模块先做已知真值逐字
// 替换，替换后的「Bearer [redacted]」残片仍需吃掉，core 无这层预处理故无此分支）。
// 剩余有意差异（非漂移）：替换标记本模块为 `[redacted]`、core 为
// `[REDACTED:<类别>]`——账本/detail 不引入类别枚举，保持输出最小化。
const SECRET_PATTERNS: readonly RegExp[] = Object.freeze([
  // OpenAI / Anthropic 风格的 Key 字面量。对抗复核 F2：大小写不敏感 + [_-] 两种分隔
  // （sk_UNDERSCOREKEY123456 / SK-UPPERCASE12345678 变体同族）。
  /\b(?:sk|pk|rk)[_-][A-Za-z0-9_-]{8,}\b/gi,
  // JWT（账号 access token / id token 常见形态）。对抗复核 F3：第三段 optional——
  // header.payload 两段式（未签名的 access token、部分 provider 的回显形态）同样要灭。
  /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}(?:\.[A-Za-z0-9_-]{6,})?\b/g,
  // GitHub PAT（classic ghp_/gho_/ghs_/ghr_ 与细粒度 github_pat_）。对抗复核 F2。
  /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  // AWS Access Key。对抗复核 F2。
  /\bAKIA[0-9A-Z]{16}\b/g,
  // PEM 私钥块整块（含 base64 体）；无 END 时吃到文本结尾。对抗复核 F2。
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/gi,
  // Authorization / Bearer 头整体。`[redacted]` 形态也要吃掉：真值先被已知真值替换后，
  // 只剩「Bearer [redacted]」的残片同样是噪声，留着会让人以为账本里有头信息。
  // 对抗复核 F2/F3：值取「整段引号字符串（多词值不留残段）| 上述裸值 | 裸 token」，
  // 裸值类与 core 反射门同款 `[^\s"[]+`（同义异写：core 侧写作 `[^\s"\[]`，字符类内
  // 无需转义）：<8 字符、含 `!@#` 等特殊字符的 token 不再放行；`[` 不入类，保证已被
  // 替换的 `[redacted]` 只走上面专属分支、不被二次吞。
  /\b(?:Bearer|Basic)\s+(?:"[^"]*"|\[redacted\]|[^\s"[]+)/gi,
  // key=value / key: value 形式的凭据字段（含 JSON 片段）。对抗复核 F2：JSON 引号键
  // 补 token（与裸键列表对齐）；对抗复核 F3：补 x-api-key / anthropic-auth-token
  // （x-api-key 恰是 doctor 自己为 anthropic-messages 构造的头，报文回显必须灭）。
  /("(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|authorization|x-api-key|anthropic-auth-token|secret|password|credential)"\s*:\s*)"[^"]*"/gi,
  /\b(?:api[_-]?key|apiKey|access[_-]?token|refresh[_-]?token|secret|password|token|authorization)\s*[:=]\s*(?:"[^"]*"|[^\s,;}"']+)/gi,
  // x-api-key / anthropic 头形态。
  /\b(?:x-api-key|anthropic-auth-token)\s*[:=]\s*[^\s,;}"']+/gi,
]);

export interface ProviderDoctorRedactor {
  /** 输出/stdout 用：剔除凭据后截断到 200 字符。 */
  redact(text: string): string;
  /** 账本用：更短上限，且强制单行（JSONL 友好）。 */
  redactForLedger(text: string): string;
}

export function createProviderDoctorRedactor(
  secretValues: readonly string[] = [],
): ProviderDoctorRedactor {
  // 传入的数组可以是**运行期继续追加**的（例如 catalog 档才解析出的账号凭据）：
  // 因此每次调用都重新收敛一次真值集合，而不是在构造期冻结。
  return {
    redact: (text) => truncate(scrub(text, dedupeSecrets(secretValues)), DETAIL_MAX_LENGTH),
    redactForLedger: (text) =>
      truncate(toSingleLine(scrub(text, dedupeSecrets(secretValues))), LEDGER_DETAIL_MAX_LENGTH),
  };
}

/** 只保留有辨识度的真值；空串/短串剔除会误伤正常文案。 */
function dedupeSecrets(secretValues: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  for (const value of secretValues) {
    const trimmed = typeof value === "string" ? value.trim() : "";
    if (trimmed.length < MIN_SECRET_LENGTH_FOR_SCRUB) continue;
    seen.add(trimmed);
  }
  // 长值优先：短值可能是长值的子串，先替换短值会把长值切碎留下残片。
  return [...seen].sort((a, b) => b.length - a.length);
}

function scrub(text: string, knownSecrets: readonly string[]): string {
  let result = text;
  for (const secret of knownSecrets) {
    if (!result.includes(secret)) continue;
    result = result.split(secret).join(REDACTED);
  }
  for (const pattern of SECRET_PATTERNS) {
    // 全局正则有 lastIndex 状态：每次替换前复位，避免跨调用漏匹配。
    pattern.lastIndex = 0;
    result = result.replace(pattern, (match, prefix: unknown) =>
      // JSON 片段形态要把值的双引号补回来，否则会留下 `{"api_key": [redacted]"}` 这种破括号。
      typeof prefix === "string" && prefix.length > 0 ? `${prefix}"${REDACTED}"` : REDACTED,
    );
  }
  return result;
}

function toSingleLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncate(text: string, maxLength: number): string {
  const single = toSingleLine(text);
  if (single.length <= maxLength) return single;
  return `${single.slice(0, maxLength - 1)}…`;
}

/**
 * 报告/账本的最终自检：任何白名单之外的字段都可能夹带凭据，这里做一次结构性断言。
 * 返回命中的字段名，供测试与 warn 日志使用（不抛错——诊断本身不能因为自检失败而丢失结果，
 * 但必须可观察）。
 *
 * 只对**字符串值**的字段报警：`spend.promptTokens` 这类计数字段名字里带 token，
 * 但它是数字，不是凭据；按名字一刀切会让账本永远写不进去（假阳性掩盖真阳性）。
 */
export function findCredentialLikeKeys(value: unknown, path = ""): readonly string[] {
  const hits: string[] = [];
  const walk = (node: unknown, currentPath: string): void => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${currentPath}[${index}]`));
      return;
    }
    if (typeof node !== "object" || node === null) return;
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      const keyPath = currentPath ? `${currentPath}.${key}` : key;
      if (
        typeof child === "string" &&
        /api[_-]?key|token|secret|password|credential|authorization/i.test(key)
      ) {
        hits.push(keyPath);
      }
      walk(child, keyPath);
    }
  };
  walk(value, path);
  return hits;
}
