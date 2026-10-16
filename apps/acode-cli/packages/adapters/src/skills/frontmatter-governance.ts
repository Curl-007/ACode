// ============================================================
// Skill Frontmatter Governance Parser（specs/skill-frontmatter-governance.md）
// ============================================================
// 从 SKILL.md frontmatter 解析治理键（R1）：实参级工具规则（R2/R3 fail-closed）、
// paths 声明（R5，归一在 ./path-triggers.ts）、双向门（R6）、shell/argument-hint/
// arguments/effort（R7/R8）。产物挂 SkillMetadata.governance；解析失败只产生
// warning 诊断，不阻断技能加载（技能本体可加载，规则面宁紧勿松）。
// 语法调查依据（还原工程，只读复核）：规则串 `Tool(content)` 调用形与转义括号
// （beautified chunk-v4cg890f.js `jue`/`Un`）、逗号/空格分裂尊重括号深度（`Ku`）、
// 布尔词集与 shell 闭集（chunk-z9xtzw2s.js `_re`/`Shr`）、effort 闭集+整数
// （chunk-wcbzsyex.js `PB`/`pl`）、占位符不可解析即丢弃授权（chunk-9h4eq2mz.js
// :142955-143010）。实现为自撰，不搬文本。

import type {
  SkillDiagnostic,
  SkillEffort,
  SkillFrontmatterGovernance,
  SkillShellPreference,
  SkillToolRule,
} from "@acode/contracts";
import { collectFrontmatterEntries, declaresFrontmatterKey } from "./frontmatter-entries.js";
import { parseScalar } from "./frontmatter-text.js";
import { parsePathTriggerDeclarations } from "./path-triggers.js";

/**
 * 文档化键全集（R10）：治理键 + 登记键 + 既有五键。声明这些键的技能保持
 * safeToAutoLoad=true；插件组件键（mcpServers/agents/themes 等 manifest 面）与
 * 真正未知键仍按保守策略标 false。定义自 index.ts 外迁（legacy 行数 ratchet）。
 */
export const SAFE_FRONTMATTER_KEYS = new Set([
  // 既有五键
  "name",
  "description",
  "when_to_use",
  "license",
  "metadata",
  // 治理键（本批解析，R1）
  "allowed-tools",
  "disallowed-tools",
  "disallowedTools",
  "paths",
  "disable-model-invocation",
  "user-invocable",
  "shell",
  "argument-hint",
  "arguments",
  "effort",
  // 登记键（语义留待后续批次，R1；出现时不误标 unknown）
  "hooks",
  "context",
  "agent",
  "background",
  "model",
  "version",
  "fallback",
  "compatibility",
  "tags",
  "title",
  "author",
  "homepage",
  "repository",
  "keywords",
  "displayName",
  "created_by",
  "improved_by",
  "experimental",
]);

/** 技能目录占位符三种拼写（R2）：ACode 本名 + 既有兼容位 + 新收短拼写。 */
const SKILL_DIR_PLACEHOLDER = /\$\{(?:ACODE_SKILL_DIR|CLAUDE_SKILL_DIR|SKILL_DIR)\}/g;
/** 替换后仍残留任何 `${…}` → 不可解析占位符（R2/R3 fail-closed）。 */
const UNRESOLVED_PLACEHOLDER = /\$\{[^}]*\}/;
const SHELL_CLOSED_SET: readonly SkillShellPreference[] = ["bash", "powershell"];
const EFFORT_CLOSED_SET = ["low", "medium", "high", "xhigh", "max"] as const;
const EFFORT_ALIASES: Record<string, string> = { med: "medium" };
const TRUTHY_WORDS = new Set(["true", "yes", "on", "1"]);
const FALSY_WORDS = new Set(["false", "no", "off", "0"]);
const MAX_MESSAGE_LENGTH = 120;

export interface SkillGovernanceParseInput {
  /** frontmatter 原文（`---` 围栏之间的文本）；无 frontmatter 时为 null。 */
  frontmatter: string | null;
  /** parseFlatYaml 的平铺值（块标量已折叠；缩进列表项不在其中，由本模块扫描原文）。 */
  values: Record<string, string>;
  /** SKILL.md 所在目录（占位符替换值来源）。 */
  skillDirectory: string;
  skillName: string;
  path: string;
  /** warning 诊断直接压入调用方数组（R3：痕迹在 diagnostics，不在产物）。 */
  diagnostics: SkillDiagnostic[];
}

