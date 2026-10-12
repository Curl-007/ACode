// 对话内可视化（::visualize）引用的解析与正文剥离。
//
// 三段式契约（apps/acode-cli/specs/gen-ui-visualize.md）里 renderer 只负责两端：
//   ① 正文：CLI 投影层把命中且已注册的引用翻成 artifactRow(html)，但正文文本原样保留
//      （含指令原文）——renderer 在 markdown 投影前把指令替换为等长空白（保持行结构），
//      卡片本体由 ConversationRowView 的 artifactRow 分支渲染；
//   ② 卡片：v4/VisualizationArtifactRow.tsx（本文件不感知）。
//
// 词法复用 assistantDirectiveParser：`::visualize{...}` 的定位、闭括号与引号状态机、
// 单/三冒号与智能引号容错与 ::acode-file-citation 完全同源；参数体是 JSON
// （`{"name":...,"mode":"wide"?}`），不用 key=value 语法，因此在这里单独解析。
import {
  extractAssistantDirectives,
  findAssistantDirectivePrefixStart,
  findMarkdownCodeRanges,
  findUnclosedAssistantDirectiveStart,
} from "@/lib/assistantDirectiveParser.js";

/** CLI 写入侧的 name 清洗规则镜像（visualizationNameSchema 的正则同源副本，UI 不引 zod）。 */
const VISUALIZATION_NAME_PATTERN = /^[a-z0-9-]+(\.[a-z0-9-]+)*$/u;

/** 与 CLI 投影层同源的词法容错：单/三冒号 + 智能引号（见 gen-ui-visualize.md「引用解析」）。 */
const VISUALIZE_DIRECTIVE_SYNTAX = {
  allowSingleColon: true,
  allowSmartQuotes: true,
  allowTripleColon: true,
} as const;

const VISUALIZE_DIRECTIVE_NAME = "visualize";

/** 每轮至多解析的引用条数（CLI 侧同一常量的 renderer 镜像，超出的指令按原文保留）。 */
const MAX_REFERENCES_PER_TURN = 8;

export type AssistantVisualizeMode = "wide";

export interface AssistantVisualizeReference {
  /** name：既是片段标识也是 conversationVisualizationRead 的读取键。 */
  name: string;
  /** wide = 全宽渲染；其他值在解析时即忽略（与 CLI 投影规则一致）。 */
  mode?: AssistantVisualizeMode;
  /** 指令在原文中的字符区间（含前后缀），剥离函数按它替换为空白。 */
  start: number;
  end: number;
  raw: string;
}

interface VisualizationDirectiveParameters {
  mode?: unknown;
  name?: unknown;
}

/**
 * 把智能引号归一成 ASCII 引号后再 JSON.parse。模型在 JSON 值里混排 “” 时，
 * 严格 JSON.parse 会整条拒收——降级语义应只针对真正的坏引用，不该被引号风格放大。
 */
function parseDirectiveJson(rawParameters: string): VisualizationDirectiveParameters | null {
  // 参数体是对象条目（`"name":...`），花括号已在词法层剥掉——这里补回外层 {} 再
  // 按严格 JSON 解析；智能引号先归一，避免值里混排 “” 导致整条拒收。
  const normalized = `{${rawParameters.replace(/[“”]/gu, '"').replace(/[‘’]/gu, "'")}}`;
  try {
    const parsed: unknown = JSON.parse(normalized);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as VisualizationDirectiveParameters;
  } catch {
    return null;
  }
}

/** 指令 raw 文本里参数 JSON 的取法：第一个 `{` 到词法匹配的闭 `}`（即 raw 末位）。 */
function extractRawParameters(raw: string): string | null {
  const openBraceIndex = raw.indexOf("{");
  if (openBraceIndex < 0 || !raw.endsWith("}")) return null;
  return raw.slice(openBraceIndex + 1, -1);
}

export function isVisualizationFragmentName(value: string): boolean {
  return value.length <= 80 && VISUALIZATION_NAME_PATTERN.test(value);
}

/**
 * 解析正文里的 ::visualize 引用。
 *
 * 只接受「JSON 可解析 + name 合法 + mode 最多是 "wide"」的指令；解析失败的指令
 * 保持原文可见（与 CLI「未命中不产 row、降级可见」同一语义——用户和模型都能看到
 * 坏引用本身）。代码块内的协议样例不参与解析（与 citation 词法的保护范围一致）。
 */
