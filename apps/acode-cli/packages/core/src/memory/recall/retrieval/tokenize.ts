// 机制参照 jcode (MIT) 的英文 tokenizer 思路，为 ACode 自撰中文一等公民分词器：
// jcode 只需处理拉丁词；ACode 用户记忆中文占比高，必须自做 CJK bigram。
// 产品规则见 apps/acode-cli/specs/memory-semantic-recall.md R2。

/**
 * 检索分词器（R2，零依赖）。BM25 与 query 解析共用同一个：
 *
 * - 拉丁词：连续 `[A-Za-z0-9_'-]` 切词，小写归一；
 * - CJK：相邻 CJK 码位切 bigram（「凭据主密钥」→ 凭据/据主/主密/密钥——
 *   单字信噪比低，jcode 英文 tokenizer 无此问题，ACode 必须自做）；
 * - 过滤：长度 1 的非 CJK 单字符 token 丢弃；数字 token 保留
 *   （版本号/错误码如 `401` 是记忆里的强信号）。
 */
export function tokenizeForRetrieval(text: string): string[] {
  const tokens: string[] = [];
  let cjkRun: number[] = [];

  const flushCjkRun = (): void => {
    // 段内相邻码位两两组合；孤立单字（段长 1）不产出 token——单字信噪比低。
    for (let index = 0; index + 1 < cjkRun.length; index++) {
      tokens.push(String.fromCodePoint(cjkRun[index]!, cjkRun[index + 1]!));
    }
    cjkRun = [];
  };

  for (const character of text) {
    const codePoint = character.codePointAt(0)!;
    if (isCjkCodePoint(codePoint)) {
      cjkRun.push(codePoint);
      continue;
    }
    flushCjkRun();
  }
  flushCjkRun();

  for (const match of text.matchAll(LATIN_WORD_PATTERN)) {
    const word = match[0].toLowerCase();
    if (word.length < 2) continue;
    tokens.push(word);
  }

  return tokens;
}

const LATIN_WORD_PATTERN = /[A-Za-z0-9_'-]+/g;

/**
 * CJK 码位判定：统一表意文字（含扩展 A/B）、兼容表意、日文假名、韩文谚文。
 * 判定口径放宽到「无空格分词习惯的东亚文字」——bigram 对它们同样成立。
 */
function isCjkCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x3040 && codePoint <= 0x30ff) || // 平假名 + 片假名
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) || // CJK 扩展 A
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) || // CJK 统一表意文字
    (codePoint >= 0xac00 && codePoint <= 0xd7af) || // 谚文音节
    (codePoint >= 0xf900 && codePoint <= 0xfaff) || // CJK 兼容表意
    (codePoint >= 0x20000 && codePoint <= 0x2ffff) // CJK 扩展 B-F（代理对区）
  );
}

/** 单条记忆的检索文档表示输入：frontmatter 关键字段 + 正文（R2 末条）。 */
export interface MemoryRetrievalDocumentInput {
  name?: string;
  description?: string;
  type?: string;
  tags?: readonly string[];
  /** frontmatter 剥离后的正文（`buildRetrievalDocumentTokens` 内不做剥离，调用方负责）。 */
  content: string;
}

/**
 * 构造单条记忆的文档 token 表示（R2）：frontmatter `name`/`description`/`type`/tags
 * （若存在）与正文共同进文档表示，`description` 权重 ×2——它就是给检索写的一句话摘要。
 * BM25 的 tf 饱和（k1）会自然封顶重复收益，×2 只是让摘要词在同等正文命中时占先。
 */
export function buildRetrievalDocumentTokens(input: MemoryRetrievalDocumentInput): string[] {
  const tokens: string[] = [];
  for (const field of [input.name ?? "", input.type ?? "", ...(input.tags ?? [])]) {
    if (field.length === 0) continue;
    tokens.push(...tokenizeForRetrieval(field));
  }
  const descriptionTokens = tokenizeForRetrieval(input.description ?? "");
  tokens.push(...descriptionTokens, ...descriptionTokens);
  tokens.push(...tokenizeForRetrieval(input.content));
  return tokens;
}

/** 剥离 frontmatter 取正文；无合法 frontmatter 时返回原文。行判定与 parseMemoryFrontmatter 同构。 */
export function stripMemoryFrontmatter(content: string): string {
  const normalized = content.replace(/^\uFEFF/u, "").replace(/\r\n/gu, "\n");
  const lines = normalized.split("\n");
  if (lines[0] !== "---") return content;
  const end = lines.indexOf("---", 1);
  if (end < 0) return content;
  return lines.slice(end + 1).join("\n");
}
