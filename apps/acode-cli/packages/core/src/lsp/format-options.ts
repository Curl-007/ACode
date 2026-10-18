// Ported from oh-my-pi (MIT) — packages/coding-agent/src/lsp/format-options.ts, Copyright (c) 2025 Mario Zechner & Stencil Labs
// ============================================================
// 按文件解析 LSP FormattingOptions
// ============================================================
// omp 历史上给每次 textDocument/formatting 硬编码 `{ tabSize: 3, insertSpaces: true }`，
// 悄悄把 2 空格 YAML（及一切 LSP 格式化文件）重新缩进。本移植保留内容嗅探与回退；
// .editorconfig 读取未移植（见 spec §8 削减登记）。

/** 我们发送的 LSP FormattingOptions 子集。 */
export interface LspFormattingOptions {
  tabSize: number;
  insertSpaces: boolean;
  trimTrailingWhitespace: boolean;
  insertFinalNewline: boolean;
  trimFinalNewlines: boolean;
}

/** 内容与 .editorconfig 都未定住缩进时的回退：2 空格（YAML/JSON/JS/TS 主流）。 */
const FALLBACK_TAB_SIZE = 2;
const FALLBACK_INSERT_SPACES = true;

/** 始终传递的静态标志：无按文件对应物，匹配常见格式化器预期。 */
const TRIM_OPTIONS = {
  trimTrailingWhitespace: true,
  insertFinalNewline: true,
  trimFinalNewlines: true,
} as const;

interface DetectedIndent {
  tabSize?: number;
  insertSpaces?: boolean;
}

function gcd(a: number, b: number): number {
  let x = a;
  let y = b;
  while (y !== 0) {
    const t = y;
    y = x % y;
    x = t;
  }
  return x;
}

/**
 * 从 content 嗅探 insertSpaces 与缩进单位。
 *
 * 单遍扫描：第一条有缩进的行决定空格还是 tab；空格缩进取全部宽度 GCD
 * （2/4/6 文件报 2，4/8 报 4）。内容未定住的字段返回 undefined，
 * 让更高优先级的来源（编辑器配置）不被嗅探噪声覆盖。
 */
export function detectIndentFromContent(content: string): DetectedIndent {
  if (content.length === 0) return {};

  let insertSpaces: boolean | undefined;
  let unit = 0;

  for (const line of content.split("\n")) {
    // 空白行没有缩进信号。
    if (line.length === 0 || line.trim().length === 0) continue;

    const first = line[0]!;
    if (first !== " " && first !== "\t") continue;

    if (insertSpaces === undefined) {
      insertSpaces = first === " ";
    }

    // tab 缩进文件：单位就是一个 tab；tabSize 是显示关切，交给回退。
    if (first === "\t") continue;

    // 空格缩进：数前导空格（遇 tab 停，避免混用）。非零宽度取 GCD 收敛步长。
    let n = 0;
    while (n < line.length && line[n] === " ") n += 1;
    if (n === 0) continue;
    unit = unit === 0 ? n : gcd(unit, n);
  }

  const result: DetectedIndent = {};
  if (insertSpaces !== undefined) result.insertSpaces = insertSpaces;
  if (unit > 0 && insertSpaces === true) result.tabSize = unit;
  return result;
}

/** 组装 textDocument/formatting 的 FormattingOptions 载荷。 */
export function resolveFormatOptions(_filePath: string, content: string): LspFormattingOptions {
  const detected = detectIndentFromContent(content);
  return {
    tabSize: detected.tabSize ?? FALLBACK_TAB_SIZE,
    insertSpaces: detected.insertSpaces ?? FALLBACK_INSERT_SPACES,
    ...TRIM_OPTIONS,
  };
}
