/**
 * 代码片段 / 快捷短语：协议无关的共享类型、模板解析与渲染、内置库 schema。
 *
 * 纯函数 + Zod，不依赖 node:* / React，可同时被 services（校验与落库）与 ui（面板渲染）消费。
 * 模板语法与转义的唯一裁决处就是本文件，UI 与服务不得各写一份。
 */
import { z } from "zod";

// ============================================================================
// 常量与上限（数值是产品契约，改动需同步 PRD §3.2 / §3.3 / §3.5）
// ============================================================================

export const PROMPT_SNIPPET_KINDS = ["prompt", "suffix"] as const;
export const promptSnippetKindSchema = z.enum(PROMPT_SNIPPET_KINDS);
export type PromptSnippetKind = z.infer<typeof promptSnippetKindSchema>;

/** `suffix` = 纪律后缀：追加在已打内容末尾，不清空、不自动提交。 */
export const PROMPT_SNIPPET_NAME_MAX_LENGTH = 60;
export const PROMPT_SNIPPET_CATEGORY_MAX_LENGTH = 24;
export const PROMPT_SNIPPET_CONTENT_MAX_LENGTH = 8000;
/** 变量填写框一次最多覆盖的变量数；超出部分在正文里保留字面量，不静默丢弃。 */
export const PROMPT_SNIPPET_MAX_VARIABLES = 10;
/** 跨工作区可见的保留 workspace_key；本批只读不写（无 UI 开关）。 */
export const PROMPT_SNIPPET_GLOBAL_WORKSPACE_KEY = "__global__";
/** SQLite INTEGER 上限；达到后停止自增（last_used_at 仍更新）。 */
export const PROMPT_SNIPPET_MAX_USE_COUNT = 2147483647;

export const PROMPT_SNIPPET_GROUPS = [
  "discipline",
  "general",
  "automation",
  "ops",
  "framework",
] as const;
/** 面板与设置页的分组展示顺序（产品规则，不是排序算法）。 */
export const PROMPT_SNIPPET_GROUP_ORDER = PROMPT_SNIPPET_GROUPS;
export const promptSnippetGroupSchema = z.enum(PROMPT_SNIPPET_GROUPS);
export type PromptSnippetGroup = z.infer<typeof promptSnippetGroupSchema>;

export const PROMPT_SNIPPET_FRAMEWORKS = [
  "next",
  "react",
  "vue",
  "svelte",
  "nestjs",
  "tauri",
] as const;
export const promptSnippetFrameworkSchema = z.enum(PROMPT_SNIPPET_FRAMEWORKS);
export type PromptSnippetFramework = z.infer<typeof promptSnippetFrameworkSchema>;

/**
 * 技术栈探测白名单 → package.json 依赖键的映射。
 * 匹配规则是**精确键名相等**：`react` 只看 `react`，不会因为 `react-dom` 而误命中。
 */
export const PROMPT_SNIPPET_FRAMEWORK_DEPENDENCIES: Readonly<
  Record<PromptSnippetFramework, readonly string[]>
> = {
  next: ["next"],
  react: ["react"],
  vue: ["vue"],
  svelte: ["svelte", "@sveltejs/kit"],
  nestjs: ["@nestjs/core"],
  tauri: ["@tauri-apps/api", "@tauri-apps/cli"],
};

// ============================================================================
// 模板变量：语法、转义与解析
// ============================================================================

/** 变量名允许中文；长度按 `Array.from().length` ≤ 32 由下面的正则限定为 1~32 个码点。 */
const VARIABLE_NAME_RE = /^[A-Za-z\u4e00-\u9fff][A-Za-z0-9_\u4e00-\u9fff-]{0,31}$/;

const ESCAPED_OPEN = "\\{\\{";
const ESCAPED_CLOSE = "\\}\\}";

type SnippetTemplateSegment = { type: "text"; text: string } | { type: "variable"; name: string };

/**
 * 单次左到右扫描，同时完成转义还原、占位符识别与非法形态原样保留。
 *
 * 识别为占位符需同时满足：`{{` 与 `}}` 成对、中间内容匹配变量名正则、中间不含花括号。
 * `\{\{` / `\}\}` 是唯一转义写法，只在遇到这个四字符序列时替换，不影响普通 `\`。
 * 非法形态（`{{ 有空格 }}`、`{{}}`、`{{a{b}}`、未闭合）不进 segments 的 variable 分支，
 * 而是原样落入 text，因此渲染时天然保持不变。
 */
