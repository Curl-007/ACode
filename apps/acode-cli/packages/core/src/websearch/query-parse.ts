// Ported from oh-my-pi (MIT) — packages/coding-agent/src/web/search/query.ts（解析半部）
// Copyright (c) 2025 Mario Zechner & Stencil Labs
// 结构化查询解析：把 Google 风格指令从原始查询里拆成 StructuredQuery。
// 语义纪律照抄 omp：宽松解析（未知 name:value 保持原文；不可解析值降解为普通词不丢弃）。
// 分词器拆在 query-tokenize.ts（400 行上限）。

import { tokenize } from "./query-tokenize.js";
import {
  ALL_MODES,
  DIRECTIVE_FIELDS,
  DIRECTIVE_PATTERN,
  isReservedToken,
  normalizeSite,
} from "./query-directives.js";

/** 查询的自由文本词元（非指令部分）。 */
export interface QueryTerm {
  /** 不含引号与算子前缀的词元文本。 */
  text: string;
  /** 引号精确短语（"like this"）或 verbatim 要求（+term）。 */
  phrase?: boolean;
  /** 经 -term 或 NOT term 排除。 */
  negated?: boolean;
  /** OR 组 id。同 id 词元互为备选；无组词元隐式 AND。组在 terms 中总是连续段。 */
  group?: number;
}

/** 原始查询分解出的自由文本与全部识别到的约束。列表字段恒在（可为空）。 */
export interface StructuredQuery {
  /** 原始查询串，逐字保留。 */
  raw: string;
  /** 去掉识别到的指令后的自由文本（引号保留、排除保留 -、OR 组保留 OR）。指令型查询可能为空——引擎查询串请用 formatQuery（永不空）。 */
  text: string;
  /** 有序自由词元（短语、排除、OR 组）。 */
  terms: QueryTerm[];
  /** `site:`/`domain:`/`host:` 包含域——任一匹配。小写、去 scheme，可带路径（github.com/anthropics）。 */
  sites: string[];
  /** `-site:` 排除域，归一化同 sites。 */
  excludedSites: string[];
  /** `inurl:`/`url:`/`allinurl:` 子串——全部必须出现在 URL。 */
  inUrl: string[];
  /** `-inurl:` 子串——不得出现在 URL。 */
  excludedInUrl: string[];
  /** `intitle:`/`title:`/`allintitle:` 子串——全部必须出现在标题。 */
  inTitle: string[];
  /** `-intitle:` 子串——不得出现在标题。 */
  excludedInTitle: string[];
  /** `intext:`/`inbody:`/`inanchor:`/`allintext:` 正文子串。不可后置过滤（摘录是局部的）；仅查询构建用。 */
  inText: string[];
  /** `-intext:` 正文排除。仅查询构建用。 */
  excludedInText: string[];
  /** `filetype:`/`ext:` 扩展名——任一匹配。小写、无前导点。 */
  filetypes: string[];
  /** `-filetype:`/`-ext:` 扩展名——不得匹配。 */
  excludedFiletypes: string[];
  /** `after:`/`since:` 的含下界发布日期，ISO `YYYY-MM-DD`。 */
  after?: string;
  /** `before:`/`until:` 的不含上界发布日期，ISO `YYYY-MM-DD`。 */
  before?: string;
  /** `lang:`/`language:` 语言码，小写（如 en、zh-cn）。 */
  lang?: string;
  /** 识别到任一指令或布尔算子。 */
  hasDirectives: boolean;
  /** 存在任一可后置过滤约束（sites、url/title 词、filetypes、日期界）。 */
  hasConstraints: boolean;
}

type AllMode = "inTitle" | "inUrl" | "inText";