export function extractAssistantVisualizeReferences(
  content: string,
): AssistantVisualizeReference[] {
  if (!content.trim()) return [];
  const protectedRanges = findMarkdownCodeRanges(content);
  const references: AssistantVisualizeReference[] = [];
  for (const directive of extractAssistantDirectives(
    content,
    VISUALIZE_DIRECTIVE_NAME,
    VISUALIZE_DIRECTIVE_SYNTAX,
  )) {
    if (references.length >= MAX_REFERENCES_PER_TURN) break;
    if (
      directive.parameters !== null ||
      overlapsProtectedRange(directive.start, directive.end, protectedRanges)
    ) {
      // parameters 非 null 说明是 key=value 语法（不是 JSON），不是本协议的引用。
      continue;
    }
    const rawParameters = extractRawParameters(directive.raw);
    if (rawParameters === null) continue;
    const parsed = parseDirectiveJson(rawParameters);
    if (parsed === null || typeof parsed.name !== "string") continue;
    if (!isVisualizationFragmentName(parsed.name)) continue;
    references.push({
      name: parsed.name,
      ...(parsed.mode === "wide" ? { mode: "wide" as const } : {}),
      start: directive.start,
      end: directive.end,
      raw: directive.raw,
    });
  }
  return references;
}

function overlapsProtectedRange(
  start: number,
  end: number,
  ranges: readonly (readonly [number, number])[],
): boolean {
  return ranges.some(([rangeStart, rangeEnd]) => start < rangeEnd && end > rangeStart);
}

/**
 * 把已解析的引用指令替换为等长空白（换行原样保留）。
 *
 * 行结构必须保持：CLI 把 artifactRow 插在 assistantText 之后，正文里的指令位置
 * 决定卡片出现的段落边界——把换行也吞掉会合并相邻段落，卡片与文字的对应关系失真。
 */
export function stripAssistantVisualizeReferences(
  content: string,
  references: readonly AssistantVisualizeReference[],
): string {
  if (references.length === 0) return content;
  let result = "";
  let writeOffset = 0;
  for (const reference of references) {
    if (reference.start < writeOffset) continue;
    result += content.slice(writeOffset, reference.start);
    result += reference.raw.replace(/[^\n]/gu, " ");
    writeOffset = reference.end;
  }
  result += content.slice(writeOffset);
  return result;
}

export interface AssistantVisualizeProjection {
  visibleText: string;
}

/**
 * markdown 投影前的收口：完整引用剥为空白；流式尾部刚输出的半截指令先整体隐藏
 * （与 projectACodeFileCitations 的尾部语义同一模式，避免 JSON 打一半时闪现原始协议文本）。
 */
export function projectAssistantVisualizeReferences(
  content: string,
  options: { streaming: boolean },
): AssistantVisualizeProjection {
  if (!content) return { visibleText: content };
  let working = content;
  if (options.streaming) {
    const protectedRanges = findMarkdownCodeRanges(content);
    const unclosedStart = findUnclosedAssistantDirectiveStart(
      content,
      VISUALIZE_DIRECTIVE_NAME,
      protectedRanges,
      VISUALIZE_DIRECTIVE_SYNTAX,
    );
    if (unclosedStart !== null) {
      return { visibleText: content.slice(0, unclosedStart) };
    }
    const prefixStart = findAssistantDirectivePrefixStart(
      content,
      [VISUALIZE_DIRECTIVE_NAME],
      protectedRanges,
      {
        // 单冒号只是对模型笔误的读取容错；流式隐藏要求接近完整指令名，
        // 避免把普通 `:v...` 正文尾巴误当协议前缀吞掉。
        minimumSingleColonPrefixLength: `:${VISUALIZE_DIRECTIVE_NAME}`.length,
        singleColonDirectiveNames: [VISUALIZE_DIRECTIVE_NAME],
        tripleColonDirectiveNames: [VISUALIZE_DIRECTIVE_NAME],
      },
    );
    if (prefixStart !== null) {
      working = content.slice(0, prefixStart);
    }
  }
  const stripped = stripAssistantVisualizeReferences(
    working,
    extractAssistantVisualizeReferences(working),
  );
  return { visibleText: stripped };
}
