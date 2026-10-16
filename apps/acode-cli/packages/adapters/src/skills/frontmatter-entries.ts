// ============================================================
// Skill Frontmatter 条目收集（specs/skill-frontmatter-governance.md R2/R10）
// ============================================================
// 治理键的三种声明形态归一为条目数组：内联逗号/空格分隔串、流式列表 `[a, b]`、
// YAML 块列表（`key:` 后跟缩进 `- item` 行——parseFlatYaml 不收缩进行，块列表由
// 本模块对 frontmatter 原文自行扫描，不动既有解析函数）。
// 语法调查依据（还原工程，只读复核）：逗号/空格分裂尊重括号深度
// （beautified chunk-v4cg890f.js `Ku`）、数组/字符串双形态归一（chunk-z9xtzw2s.js
// `cmt`/`wRt`）。实现为自撰，不搬文本。

import { parseScalar } from "./frontmatter-text.js";

/** 键是否被声明：平铺值命中，或原文存在顶层 `key:` 行（invalid-line 兜底）。 */
export function declaresFrontmatterKey(
  frontmatter: string | null,
  values: Record<string, string>,
  key: string,
): boolean {
  if (values[key] !== undefined) return true;
  return frontmatter !== null && findKeyLine(frontmatter, key) !== -1;
}

/** 收集键的条目数组（内联串分裂优先；值为空时扫描原文块列表）。 */
export function collectFrontmatterEntries(
  frontmatter: string | null,
  values: Record<string, string>,
  key: string,
): string[] {
  const inline = values[key]?.trim() ?? "";
  if (inline.length > 0) return splitTopLevel(stripFlowBrackets(inline));
  if (frontmatter === null) return [];
  return collectBlockListItems(frontmatter, key);
}

function stripFlowBrackets(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
}

/**
 * 逗号/空格分裂，尊重括号、方括号、花括号与引号深度（参考 Ku 同构）：
 * `Skill(plugin:skill *)` 的空格、`Bash(cmd a, b)` 的逗号都是规则内容的一部分。
 */
function splitTopLevel(value: string): string[] {
  const entries: string[] = [];
  let current = "";
  let depth = 0;
  let quote: string | null = null;
  for (const char of value) {
    if (quote) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === "(" || char === "[" || char === "{") depth++;
    if (char === ")" || char === "]" || char === "}") depth = Math.max(0, depth - 1);
    if ((char === "," || /\s/.test(char)) && depth === 0) {
      if (current.trim().length > 0) entries.push(current.trim());
      current = "";
      continue;
    }
    if (current.length > 0 || char.trim().length > 0) current += char;
  }
  if (current.trim().length > 0) entries.push(current.trim());
  return entries.map((entry) => parseScalar(entry) ?? entry);
}

/** 扫描 frontmatter 原文收 `key:` 行之后的缩进 `- item` 块（R10：不动 parseFlatYaml）。 */
function collectBlockListItems(frontmatter: string, key: string): string[] {
  const lines = frontmatter.split(/\r?\n/);
  const keyIndex = findKeyLine(frontmatter, key);
  if (keyIndex === -1) return [];
  const items: string[] = [];
  for (let index = keyIndex + 1; index < lines.length; index++) {
    const line = lines[index] ?? "";
    if (line.trim().length === 0 || line.trim().startsWith("#")) continue;
    const item = /^\s+-\s*(.*)$/.exec(line);
    if (!item) break; // 非列表行（下一键或围栏残留）即止
    const value = parseScalar(item[1] ?? "");
    if (value !== undefined && value.length > 0) items.push(value);
  }
  return items;
}

function findKeyLine(frontmatter: string, key: string): number {
  const lines = frontmatter.split(/\r?\n/);
  return lines.findIndex((line) => {
    if (/^\s/.test(line)) return false;
    const separator = line.indexOf(":");
    return separator > 0 && line.slice(0, separator).trim() === key;
  });
}