/** 年月日转合法 ISO 日期，非法返回 undefined。 */
function isoDate(year: number, month: number, day: number): string | undefined {
  if (year < 1000 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * 解析 `before:`/`after:` 值为 ISO `YYYY-MM-DD`。
 * 接受 `YYYY`、`YYYY-MM`、`YYYY-MM-DD`（`/`、`.` 分隔符同）与 `MM/DD/YYYY`
 * （首字段 >12 时按日优先）。裸年/月落到该期首日，对齐 Google 的
 * `after:2024` ≙ `after:2024-01-01` 语义。
 */
export function parseDateValue(value: string): string | undefined {
  const t = value.trim();
  let m = /^(\d{4})(?:[-/.](\d{1,2})(?:[-/.](\d{1,2}))?)?$/.exec(t);
  if (m) return isoDate(Number(m[1]), m[2] ? Number(m[2]) : 1, m[3] ? Number(m[3]) : 1);
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(t);
  if (m) {
    let month = Number(m[1]);
    let day = Number(m[2]);
    if (month > 12 && day <= 12) [month, day] = [day, month];
    return isoDate(Number(m[3]), month, day);
  }
  return undefined;
}

/**
 * 把原始查询解析为 {@link StructuredQuery}。
 *
 * 天然宽松：未知 `name:value` 词元（URL、`C:\paths`、`TS2345:`）逐字保留在自由
 * 文本里；不可解析值的指令（`before:someday`）降解为普通词而不是被丢弃。
 */
export function parseSearchQuery(raw: string): StructuredQuery {
  const q: StructuredQuery = {
    raw,
    text: "",
    terms: [],
    sites: [],
    excludedSites: [],
    inUrl: [],
    excludedInUrl: [],
    inTitle: [],
    excludedInTitle: [],
    inText: [],
    excludedInText: [],
    filetypes: [],
    excludedFiletypes: [],
    hasDirectives: false,
    hasConstraints: false,
  };

  const tokens = tokenize(raw);
  let negateNext = false;
  let orPending = false;
  let lastWasTerm = false;
  let groupSeq = 0;
  let allMode: AllMode | undefined;

  const pushConstraint = (
    field: "site" | "inUrl" | "inTitle" | "inText" | "filetype",
    value: string,
    negated: boolean,
  ): void => {
    q.hasDirectives = true;
    orPending = false;
    lastWasTerm = false;
    const v = value.trim();
    if (!v) return;
    switch (field) {
      case "site": {
        const site = normalizeSite(v);
        if (site) (negated ? q.excludedSites : q.sites).push(site);
        break;
      }
      case "inUrl":
        (negated ? q.excludedInUrl : q.inUrl).push(v);
        break;
      case "inTitle":
        (negated ? q.excludedInTitle : q.inTitle).push(v);
        break;
      case "inText":
        (negated ? q.excludedInText : q.inText).push(v);
        break;
      case "filetype": {
        const ext = v.toLowerCase().replace(/^\.+/, "");
        if (ext) (negated ? q.excludedFiletypes : q.filetypes).push(ext);
        break;
      }
    }
  };

  const pushTerm = (text: string, phrase: boolean): void => {
    const negated = negateNext;
    negateNext = false;
    if (allMode) {
      pushConstraint(allMode, text, negated);
      return;
    }
    const term: QueryTerm = { text };
    if (phrase) term.phrase = true;
    if (negated) term.negated = true;
    if (orPending && lastWasTerm) {
      const prev = q.terms[q.terms.length - 1];
      if (prev) {
        prev.group ??= ++groupSeq;
        term.group = prev.group;
      }
    }
    orPending = false;
    lastWasTerm = true;
    q.terms.push(term);
  };

  for (let idx = 0; idx < tokens.length; idx++) {
    const tok = tokens[idx];

    if (tok.quoted) {
      pushTerm(tok.text, true);
      continue;
    }

    // 布尔算子与分组括号。
    if (tok.text === "(" || tok.text === ")") continue;
    if (tok.text === "OR" || tok.text === "|" || tok.text === "||") {
      orPending = true;
      q.hasDirectives = true;
      continue;
    }
    if (tok.text === "AND" || tok.text === "&&") {
      q.hasDirectives = true;
      continue;
    }
    if (tok.text === "NOT" || tok.text === "!") {
      negateNext = true;
      q.hasDirectives = true;
      continue;
    }
    if (tok.text === "-" || tok.text === "+") {
      // tokenizer 会把 `-"exact phrase"` 拆成 `-` + 短语；把否定传导过去。
      if (tok.text === "-" && tokens[idx + 1]?.quoted) negateNext = true;
      continue;
    }

    const match = DIRECTIVE_PATTERN.exec(tok.text);
    const name = match?.[2].toLowerCase();
    const allMatch = name ? ALL_MODES[name] : undefined;
    const field = name ? DIRECTIVE_FIELDS[name] : undefined;

    if (match && allMatch) {
      allMode = allMatch;
      q.hasDirectives = true;
      // `allintitle:budget tips`——内联值加后续全部词元。
      const inline = match[3].trim();
      if (inline) pushConstraint(allMatch, inline, match[1] === "-");
      orPending = false;
      lastWasTerm = false;
      continue;
    }

    if (match && field) {
      let value = match[3].trim();
      // `site: example.com`——宽松：下一个普通词元作为值。
      if (!value) {
        const next = tokens[idx + 1];
        if (next && (next.quoted || !isReservedToken(next.text))) {
          value = next.text.trim();
          idx++;
        }
      }
      if (!value) {
        q.hasDirectives = true;
        continue;
      }
      const negated = match[1] === "-" || negateNext;
      negateNext = false;
      switch (field) {
        case "before":
        case "after": {
          const iso = parseDateValue(value);
          if (!iso) {
            pushTerm(tok.text, false);
            continue;
          }
          if (field === "before") q.before = iso;
          else q.after = iso;
          q.hasDirectives = true;
          orPending = false;
          lastWasTerm = false;
          break;
        }
        case "lang":
          q.lang = value.toLowerCase();
          q.hasDirectives = true;
          orPending = false;
          lastWasTerm = false;
          break;
        default:
          pushConstraint(field, value, negated);
      }
      continue;
    }

    // 带可选 +/- 前缀的普通词元。
    let text = tok.text;
    if (text.startsWith("-") && text.length > 1) {
      negateNext = true;
      q.hasDirectives = true;
      text = text.replace(/^-+/, "");
      if (!text) continue;
      // `-site:x` 只在写成 `- site:x` 时会预先拆开；再查一次指令。
      const negMatch = DIRECTIVE_PATTERN.exec(text);
      const negName = negMatch?.[2].toLowerCase();
      const negField = negName ? DIRECTIVE_FIELDS[negName] : undefined;
      if (negMatch && negField && negField !== "before" && negField !== "after" && negField !== "lang") {
        negateNext = false;
        pushConstraint(negField, negMatch[3].trim(), true);
        continue;
      }
      pushTerm(text, false);
      continue;
    }
    if (text.startsWith("+") && text.length > 1) {
      // Google 遗留 `+term`：verbatim/必须——按精确短语处理。
      pushTerm(text.slice(1), true);
      q.hasDirectives = true;
      continue;
    }
    pushTerm(text, false);
  }

  q.text = renderTerms(q.terms, { phrases: true, negation: true, or: true });
  q.hasConstraints =
    q.sites.length > 0 ||
    q.excludedSites.length > 0 ||
    q.inUrl.length > 0 ||
    q.excludedInUrl.length > 0 ||
    q.inTitle.length > 0 ||
    q.excludedInTitle.length > 0 ||
    q.filetypes.length > 0 ||
    q.excludedFiletypes.length > 0 ||
    q.before !== undefined ||
    q.after !== undefined;
  return q;
}

/**
 * 目标引擎的查询语法能力，formatQuery 据此决定把哪些解析特性重新输出为查询文本。
 * 全部默认 `false`：零值产出适合自然语言 API 的纯关键词。
 */
export interface QuerySyntax {
  /** 输出 "quoted phrases"。 */
  phrases?: boolean;
  /** 输出 -term 排除（否则丢弃否定词元）。 */
  negation?: boolean;
  /** 备选项之间输出 OR（否则组摊平为关键词）。 */
  or?: boolean;
  /** 输出 site:`/`-site:`。 */
  site?: boolean;
  /** 输出 inurl:`/`-inurl:`。 */
  inUrl?: boolean;
  /** 输出 intitle:`/`-intitle:`。 */
  inTitle?: boolean;
  /** 输出 intext:`/`-intext:`。 */
  inText?: boolean;
  /** 输出 filetype:`/`-filetype:`。 */
  filetype?: boolean;
  /** 输出 before:`/`after:` ISO 日期界。 */
  dateRange?: boolean;
}

/** 按目标语法渲染自由词元（query-format.ts 复用，方向单向避免环）。 */
export function renderTerms(terms: readonly QueryTerm[], syntax: QuerySyntax): string {
  const parts: string[] = [];
  for (let i = 0; i < terms.length; i++) {
    const term = terms[i];
    if (term.group !== undefined && syntax.or) {
      const members: string[] = [];
      let j = i;
      for (; j < terms.length && terms[j].group === term.group; j++) {
        const rendered = renderTerm(terms[j], syntax);
        if (rendered) members.push(rendered);
      }
      i = j - 1;
      if (members.length > 1) parts.push(`(${members.join(" OR ")})`);
      else if (members.length === 1) parts.push(members[0]);
      continue;
    }
    const rendered = renderTerm(term, syntax);
    if (rendered) parts.push(rendered);
  }
  return parts.join(" ");
}

function renderTerm(term: QueryTerm, syntax: QuerySyntax): string | undefined {
  if (term.negated && !syntax.negation) return undefined;
  const body = term.phrase && syntax.phrases ? `"${term.text}"` : term.text;
  return term.negated ? `-${body}` : body;
}
