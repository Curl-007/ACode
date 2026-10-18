// Ported from oh-my-pi (MIT) — packages/coding-agent/src/web/search/query.ts（过滤半部）
// Copyright (c) 2025 Mario Zechner & Stencil Labs
// 宽松后置过滤：逐约束维度过滤，会把结果清空的维度放宽并上报——宁放宽不空结果。

import type { SearchSource } from "./types.js";
import type { StructuredQuery } from "./query-parse.js";

/** URL 的主机名（小写）与路径；解析失败返回 undefined。 */
function hostAndPath(url: string): { host: string; path: string } | undefined {
  try {
    const u = new URL(url);
    return { host: u.hostname.toLowerCase(), path: u.pathname };
  } catch {
    return undefined;
  }
}

/**
 * `site:` 匹配器：精确主机或其子域；`site` 带路径（github.com/anthropics）时
 * URL 路径必须以它开头。
 */
export function matchesSite(url: string, site: string): boolean {
  const parsed = hostAndPath(url);
  if (!parsed) return false;
  const slash = site.indexOf("/");
  const siteHost = slash === -1 ? site : site.slice(0, slash);
  const sitePath = slash === -1 ? "" : site.slice(slash);
  if (parsed.host !== siteHost && !parsed.host.endsWith(`.${siteHost}`)) return false;
  if (sitePath && !parsed.path.toLowerCase().startsWith(sitePath.toLowerCase())) return false;
  return true;
}

/** `filetype:` 匹配器：URL 路径以 .ext 结尾。 */
function matchesFiletype(url: string, ext: string): boolean {
  const parsed = hostAndPath(url);
  if (!parsed) return false;
  return parsed.path.toLowerCase().endsWith(`.${ext}`);
}

const RELATIVE_AGE_PATTERN = /^(\d+)\s*(minute|min|hour|hr|day|week|month|mo|year|yr|[mhdwy])s?\s+ago$/i;

const RELATIVE_UNIT_SECONDS: Record<string, number> = {
  m: 60,
  min: 60,
  minute: 60,
  h: 3600,
  hr: 3600,
  hour: 3600,
  d: 86_400,
  day: 86_400,
  w: 604_800,
  week: 604_800,
  mo: 2_592_000,
  month: 2_592_000,
  y: 31_536_000,
  yr: 31_536_000,
  year: 31_536_000,
};

/** 来源的尽力发布时间（ms epoch）：ageSeconds、ISO 或相对日期。 */
function sourceTime(source: SearchSource): number | undefined {
  if (typeof source.ageSeconds === "number" && Number.isFinite(source.ageSeconds)) {
    return Date.now() - source.ageSeconds * 1000;
  }
  if (!source.publishedDate) return undefined;
  const rel = RELATIVE_AGE_PATTERN.exec(source.publishedDate.trim());
  if (rel) {
    const seconds = Number(rel[1]) * (RELATIVE_UNIT_SECONDS[rel[2].toLowerCase()] ?? 0);
    return seconds > 0 ? Date.now() - seconds * 1000 : undefined;
  }
  const parsed = Date.parse(source.publishedDate);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * 逐来源严格约束检查：q 的每个可过滤维度都必须通过。解析不出日期的来源通过日期界
 * （缺日期不是违规证据）。自定义 provider 流程用；标准路径是 applyQueryConstraints。
 */
export function matchesQueryConstraints(source: SearchSource, q: StructuredQuery): boolean {
  for (const dim of constraintDimensions(q)) {
    if (!dim.pred(source)) return false;
  }
  return true;
}

interface ConstraintDimension {
  /** 放宽说明用的指令渲染（site:arxiv.org）。 */
  label: string;
  pred: (source: SearchSource) => boolean;
}

function constraintDimensions(q: StructuredQuery): ConstraintDimension[] {
  const dims: ConstraintDimension[] = [];
  const lower = (s: string | undefined): string => (s ?? "").toLowerCase();

  if (q.sites.length > 0) {
    dims.push({
      label: q.sites.map(s => `site:${s}`).join(" OR "),
      pred: src => q.sites.some(site => matchesSite(src.url, site)),
    });
  }
  if (q.excludedSites.length > 0) {
    dims.push({
      label: q.excludedSites.map(s => `-site:${s}`).join(" "),
      pred: src => !q.excludedSites.some(site => matchesSite(src.url, site)),
    });
  }
  if (q.inUrl.length > 0) {
    dims.push({
      label: q.inUrl.map(v => `inurl:${v}`).join(" "),
      pred: src => q.inUrl.every(v => lower(src.url).includes(v.toLowerCase())),
    });
  }
  if (q.excludedInUrl.length > 0) {
    dims.push({
      label: q.excludedInUrl.map(v => `-inurl:${v}`).join(" "),
      pred: src => !q.excludedInUrl.some(v => lower(src.url).includes(v.toLowerCase())),
    });
  }
  if (q.inTitle.length > 0) {
    dims.push({
      label: q.inTitle.map(v => `intitle:${v}`).join(" "),
      pred: src => q.inTitle.every(v => lower(src.title).includes(v.toLowerCase())),
    });
  }
  if (q.excludedInTitle.length > 0) {
    dims.push({
      label: q.excludedInTitle.map(v => `-intitle:${v}`).join(" "),
      pred: src => !q.excludedInTitle.some(v => lower(src.title).includes(v.toLowerCase())),
    });
  }
  if (q.filetypes.length > 0) {
    dims.push({
      label: q.filetypes.map(f => `filetype:${f}`).join(" OR "),
      pred: src => q.filetypes.some(ext => matchesFiletype(src.url, ext)),
    });
  }
  if (q.excludedFiletypes.length > 0) {
    dims.push({
      label: q.excludedFiletypes.map(f => `-filetype:${f}`).join(" "),
      pred: src => !q.excludedFiletypes.some(ext => matchesFiletype(src.url, ext)),
    });
  }
  if (q.after !== undefined || q.before !== undefined) {
    const afterMs = q.after !== undefined ? Date.parse(q.after) : undefined;
    const beforeMs = q.before !== undefined ? Date.parse(q.before) : undefined;
    const label = [q.after ? `after:${q.after}` : "", q.before ? `before:${q.before}` : ""].filter(Boolean).join(" ");
    dims.push({
      label,
      pred: src => {
        const time = sourceTime(src);
        if (time === undefined) return true; // 无日期 → 无法证明违规
        if (afterMs !== undefined && time < afterMs) return false;
        if (beforeMs !== undefined && time >= beforeMs) return false;
        return true;
      },
    });
  }
  return dims;
}

/** applyQueryConstraints 的结果。 */
export interface ConstraintFilterResult {
  /** 存活来源——输入非空时结果永不空。 */
  sources: SearchSource[];
  /**
   * 零匹配而被放宽（而非强制执行）的约束维度渲染（`site:arxiv.org`、
   * `before:2024-01-01`…）。
   */
  dropped: string[];
}

/**
 * 宽松后置过滤：逐维度应用 q 的约束，跳过（并上报）会清空全部剩余来源的维度。
 * 输入非空时保证非空结果——错配的指令降解为未过滤结果加一条说明，而不是死搜索。
 */
export function applyQueryConstraints(sources: readonly SearchSource[], q: StructuredQuery): ConstraintFilterResult {
  let current = [...sources];
  const dropped: string[] = [];
  if (current.length === 0) return { sources: current, dropped };
  for (const dim of constraintDimensions(q)) {
    const kept = current.filter(dim.pred);
    if (kept.length > 0) current = kept;
    else dropped.push(dim.label);
  }
  return { sources: current, dropped };
}
