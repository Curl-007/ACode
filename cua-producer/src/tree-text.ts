/**
 * 树文本渲染与预算/截断（specs/windows-helper-producer.md §11.4）。
 *
 * 格式 = ACode 原创，兼容既有渲染层解析面（本仓 cuaResultState.ts 的 `^\s*\[(\d+)\]\s+(.+)$`
 * 行判据、readElementName 的 " = " 分隔与 " (…)" 后缀剥离约定）：
 *
 *   app: <identity-token> pid=<pid> "<display name>"
 *   window: [<window_id>] "<title>"
 *   [0] window <name>
 *     [2] pane <name>
 *       [5] edit Document = <value 截断至 200 code units>… (editable, focusable)
 *
 * 纪律：role 是 UIA ControlType 的稳定英文名（封闭映射在 native 侧完成，本模块只消费）；
 * value 单行化 + 截断 ≤200 code units 加 "…"（隐私 + 预算）；窗口标题 ≤512 截断（用户
 * 内容只进 wire 结果，绝不进日志）；截断注记固定形态 `[tree truncated: showing first
 * <N> of <M> elements]`（N/M 是数值事实，非用户内容——零插值红线只限用户内容/凭据）。
 *
 * 纯 TS、零依赖（§10.11 模块规则①同律）。
 */
import type { UiaElementFact } from "./driver-contract.js";

/** §11.4 钉死：value 截断 ≤200 code units 加省略号。 */
export const TREE_VALUE_MAX_CODE_UNITS = 200;
/** §11.2/§11.4：窗口标题/展示名 ≤512 code units 截断。 */
export const TREE_TITLE_MAX_CODE_UNITS = 512;

/** 单行化（换行/回车 → 空格；树行格式的行判据依赖单行性）。 */
export function singleLine(text: string): string {
  return text.replace(/[\r\n]+/g, " ");
}

/** 截断至 max code units，超出加 "…"（§11.4）。 */
export function truncateCodeUnits(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

/**
 * 头部 identity-token（§11.4）：AUMID 优先、否则 exe basename，经 `[^A-Za-z0-9.-]` → `-`
 * 净化。唯一目的 = 渲染层文本回退正则 `[A-Za-z0-9.-]+` 的 best-effort 兼容——身份权威
 * 永远是 structuredContent.app 与 _meta；净化 token 只作展示，绝不用于任何解析/派发判定。
 */
export function identityToken(aumid: string | null, exePath: string): string {
  const base = aumid ?? exeBasename(exePath);
  return base.replace(/[^A-Za-z0-9.-]/g, "-");
}

/** canonical exe 全路径 → basename（身份字段派生的展示名，§11.2 list_apps name 规则）。 */
export function exeBasename(exePath: string): string {
  const normalized = exePath.replace(/[\\/]+$/, "");
  const parts = normalized.split(/[\\/]/);
  return parts[parts.length - 1] ?? normalized;
}

export interface TreeHeaderFacts {
  aumid: string | null;
  exePath: string;
  pid: number;
  displayName: string | null;
  windowId: number;
  windowTitle: string;
}

/** 元素行（§11.4）：深度×两空格缩进 + `[index] role name[ = value][ (patterns 注记)]`。 */
export function elementLine(element: UiaElementFact): string {
  const indent = "  ".repeat(Math.max(0, element.depth));
  const name = singleLine(truncateCodeUnits(element.name, TREE_VALUE_MAX_CODE_UNITS));
  let line = `${indent}[${element.index}] ${element.role}`;
  if (name.length > 0) line += ` ${name}`;
  if (element.value !== null) {
    const value = truncateCodeUnits(singleLine(element.value), TREE_VALUE_MAX_CODE_UNITS);
    line += ` = ${value}`;
  }
  if (element.patterns.length > 0) {
    line += ` (${element.patterns.join(", ")})`;
  }
  return line;
}

export interface TreeTextFacts {
  header: TreeHeaderFacts;
  elements: UiaElementFact[];
  truncated: boolean;
  totalElements: number;
}

/**
 * 完整树文本（头部两行 + 元素行 + 截断注记）。elements 与文本行同集合截断的不变量由
 * native 预算感知遍历保证（§11.4：截断外的 index 不进文本也不进注册表可动作集）；
 * 本模块只做确定性渲染。
 */
export function renderTreeText(facts: TreeTextFacts): string {
  const { header } = facts;
  const display = truncateCodeUnits(
    singleLine(header.displayName ?? exeBasename(header.exePath)),
    TREE_TITLE_MAX_CODE_UNITS,
  );
  const title = truncateCodeUnits(singleLine(header.windowTitle), TREE_TITLE_MAX_CODE_UNITS);
  const lines = [
    // identityToken：AUMID 优先、否则 exe basename（§11.4 净化 token 只作展示）。
    `app: ${identityToken(header.aumid, header.exePath)} pid=${header.pid} "${display}"`,
    `window: [${header.windowId}] "${title}"`,
  ];
  for (const element of facts.elements) lines.push(elementLine(element));
  if (facts.truncated) {
    lines.push(
      `[tree truncated: showing first ${facts.elements.length} of ${facts.totalElements} elements]`,
    );
  }
  return lines.join("\n");
}
