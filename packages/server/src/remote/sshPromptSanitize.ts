// SSH 提示文本消毒（展示/日志/错误文案前的强制净化）。
// 规格见 packages/server/specs/ssh-prompt-mediation.md R1。
//
// 单源义务：不可见字符族与 apps/acode-cli/packages/core/src/permission/
// bash-confirm-reflex-gate.ts 的 INVISIBLE_CHARACTERS_PATTERN（\p{Cf} +
// \u2028\u2029\u2800\u3164\uFFA0 七族）同源；CLI 包不可被 server import，
// 故在此提炼等价纯函数。任何一侧调整不可见字符策略必须同步另一侧。

const MAX_SANITIZED_PROMPT_CHARS = 4096;
const SANITIZED_HEAD_CHARS = 1024;
const SANITIZED_TAIL_CHARS = 3069;
const SANITIZE_TRUNCATION_SEPARATOR = "\n…\n";

// 孤立代理对 → \0：防止下游 UTF-8 编码歧义与「截断切半代理对」的显示攻击。
const LONE_SURROGATE_PATTERN = /\p{Cs}/gu;
// CRLF/CR/U+2028/U+2029 → \n：行语义归一，行/段分隔符不能伪造提示边界。
const LINE_SEPARATOR_PATTERN = /\r\n?|[\u2028\u2029]/gu;
// 七族不可见字符：格式字符（含全部零宽/双向控制/BOM/变体选择符）、默认不可见
// 码点（含 tag 字符 U+E0000 段）、盲文空白、谚文填充符。
const INVISIBLE_CHARACTERS_PATTERN =
  /[\p{Cf}\p{Default_Ignorable_Code_Point}\u2800\u3164\uFFA0]/gu;
// 其余控制字符（保留 \n \t）→ 空格。
const CONTROL_CHARACTERS_PATTERN = /(?:(?![\n\t])\p{Cc})+/gu;
const EXCESSIVE_NEWLINES_PATTERN = /\n{3,}/gu;

/**
 * 消毒对端提示文本。步骤固定：代理对→\0、行分隔归一、剥不可见字符族、
 * 控制符→空格、逐行去尾随空白、折叠 3+ 连续换行、trim、4096 字符截断
 * （保头部 1024 + 分隔符 + 尾部 3069，避免长提示把关键尾部信息挤掉）。
 */
export function sanitizeSSHPromptText(raw: string): string {
  const normalized = raw
    .replace(LONE_SURROGATE_PATTERN, "\0")
    .replace(LINE_SEPARATOR_PATTERN, "\n")
    .replace(INVISIBLE_CHARACTERS_PATTERN, "")
    .replace(CONTROL_CHARACTERS_PATTERN, " ")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(EXCESSIVE_NEWLINES_PATTERN, "\n\n")
    .trim();

  const chars = Array.from(normalized);
  if (chars.length <= MAX_SANITIZED_PROMPT_CHARS) {
    return normalized;
  }
  return (
    chars.slice(0, SANITIZED_HEAD_CHARS).join("").trimEnd() +
    SANITIZE_TRUNCATION_SEPARATOR +
    chars.slice(-SANITIZED_TAIL_CHARS).join("").trimStart()
  );
}

/** 把已消毒文本再压缩成适合并入单行错误文案的摘要（换行折成空格 + 截断）。 */
export function summarizeSanitizedPromptText(
  sanitized: string,
  maxChars = 120,
): string {
  const flattened = sanitized.replace(/\s*\n\s*/gu, " ").trim();
  const chars = Array.from(flattened);
  if (chars.length <= maxChars) {
    return flattened;
  }
  return `${chars.slice(0, maxChars).join("").trimEnd()}…`;
}