export function parseSkillFrontmatterGovernance(
  input: SkillGovernanceParseInput,
): SkillFrontmatterGovernance | undefined {
  const governance: SkillFrontmatterGovernance = {};

  const allowed = parseToolRuleList(input, "allowed-tools", "allow");
  if (allowed) governance.allowedTools = allowed;
  // `disallowedTools` 是 `disallowed-tools` 的规范化别名（参考 schema 同构）。
  const disallowed =
    parseToolRuleList(input, "disallowed-tools", "deny") ??
    parseToolRuleList(input, "disallowedTools", "deny");
  if (disallowed) governance.disallowedTools = disallowed;

  if (declaresKey(input, "paths")) {
    const pathTriggers = parsePathTriggerDeclarations(collectEntries(input, "paths"), input);
    if (pathTriggers) governance.pathTriggers = pathTriggers;
  }

  // R6：只在偏离缺省时落字段（缺省 disable-model-invocation=false / user-invocable=true）。
  if (parseBooleanWord(input, "disable-model-invocation") === true) {
    governance.disableModelInvocation = true;
  }
  if (parseBooleanWord(input, "user-invocable") === false) {
    governance.userInvocable = false;
  }

  const shell = parseShell(input);
  if (shell) governance.shell = shell;

  const argumentHint = parseScalar(input.values["argument-hint"]);
  if (argumentHint !== undefined && argumentHint.length > 0) {
    governance.argumentHint = argumentHint;
  }
  const argumentNames = collectEntries(input, "arguments").filter(
    (name) => name.length > 0 && !/^\d+$/.test(name),
  );
  if (argumentNames.length > 0) governance.argumentNames = argumentNames;

  const effort = parseEffort(input);
  if (effort !== undefined) governance.effort = effort;

  return Object.keys(governance).length > 0 ? governance : undefined;
}

// -----------------------------------------------
// 工具规则（R2/R3）
// -----------------------------------------------

type ToolRuleSide = "allow" | "deny";

function parseToolRuleList(
  input: SkillGovernanceParseInput,
  key: string,
  side: ToolRuleSide,
): SkillToolRule[] | undefined {
  if (!declaresKey(input, key)) return undefined;
  const entries = collectEntries(input, key);
  if (entries.length === 0) return undefined;
  const directory = normalizeDirectory(input.skillDirectory);
  const rules: SkillToolRule[] = [];
  for (const rawEntry of entries) {
    const entry = rawEntry.replace(SKILL_DIR_PLACEHOLDER, () => directory);
    if (UNRESOLVED_PLACEHOLDER.test(entry)) {
      // R3：不可解析占位符——allow 丢弃（不授予）；deny 降级工具级（不放行）。
      const downgraded = handleRuleFailure(
        input,
        side,
        key,
        rawEntry,
        "unresolved placeholder",
        extractToolNameHint(rawEntry),
      );
      if (downgraded) rules.push(downgraded);
      continue;
    }
    const parsed = parseToolRuleEntry(entry);
    if (parsed.kind === "rule") {
      rules.push(parsed.rule);
      continue;
    }
    const downgraded = handleRuleFailure(
      input,
      side,
      key,
      rawEntry,
      parsed.reason,
      parsed.toolNameHint,
    );
    if (downgraded) rules.push(downgraded);
  }
  return rules.length > 0 ? rules : undefined;
}

/**
 * R3 fail-closed：allow 侧畸形=丢弃（少授予即安全方向）；deny 侧畸形不得静默丢弃
 * （丢 deny=放宽作者的安全意图），能提取工具名就降级为**工具级 deny**并返回该规则。
 */
function handleRuleFailure(
  input: SkillGovernanceParseInput,
  side: ToolRuleSide,
  key: string,
  entry: string,
  reason: string,
  toolNameHint?: string,
): SkillToolRule | undefined {
  const downgraded =
    side === "deny" && toolNameHint !== undefined ? { toolName: toolNameHint } : undefined;
  input.diagnostics.push({
    code: "skill_tool_rule_dropped",
    severity: "warning",
    message: downgraded
      ? `Skill ${input.skillName}: malformed ${key} entry "${truncate(entry)}" (${reason}); ` +
        `downgraded to a tool-level deny on ${downgraded.toolName} (fail-closed)`
      : `Skill ${input.skillName}: malformed ${key} entry "${truncate(entry)}" (${reason}); ` +
        (side === "deny"
          ? "entry ignored — the declared restriction is NOT enforced"
          : "entry grants nothing"),
    path: input.path,
    skillName: input.skillName,
  });
  return downgraded;
}

type ToolRuleParseResult =
  | { kind: "rule"; rule: SkillToolRule }
  | { kind: "malformed"; reason: string; toolNameHint?: string };

function parseToolRuleEntry(entry: string): ToolRuleParseResult {
  const open = findUnescaped(entry, "(", 0);
  const close = findLastUnescaped(entry, ")");
  if (open === -1 && close === -1) {
    // 裸工具名（无括号）。分裂已保证不带顶层空白；原文透传，匹配语义属权限面。
    return entry.length > 0
      ? { kind: "rule", rule: { toolName: entry } }
      : { kind: "malformed", reason: "empty entry" };
  }
  const toolName = open === -1 ? "" : entry.slice(0, open);
  // 调用形判据（参考 jue 同构）：首未转义 `(` + 串尾未转义 `)` + 名字段无括号。
  if (open === -1 || close <= open || close !== entry.length - 1 || /[()]/.test(toolName)) {
    return {
      kind: "malformed",
      reason: "unbalanced or misplaced parentheses",
      toolNameHint: extractToolNameHint(entry),
    };
  }
  const rawContent = entry.slice(open + 1, close);
  // 空 content 或 `*` = 工具级规则（参考 Un 同构）。
  if (rawContent === "" || rawContent === "*") return { kind: "rule", rule: { toolName } };
  return { kind: "rule", rule: { toolName, ruleContent: unescapeParens(rawContent) } };
}

