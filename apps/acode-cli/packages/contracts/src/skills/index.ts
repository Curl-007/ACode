// ============================================================
// Skill Contracts - reusable local instruction packs
// ============================================================

import type { ExecutionContext, TraceContext } from "../tracing/tracer.js";
import type { SkillFrontmatterGovernance } from "./frontmatter.js";

// 治理键类型叶子（specs/skill-frontmatter-governance.md）；根 barrel 经本行自动携带。
export * from "./frontmatter.js";

export type SkillScope = "project" | "user" | "system" | "admin";

export type SkillSource = "agents" | "acode" | "bundled" | "plugin" | "remote";

export type SkillDiagnosticSeverity = "warning" | "error";

export type SkillDiagnosticCode =
  | "skill_root_not_found"
  | "skill_scan_failed"
  | "skill_read_failed"
  | "skill_missing_frontmatter"
  | "skill_invalid_frontmatter"
  | "skill_missing_name"
  | "skill_invalid_name"
  | "skill_missing_description"
  | "skill_description_too_long"
  | "skill_unknown_frontmatter"
  | "skill_duplicate_name"
  | "skill_too_large"
  | "skill_not_found"
  // 治理键诊断（specs/skill-frontmatter-governance.md R3/R5-R8）：条目级 fail-closed
  // 丢弃/降级与字段值非法，均 warning，不阻断加载。
  | "skill_tool_rule_dropped"
  | "skill_frontmatter_value_invalid";

export interface SkillRoot {
  path: string;
  scope: SkillScope;
  source: SkillSource;
  priority: number;
  /** 所属 plugin 的完整 id；仅 plugin root 可用。 */
  pluginId?: string;
}

export interface SkillPolicy {
  allowImplicitInvocation?: boolean;
}

export interface SkillMetadata {
  name: string;
  description: string;
  whenToUse?: string;
  pluginName?: string;
  /** 所属 plugin 的完整 id；非 plugin skill 不设置。 */
  pluginId?: string;
  qualifiedName?: string;
  path: string;
  directory: string;
  rootPath: string;
  scope: SkillScope;
  source: SkillSource;
  safeToAutoLoad: boolean;
  frontmatterKeys: string[];
  policy?: SkillPolicy;
  /**
   * frontmatter 治理键解析产物（specs/skill-frontmatter-governance.md R1）。
   * 缺席=未声明任何治理键；解析失败条目按 R3 fail-closed 处理后不在产物中留痕，
   * 痕迹在 SkillLoadOutcome.diagnostics。
   */
  governance?: SkillFrontmatterGovernance;
}

/** Skill tool result 中允许跨边界传播的最小 metadata；不包含正文或 description。 */
export interface SkillTelemetryMetadata {
  qualifiedName?: string;
  pluginId?: string;
  source?: SkillSource;
}

export interface SkillDiagnostic {
  code: SkillDiagnosticCode;
  severity: SkillDiagnosticSeverity;
  message: string;
  path?: string;
  skillName?: string;
}

export interface SkillLoadOutcome {
  skills: SkillMetadata[];
  diagnostics: SkillDiagnostic[];
  totalDiscovered: number;
}

export interface SkillContent {
  metadata: SkillMetadata;
  content: string;
  baseDirectory: string;
  bytesRead: number;
  sizeBytes: number;
  truncated: boolean;
}

export interface SkillDiscoverRequest {
  workingDirectory: string;
  roots?: SkillRoot[];
  trace?: TraceContext;
}

export interface SkillLoadRequest {
  name: string;
  workingDirectory: string;
  roots?: SkillRoot[];
  maxBytes?: number;
  trace?: TraceContext;
}

export interface SkillOperationOptions {
  signal?: AbortSignal;
  context?: ExecutionContext;
}

export interface SkillPort {
  discoverSkills(
    request: SkillDiscoverRequest,
    options?: SkillOperationOptions,
  ): Promise<SkillLoadOutcome>;
  loadSkill(request: SkillLoadRequest, options?: SkillOperationOptions): Promise<SkillContent>;
}

export interface SkillConfig {
  enabled: boolean;
  includeInstructions: boolean;
  metadataBudget: number;
  roots: string[];
}
