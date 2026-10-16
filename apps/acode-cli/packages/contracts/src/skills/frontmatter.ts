// ============================================================
// Skill Frontmatter Governance - 技能声明式治理键的类型面
// ============================================================
// specs/skill-frontmatter-governance.md R1-R8：技能 SKILL.md frontmatter 的治理键
// （allowed-tools/disallowed-tools/paths/双向门/shell/argument-hint/arguments/effort）
// 解析产物的共享类型。解析器在 adapters/src/skills/frontmatter-governance.ts，
// 激活期作用域与路径触发判定在 core/src/agent/skill-activation-scope.ts 与
// skill-path-triggers.ts；本文件只放跨包共享的形状（contracts 是两侧唯一公共依赖）。

import type { PermissionRuleValue } from "../interfaces/permission.port.js";

/**
 * 实参级工具规则。与权限面 `PermissionRuleValue` 同形：`Tool(content)` 调用形解析出
 * toolName+ruleContent，裸工具名只有 toolName。ruleContent 为占位符替换后的 verbatim
 * 原文（Bash 命令前缀 / Read·Edit 路径 glob / `Skill(名 *)` 的目标串 / mcp__ 前缀），
 * 匹配语义由权限面决定（specs/skill-frontmatter-governance.md R2/R4）。
 */
export type SkillToolRule = PermissionRuleValue;

/** `shell` 键闭集（R7）：`!` 块执行面的 shell 选择；缺席=默认 bash（跨平台一致）。 */
export type SkillShellPreference = "bash" | "powershell";

/** `effort` 键的档位闭集（R8）；整数形态直接以 number 承载。 */
export type SkillEffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

export type SkillEffort = SkillEffortLevel | number;

/**
 * 技能 frontmatter 治理产物（R1）。挂在 `SkillMetadata.governance`；只有实际声明且
 * 解析成功的键才落字段——缺席=未声明=缺省语义（双向门只在偏离缺省时落值，R6）。
 * 解析失败的条目按 R3 fail-closed 处理后**不在产物中留痕**，痕迹在加载 diagnostics。
 */
export interface SkillFrontmatterGovernance {
  /** `allowed-tools`：激活期允许规则（占位符已替换为技能目录，正斜杠归一）。 */
  allowedTools?: SkillToolRule[];
  /** `disallowed-tools`（含 `disallowedTools` 别名）：激活期禁止规则，deny 侧。 */
  disallowedTools?: SkillToolRule[];
  /** `paths`：路径触发式渐进披露的 glob 声明（已归一：剥尾 `/**`、花括号已展开，R5）。 */
  pathTriggers?: string[];
  /** `disable-model-invocation: true`（仅用户可敲）；只在 true 时落字段（R6）。 */
  disableModelInvocation?: boolean;
  /** `user-invocable: false`（仅模型可调）；只在 false 时落字段（R6）。 */
  userInvocable?: boolean;
  /** `shell`：`!` 块 shell 选择；非法值已被 warn 回落为缺席（R7）。 */
  shell?: SkillShellPreference;
  /** `argument-hint`：用户 slash 面的占位提示（消费面接线中，R8）。 */
  argumentHint?: string;
  /** `arguments`：具名参数表（已过滤空白与纯数字项，R8）。 */
  argumentNames?: string[];
  /** `effort`：技能级思考档（ACode 暂无消费面，登记，R8）。 */
  effort?: SkillEffort;
}

/**
 * 一个会话当前的技能激活期作用域（R4）：provider 可见历史中处于已加载态的技能，
 * 其 governance 工具规则的并集。由 core 的纯函数按历史重算、store 缓存；权限面
 * 经 `snapshot` 查询（消费接线见 spec R4 注记）。空作用域=无任何激活技能规则。
 */
export interface SkillActivationScope {
  /** 激活技能的 allowed-tools 并集（toolName+ruleContent 去重）。只读快照形态。 */
  allow: readonly SkillToolRule[];
  /** 激活技能的 disallowed-tools 并集（同上）。 */
  deny: readonly SkillToolRule[];
  /** 作用域内的技能名（解析后的目录身份 name，按首次加载序）。 */
  skills: readonly string[];
}