function parseSnippetTemplateSegments(content: string): {
  segments: SnippetTemplateSegment[];
  invalidPlaceholders: string[];
} {
  const segments: SnippetTemplateSegment[] = [];
  const invalidPlaceholders: string[] = [];
  let textBuffer = "";
  let index = 0;

  const flushText = () => {
    if (textBuffer.length > 0) {
      segments.push({ type: "text", text: textBuffer });
      textBuffer = "";
    }
  };

  while (index < content.length) {
    if (content.startsWith(ESCAPED_OPEN, index)) {
      textBuffer += "{{";
      index += ESCAPED_OPEN.length;
      continue;
    }
    if (content.startsWith(ESCAPED_CLOSE, index)) {
      textBuffer += "}}";
      index += ESCAPED_CLOSE.length;
      continue;
    }
    if (content.startsWith("{{", index)) {
      const closeIndex = content.indexOf("}}", index + 2);
      if (closeIndex !== -1) {
        const inner = content.slice(index + 2, closeIndex);
        if (VARIABLE_NAME_RE.test(inner)) {
          flushText();
          segments.push({ type: "variable", name: inner });
          index = closeIndex + 2;
          continue;
        }
        const raw = content.slice(index, closeIndex + 2);
        if (!invalidPlaceholders.includes(raw)) {
          invalidPlaceholders.push(raw);
        }
      } else {
        const raw = content.slice(index);
        if (!invalidPlaceholders.includes(raw)) {
          invalidPlaceholders.push(raw);
        }
      }
    }
    textBuffer += content[index];
    index += 1;
  }

  flushText();
  return { segments, invalidPlaceholders };
}

/** 按首次出现顺序去重的变量名列表（重复变量只出现一次）。 */
export function parseSnippetTemplate(content: string): string[] {
  const seen = new Set<string>();
  const variables: string[] = [];
  for (const segment of parseSnippetTemplateSegments(content).segments) {
    if (segment.type !== "variable" || seen.has(segment.name)) {
      continue;
    }
    seen.add(segment.name);
    variables.push(segment.name);
  }
  return variables;
}

/** 供设置页行内提示使用的非法占位符清单（去重、按出现顺序）。 */
export function parseInvalidSnippetPlaceholders(content: string): string[] {
  return parseSnippetTemplateSegments(content).invalidPlaceholders;
}

/**
 * 渲染模板：变量值替换**所有**出现位置（全局替换，非首次）。
 *
 * 只替换前 `PROMPT_SNIPPET_MAX_VARIABLES` 个变量；其余保留 `{{name}}` 字面量。
 * 变量值不做 Markdown 转义、不做 mention 解析——用户填的 `@somefile.ts` 必须是纯文本，
 * 否则会被 Composer 当成文件引用（见 PRD §3.3 与用例 E8）。
 */
export function renderSnippetTemplate(
  content: string,
  values: Readonly<Record<string, string>>,
): string {
  const { segments } = parseSnippetTemplateSegments(content);
  const substitutable = new Set(
    parseSnippetTemplate(content).slice(0, PROMPT_SNIPPET_MAX_VARIABLES),
  );
  let result = "";
  for (const segment of segments) {
    if (segment.type === "text") {
      result += segment.text;
      continue;
    }
    const value = substitutable.has(segment.name) ? values[segment.name] : undefined;
    result += value === undefined ? `{{${segment.name}}}` : value;
  }
  return result;
}

// ============================================================================
// 用户片段
// ============================================================================

