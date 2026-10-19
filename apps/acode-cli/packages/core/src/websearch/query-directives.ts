// Ported from oh-my-pi (MIT) — packages/coding-agent/src/web/search/query.ts（指令表半部）
// Copyright (c) 2025 Mario Zechner & Stencil Labs
// 从 query-parse.ts 拆出（400 行上限，架构 ratchet）：指令名映射与 site 归一化。

/** 指令词元的词法形态：可选 +/- 前缀 + name: + 值。 */
export const DIRECTIVE_PATTERN = /^([+-]?)([a-z][a-z-]*):(.*)$/i;

/** 指令名到规范字段的映射。 */
export const DIRECTIVE_FIELDS: Record<
  string,
  "site" | "inUrl" | "inTitle" | "inText" | "filetype" | "before" | "after" | "lang"
> = {
  site: "site",
  domain: "site",
  host: "site",
  inurl: "inUrl",
  url: "inUrl",
  intitle: "inTitle",
  title: "inTitle",
  intext: "inText",
  inbody: "inText",
  inanchor: "inText",
  filetype: "filetype",
  ext: "filetype",
  before: "before",
  until: "before",
  after: "after",
  since: "after",
  lang: "lang",
  language: "lang",
};

/** 吞掉后续全部普通词元的 `allin*:` 指令。 */
export const ALL_MODES: Record<string, "inTitle" | "inUrl" | "inText"> = {
  allintitle: "inTitle",
  allinurl: "inUrl",
  allintext: "inText",
};

/** 算子/括号/已识别指令——裸 `name:` 不得把它们当值吞掉。 */
export function isReservedToken(text: string): boolean {
  if (
    text === "(" ||
    text === ")" ||
    text === "OR" ||
    text === "AND" ||
    text === "NOT" ||
    text === "|" ||
    text === "||" ||
    text === "&&" ||
    text === "!"
  ) {
    return true;
  }
  const m = DIRECTIVE_PATTERN.exec(text);
  if (!m) return false;
  const name = m[2].toLowerCase();
  return DIRECTIVE_FIELDS[name] !== undefined || ALL_MODES[name] !== undefined;
}

/** 小写 `site:` 值并剥掉 scheme、`*.` 通配与尾斜杠/点。 */
export function normalizeSite(value: string): string {
  let site = value.trim().toLowerCase();
  site = site.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  if (site.startsWith("*.")) site = site.slice(2);
  site = site.replace(/[/.]+$/, "");
  return site;
}
