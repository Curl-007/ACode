// Ported from oh-my-pi (MIT) — packages/coding-agent/src/web/search/query.ts（分词半部）
// Copyright (c) 2025 Mario Zechner & Stencil Labs
// 从 query-parse.ts 拆出（400 行上限），纯分词无解析语义。

export interface RawToken {
  text: string;
  /** 整个词元是引号短语。 */
  quoted: boolean;
  /** 指令值是引号形式（`intitle:"a b"`）。 */
  quotedValue?: boolean;
}

export function isQuote(ch: string): boolean {
  return ch === '"' || ch === "\u201c" || ch === "\u201d";
}

/** Unicode 感知的空白（agent 会粘贴 NBSP 之类）。 */
const WHITESPACE = /\s/;

/** 按空白切词，保留引号短语与独立括号。 */
export function tokenize(raw: string): RawToken[] {
  const tokens: RawToken[] = [];
  const n = raw.length;
  let i = 0;
  while (i < n) {
    const ch = raw[i];
    if (WHITESPACE.test(ch)) {
      i++;
      continue;
    }
    if (isQuote(ch)) {
      let j = i + 1;
      let buf = "";
      while (j < n && !isQuote(raw[j])) {
        buf += raw[j];
        j++;
      }
      if (buf.trim().length > 0) tokens.push({ text: buf.trim(), quoted: true });
      i = j + 1;
      continue;
    }
    // 裸词；紧跟在 `name:` 后的引号把引号段并进同一词元（intitle:"budget tips"）。
    let buf = "";
    let quotedValue = false;
    while (i < n && !WHITESPACE.test(raw[i])) {
      const c = raw[i];
      if (isQuote(c) && buf.endsWith(":")) {
        let j = i + 1;
        while (j < n && !isQuote(raw[j])) {
          buf += raw[j];
          j++;
        }
        quotedValue = true;
        i = j + 1;
        continue;
      }
      if (isQuote(c)) break; // `foo"bar`——终止当前词，让引号开启一个短语
      buf += c;
      i++;
    }
    if (buf.length > 0) tokens.push({ text: buf, quoted: false, quotedValue });
  }
  return splitParens(tokens);
}

/**
 * 把前导 `(` 与不平衡的尾随 `)` 拆成独立词元：`(react OR vue)` 可解析，
 * 而 `site:wikipedia.org/Foo_(bar)` 保持完整。
 */
function splitParens(tokens: RawToken[]): RawToken[] {
  const out: RawToken[] = [];
  for (const tok of tokens) {
    if (tok.quoted || tok.quotedValue) {
      out.push(tok);
      continue;
    }
    let text = tok.text;
    while (text.startsWith("(")) {
      out.push({ text: "(", quoted: false });
      text = text.slice(1);
    }
    let trailing = 0;
    while (text.endsWith(")")) {
      // 只剥离不闭合词内开括号的括号。
      const body = text.slice(0, -1);
      let depth = 0;
      for (const c of body) {
        if (c === "(") depth++;
        else if (c === ")") depth--;
      }
      if (depth > 0) break;
      text = body;
      trailing++;
    }
    if (text.length > 0) out.push({ text, quoted: false });
    for (let k = 0; k < trailing; k++) out.push({ text: ")", quoted: false });
  }
  return out;
}