/** 畸形条目的工具名救援（R3 deny 降级）：首个未转义 `(` 前、或首个空白前的名字 token。 */
function extractToolNameHint(entry: string): string | undefined {
  const stop = firstIndexOfAny(entry);
  const token = stop === -1 ? entry : entry.slice(0, stop);
  // 工具名形态：普通名或 mcp__server(__tool) 前缀形；不合法则不救援（宁缺勿错禁）。
  return /^[A-Za-z_][A-Za-z0-9_]*(?:__[A-Za-z0-9_.-]+)*$/.test(token) ? token : undefined;
}

function firstIndexOfAny(entry: string): number {
  const open = findUnescaped(entry, "(", 0);
  const space = /\s/.exec(entry)?.index ?? -1;
  if (open === -1) return space;
  if (space === -1) return open;
  return Math.min(open, space);
}

function findUnescaped(value: string, char: string, from: number): number {
  for (let index = from; index < value.length; index++) {
    if (value[index] === char && isUnescapedAt(value, index)) return index;
  }
  return -1;
}

function findLastUnescaped(value: string, char: string): number {
  for (let index = value.length - 1; index >= 0; index--) {
    if (value[index] === char && isUnescapedAt(value, index)) return index;
  }
  return -1;
}

function isUnescapedAt(value: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor--) backslashes++;
  return backslashes % 2 === 0;
}

function unescapeParens(value: string): string {
  return value.replaceAll("\\(", "(").replaceAll("\\)", ")");
}

function normalizeDirectory(directory: string): string {
  // 规则内容统一正斜杠（gitignore 风格 matcher 的输入形态；Windows 反斜杠归一）。
  return directory.split("\\").join("/").replace(/\/+$/, "");
}

function truncate(value: string): string {
  return value.length > MAX_MESSAGE_LENGTH ? `${value.slice(0, MAX_MESSAGE_LENGTH)}…` : value;
}

// -----------------------------------------------
// 条目收集在 ./frontmatter-entries.ts（内联串/流式列表/YAML 块列表归一，R2/R10）
// -----------------------------------------------

function declaresKey(input: SkillGovernanceParseInput, key: string): boolean {
  return declaresFrontmatterKey(input.frontmatter, input.values, key);
}

function collectEntries(input: SkillGovernanceParseInput, key: string): string[] {
  return collectFrontmatterEntries(input.frontmatter, input.values, key);
}

// -----------------------------------------------
// 标量键（R6/R7/R8）
// -----------------------------------------------

function parseBooleanWord(input: SkillGovernanceParseInput, key: string): boolean | undefined {
  const raw = parseScalar(input.values[key]);
  if (raw === undefined) return undefined;
  const normalized = raw.toLowerCase();
  if (TRUTHY_WORDS.has(normalized)) return true;
  if (FALSY_WORDS.has(normalized)) return false;
  input.diagnostics.push({
    code: "skill_frontmatter_value_invalid",
    severity: "warning",
    message:
      `Skill ${input.skillName}: ${key} value "${truncate(raw)}" is not a boolean word ` +
      "(true/yes/on/1, false/no/off/0); using the default",
    path: input.path,
    skillName: input.skillName,
  });
  return undefined;
}

function parseShell(input: SkillGovernanceParseInput): SkillShellPreference | undefined {
  const raw = parseScalar(input.values.shell);
  if (raw === undefined) return undefined;
  const normalized = raw.toLowerCase() as SkillShellPreference;
  if (SHELL_CLOSED_SET.includes(normalized)) return normalized;
  input.diagnostics.push({
    code: "skill_frontmatter_value_invalid",
    severity: "warning",
    message:
      `Skill ${input.skillName}: shell "${truncate(raw)}" is not recognized ` +
      `(valid: ${SHELL_CLOSED_SET.join(", ")}); falling back to bash`,
    path: input.path,
    skillName: input.skillName,
  });
  return undefined;
}

function parseEffort(input: SkillGovernanceParseInput): SkillEffort | undefined {
  const raw = parseScalar(input.values.effort);
  if (raw === undefined) return undefined;
  const normalized = raw.toLowerCase();
  const aliased = EFFORT_ALIASES[normalized] ?? normalized;
  if ((EFFORT_CLOSED_SET as readonly string[]).includes(aliased)) {
    return aliased as SkillEffort;
  }
  const asNumber = Number(normalized);
  if (normalized.length > 0 && Number.isInteger(asNumber)) return asNumber;
  input.diagnostics.push({
    code: "skill_frontmatter_value_invalid",
    severity: "warning",
    message:
      `Skill ${input.skillName}: effort "${truncate(raw)}" is invalid ` +
      `(valid: ${EFFORT_CLOSED_SET.join(", ")} or an integer); ignoring it`,
    path: input.path,
    skillName: input.skillName,
  });
  return undefined;
}
