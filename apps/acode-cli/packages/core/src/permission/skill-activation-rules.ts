// ============================================================
// 技能激活期规则的匹配面（specs/skill-frontmatter-governance.md R4 消费接线）
// ============================================================
// PermissionService 消费 SkillActivationScope 的判定 helper：deny 并入会话级 deny
// 位次（模式分支之前收口），allow 并入会话级 allow 位次（allowedTools 同档，受
// policy floor / 硬阻断 / plan 结构性压制——frontmatter 授权永不穿透地板）。
//
// 匹配语义裁决（spec R4 接线注记清单，逐项落定，2026-10-15 接线波）：
// 1. ruleContent 匹配沿用权限面既有语义（`:*` 前缀 / `*` 通配 / 全等，
//    matchesRuleContent 同构）——不引入参考面的 Bash 子命令切分，与项目规则域
//    一致，不造第二套匹配器。
// 2. `Skill(名 *)` / `Agent(名)` 的 subject 提取**暂不收**（ruleSubjects 未收
//    skill/args/subagent 输入键，项目规则域同款缺口）：带 content 的此类规则
//    不匹配——allow 侧不授予（fail-closed），deny 侧不禁（已知缺口，随
//    ruleSubjects 扩展统一收编，不在技能面单开分支）。裸工具名规则照常生效。
// 3. `mcp__server` 服务器级前缀覆盖：**落**——规则名是 context 工具名的
//    `mcp__server__tool` 前缀段即 scope 命中（deny/allow 双侧，与参考语义一致）。
// 4. `toolName: "*"` 全工具通配：deny 侧**落**（作者的全域禁意图必须生效，
//    R3 fail-closed 哲学）；allow 侧**不匹配**（frontmatter 自声明的全工具授予
//    过宽，参考 allowManagedPermissionRulesOnly 压制同构，fail-closed）。
// 5. Windows 路径分隔符归一：**落**——ruleContent 含 `/` 时，subject 额外按
//    反斜杠→正斜杠归一再匹配一次（声明侧解析期已正斜杠化，subject 侧补归一；
//    仅对含 `/` 的规则生效，避免命令文本反斜杠被误归一）。

import type { SkillActivationScope, SkillToolRule } from "@acode/contracts";
import { wildcardToRegExp } from "./rule-matching.js";

/** 与 PermissionService.ruleSubjects 同源的输入键序（第一个命中键即 subject）。 */
const SUBJECT_INPUT_KEYS = ["command", "url", "file_path", "path", "pattern", "patch_text"];

export function matchesSkillActivationDeny(input: {
  scope: SkillActivationScope | undefined;
  toolName: string;
  toolInput: unknown;
}): boolean {
  const rules = input.scope?.deny;
  if (!rules || rules.length === 0) return false;
  return rules.some((rule) => matchSkillRule(rule, input.toolName, input.toolInput, "deny"));
}

export function matchesSkillActivationAllow(input: {
  scope: SkillActivationScope | undefined;
  toolName: string;
  toolInput: unknown;
}): boolean {
  const rules = input.scope?.allow;
  if (!rules || rules.length === 0) return false;
  return rules.some((rule) => matchSkillRule(rule, input.toolName, input.toolInput, "allow"));
}

function matchSkillRule(
  rule: SkillToolRule,
  toolName: string,
  toolInput: unknown,
  side: "deny" | "allow",
): boolean {
  if (!matchesSkillRuleScope(rule.toolName, toolName, side)) return false;
  if (!rule.ruleContent) return true;
  const subjects = ruleSubjectsFromInput(toolInput);
  if (subjects.length === 0) return false;
  return subjects.some((subject) => matchesSkillRuleContent(subject, rule.ruleContent!));
}

/** scope 判定：精确名 / Write←Edit 别名（权限面同款）/ mcp__ 服务器前缀 / deny 侧 "*"。 */
function matchesSkillRuleScope(
  ruleToolName: string,
  contextToolName: string,
  side: "deny" | "allow",
): boolean {
  if (ruleToolName === "*") return side === "deny";
  if (ruleToolName === contextToolName) return true;
  if (contextToolName === "Write" && ruleToolName === "Edit") return true;
  return (
    ruleToolName.startsWith("mcp__") &&
    !ruleToolName.includes("__", 5) &&
    contextToolName.startsWith(`${ruleToolName}__`)
  );
}

function ruleSubjectsFromInput(input: unknown): string[] {
  if (typeof input === "string") return [input];
  if (!input || typeof input !== "object") return [];
  const record = input as Record<string, unknown>;
  for (const key of SUBJECT_INPUT_KEYS) {
    const value = record[key];
    if (typeof value === "string") return [value];
  }
  return [];
}

/** matchesRuleContent 同构 + 裁决 5 的 Windows 归一重试。 */
function matchesSkillRuleContent(subject: string, ruleContent: string): boolean {
  if (matchRuleContentOnce(subject, ruleContent)) return true;
  if (ruleContent.includes("/") && subject.includes("\\")) {
    return matchRuleContentOnce(subject.replaceAll("\\", "/"), ruleContent);
  }
  return false;
}

function matchRuleContentOnce(subject: string, ruleContent: string): boolean {
  if (ruleContent.endsWith(":*")) {
    const prefix = ruleContent.slice(0, -2);
    return (
      subject === prefix || subject.startsWith(`${prefix} `) || subject.startsWith(`${prefix}\t`)
    );
  }
  if (ruleContent.includes("*")) {
    return wildcardToRegExp(ruleContent).test(subject);
  }
  return subject === ruleContent;
}
