// ============================================================
// 内建输出风格注册表（specs/built-in-output-styles.md）
// ============================================================
//
// 机制（identity 开头行切换 / "# Output Style" 段 / 每请求 reminder）在
// OutputStylePromptConfig 消费链上已完整存在；本文件是内建风格文本与
// 「名称 → config」解析的唯一所有者。产品选择面（协议/UI/CLI flag/插件
// manifest）结转后续 owner，接入时一律走 resolveOutputStyleSelection，
// 不得另建第二个解析点（spec R2）。

import type { OutputStylePromptConfig } from "./types.js";

export interface BuiltInOutputStyle {
  readonly name: string;
  readonly prompt: string;
  readonly keepCodingInstructions: boolean;
}

/**
 * explanatory：教学式。答案/代码先行，解释随后不替代；洞察分量与新颖度成比例。
 * concise：精简式。直接作答、去填充词；承重信息（风险/代价/必须 follow 的步骤）不许省。
 * 两者都只描述**沟通形态**、keepCodingInstructions: true——风格不替换核心编码行为文本
 * （spec R4）。文本自撰英文（prompt-language-policy.md R1/R7）。
 */
const EXPLANATORY_STYLE: BuiltInOutputStyle = {
  name: "explanatory",
  prompt:
    "After completing each piece of work, add brief educational insight that connects the specific change to the general pattern: why this approach works, what trade-off it carries, and when a different pattern would fit better. The working code or the direct answer comes first; explanation follows it, never replaces it. Calibrate insight to novelty — one or two sentences for routine work, deeper explanation only where the territory is genuinely subtle. Do not explain what the user clearly already knows, and never pad a simple answer to look thorough.",
  keepCodingInstructions: true,
};

const CONCISE_STYLE: BuiltInOutputStyle = {
  name: "concise",
  prompt:
    "Minimize words without losing substance. Answer directly: no preamble, no restating the question, no closing summary of what you just said. Use the shortest complete sentence that carries the answer, and prefer code over prose when code is the answer. Omit courtesies and filler. Brevity must never drop load-bearing information — risks, trade-offs, and steps the user must follow stay in, even when that makes the reply longer.",
  keepCodingInstructions: true,
};

export const BUILT_IN_OUTPUT_STYLES: readonly BuiltInOutputStyle[] = [
  EXPLANATORY_STYLE,
  CONCISE_STYLE,
];

const BUILT_IN_STYLE_BY_NAME: ReadonlyMap<string, BuiltInOutputStyle> = new Map(
  BUILT_IN_OUTPUT_STYLES.map((style) => [style.name, style]),
);

/** 名称判定：trim + 小写后查内建注册表（spec R2 大小写不敏感）。 */
export function isBuiltInOutputStyleName(name: string): boolean {
  return BUILT_IN_STYLE_BY_NAME.has(name.trim().toLowerCase());
}

/**
 * 按名解析（spec R2 唯一解析点）：
 * - 字符串 → 内建注册表查找（大小写不敏感）；未命中返回 undefined，由调用方决定
 *   「warn + 不改写现有风格」（updateConfig 入口），本函数不做副作用。
 * - 对象 → 原样透传（自定义风格既有通道）。
 * - undefined → undefined（调用方以 `"outputStyle" in patch` 区分「清除」与「未提供」）。
 */
export function resolveOutputStyleSelection(
  selection: string | OutputStylePromptConfig | undefined,
): OutputStylePromptConfig | undefined {
  if (selection === undefined) return undefined;
  if (typeof selection !== "string") return selection;
  return BUILT_IN_STYLE_BY_NAME.get(selection.trim().toLowerCase());
}