export const promptSnippetSchema = z.object({
  snippetId: z.string().min(1),
  workspaceKey: z.string().min(1),
  name: z.string().min(1),
  category: z.string(),
  content: z.string().min(1),
  kind: promptSnippetKindSchema,
  useCount: z.number().int().nonnegative(),
  lastUsedAt: z.number().int().nonnegative().nullable(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});
export type PromptSnippet = z.infer<typeof promptSnippetSchema>;

export type PromptSnippetValidationError =
  | "nameRequired"
  | "nameTooLong"
  | "categoryTooLong"
  | "contentRequired"
  | "contentTooLong";

/** 保存前的字段校验；返回 null 表示通过。UI 与 Service 共用同一判定。 */
export function resolvePromptSnippetValidationError(input: {
  name: string;
  category: string;
  content: string;
}): PromptSnippetValidationError | null {
  const name = input.name.trim();
  if (!name) {
    return "nameRequired";
  }
  if (Array.from(name).length > PROMPT_SNIPPET_NAME_MAX_LENGTH) {
    return "nameTooLong";
  }
  if (Array.from(input.category.trim()).length > PROMPT_SNIPPET_CATEGORY_MAX_LENGTH) {
    return "categoryTooLong";
  }
  const content = input.content.trim();
  if (!content) {
    return "contentRequired";
  }
  if (Array.from(content).length > PROMPT_SNIPPET_CONTENT_MAX_LENGTH) {
    return "contentTooLong";
  }
  return null;
}

/** 同名去重键：忽略大小写与首尾空白。 */
export function normalizePromptSnippetNameKey(name: string): string {
  return name.trim().toLowerCase();
}

// ============================================================================
// 内置库
// ============================================================================

const localizedTextSchema = z.record(z.string(), z.string());

export const promptSnippetBuiltinEntrySchema = z
  .object({
    /** 稳定身份，形如 `builtin:discipline:no-hands`；发布后不得修改。 */
    id: z.string().min(1),
    group: promptSnippetGroupSchema,
    kind: promptSnippetKindSchema,
    title: localizedTextSchema,
    content: localizedTextSchema,
    requiresMcp: z.array(z.string()),
    localOnly: z.boolean(),
    frameworks: z.array(promptSnippetFrameworkSchema).optional(),
  })
  .strict();
export type PromptSnippetBuiltinEntry = z.infer<typeof promptSnippetBuiltinEntrySchema>;

export const promptSnippetBuiltinLibrarySchema = z
  .object({
    version: z.literal(1),
    entries: z.array(promptSnippetBuiltinEntrySchema),
  })
  .strict();
export type PromptSnippetBuiltinLibrary = z.infer<typeof promptSnippetBuiltinLibrarySchema>;

/** 内置库校验：`discipline` 组必须是 `suffix`（产品规则，不是内容约定）。 */
export function findBuiltinLibraryViolation(library: PromptSnippetBuiltinLibrary): string | null {
  const seenIds = new Set<string>();
  for (const entry of library.entries) {
    if (seenIds.has(entry.id)) {
      return `duplicate entry id: ${entry.id}`;
    }
    seenIds.add(entry.id);
    if (entry.group === "discipline" && entry.kind !== "suffix") {
      return `discipline entry must be suffix: ${entry.id}`;
    }
    if (entry.group === "framework" && (entry.frameworks ?? []).length === 0) {
      return `framework entry must declare frameworks: ${entry.id}`;
    }
  }
  return null;
}

/**
 * 内置条目双语取值的回退：精确语言 → 同语言前缀 → `en-US` → 首个可用值。
 * 复用 `plugin-display-name.ts` 的 resolveLocalizedText 语义，避免两套回退规则。
 */
export function resolveSnippetLocalizedText(
  locale: string,
  text: Readonly<Record<string, string>>,
): string {
  const exact = text[locale];
  if (exact) {
    return exact;
  }
  const language = locale.split("-")[0];
  if (language) {
    const prefixed = Object.entries(text).find(([key]) => key.split("-")[0] === language);
    if (prefixed?.[1]) {
      return prefixed[1];
    }
  }
  const fallback = text["en-US"] ?? Object.values(text)[0];
  return fallback ?? "";
}

// ============================================================================
// 排序（§3.5 唯一算法）
// ============================================================================

export interface PromptSnippetSortable {
  id: string;
  name: string;
  useCount: number;
  lastUsedAt: number | null;
}

/**
 * 同一分组内的唯一排序：使用次数降序 → 最近使用降序（NULL 视为 0）→ 名称升序 → id 升序。
 * id 是最终稳定键，保证同分条目的渲染顺序确定（避免虚拟列表在重排时抖动）。
 */
export function comparePromptSnippetsForDisplay(
  left: PromptSnippetSortable,
  right: PromptSnippetSortable,
  locale: string,
): number {
  if (left.useCount !== right.useCount) {
    return right.useCount - left.useCount;
  }
  const leftUsedAt = left.lastUsedAt ?? 0;
  const rightUsedAt = right.lastUsedAt ?? 0;
  if (leftUsedAt !== rightUsedAt) {
    return rightUsedAt - leftUsedAt;
  }
  const byName = left.name.localeCompare(right.name, locale);
  if (byName !== 0) {
    return byName;
  }
  return left.id.localeCompare(right.id, locale);
}

// ============================================================================
// 内置条目 → 排序投影
// ============================================================================

/**
 * 内置条目的使用计数落在独立表，条目本身来自插件（只读）。
 * 这里把两者投影成排序/渲染共用的形状，UI 不需要知道计数从哪来。
 */
export interface PromptSnippetBuiltinUsage {
  useCount: number;
  lastUsedAt: number | null;
}

export function projectBuiltinSnippetForDisplay(params: {
  entry: PromptSnippetBuiltinEntry;
  usage: PromptSnippetBuiltinUsage | undefined;
  locale: string;
}): PromptSnippetSortable & { entry: PromptSnippetBuiltinEntry; title: string; content: string } {
  const usage = params.usage;
  return {
    id: params.entry.id,
    name: resolveSnippetLocalizedText(params.locale, params.entry.title),
    useCount: usage?.useCount ?? 0,
    lastUsedAt: usage?.lastUsedAt ?? null,
    entry: params.entry,
    title: resolveSnippetLocalizedText(params.locale, params.entry.title),
    content: resolveSnippetLocalizedText(params.locale, params.entry.content),
  };
}
