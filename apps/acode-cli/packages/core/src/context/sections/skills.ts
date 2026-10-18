// ============================================================
// Skills Section Builder
// ============================================================

import type { SkillLoadOutcome, SkillMetadata } from "@acode/contracts";
import type { ContextSection } from "../types.js";
import { estimateTokens } from "../utils.js";
// paths 触发激活集（R5 消费接线）：过滤面只读查询，登记面在 executor 后置点。
import { listPathActivatedSkills } from "../../agent/skill-path-activation.js";

const DEFAULT_SKILL_METADATA_BUDGET = 20_000;
const MAX_DESCRIPTION_CHARS = 250;

interface SkillsSectionOptions {
  outcome: SkillLoadOutcome;
  metadataBudget?: number;
  /**
   * 会话身份（R5 路径触发过滤用）。缺席（子代理 builder / 测试 / 旧调用方）=
   * 不过滤 pathTriggers 技能，保持既有全量清单行为（零回归面）。
   */
  sessionId?: string;
}

export function buildSkillsSection(options: SkillsSectionOptions): ContextSection | null {
  // 双向门·模型侧（specs/skill-frontmatter-governance.md R6）：disable-model-invocation
  // 的技能保留给「用户显式敲 /skill <name>」路径（handler 直载不经清单），模型清单
  // 不可发现即不会自选。user-invocable:false 走用户面隐藏（接线项），清单侧不过滤。
  // paths 触发式渐进披露（R5 消费接线）：声明 paths 的技能在本会话触碰匹配文件前
  // 不进清单；命中后 executor 登记激活集并经 system-reminder 告知模型（call-runner）。
  // sessionId 缺席（子代理 builder / 测试 / 旧调用方）= 不过滤，保持既有全量清单。
  const pathActivated = options.sessionId ? listPathActivatedSkills(options.sessionId) : undefined;
  const skills = options.outcome.skills.filter(
    (skill) =>
      skill.governance?.disableModelInvocation !== true &&
      (pathActivated === undefined ||
        (skill.governance?.pathTriggers?.length ?? 0) === 0 ||
        pathActivated.has(skill.name)),
  );
  if (skills.length === 0) {
    return null;
  }

  const content = buildSkillsContent(
    skills,
    options.metadataBudget ?? DEFAULT_SKILL_METADATA_BUDGET,
  );

  return {
    name: "Skills",
    source: "skills",
    injectionTarget: "meta_user",
    cacheHint: "dynamic",
    chars: content.length,
    tokens: estimateTokens(content),
    content,
    preview: content.slice(0, 100),
  };
}

function buildSkillsContent(skills: SkillMetadata[], budget: number): string {
  const lines = [
    "The following skills are available for use with the Skill tool:",
    // skill:// 资产直读提示（specs/skill-uri-read.md，WI-13 共享桶申请②）：
    // 让模型知道技能目录内脚本/模板可以按相对路径沙箱化读取。
    "Assets of a listed skill can be read directly via skill://<name>/<relative-path> (bare skill://<name> reads its SKILL.md).",
    "",
  ];

  const sortedSkills = [...skills].sort((a, b) =>
    skillDisplayName(a).localeCompare(skillDisplayName(b)),
  );
  const skillLines = sortedSkills.map((skill) => formatSkillLine(skill, MAX_DESCRIPTION_CHARS));
  const full = [...lines, ...skillLines].join("\n");
  if (full.length <= budget) {
    return full;
  }

  const namesOnly = sortedSkills.map(
    (skill) => `- ${skillDisplayName(skill)}${bareAliasSuffix(skill)} (file: ${skill.path})`,
  );
  return [...lines, ...namesOnly].join("\n");
}

function formatSkillLine(skill: SkillMetadata, maxDescriptionChars: number): string {
  const description = skill.whenToUse
    ? `${skill.description} - ${skill.whenToUse}`
    : skill.description;
  const trimmed =
    description.length > maxDescriptionChars
      ? `${description.slice(0, maxDescriptionChars - 1)}...`
      : description;
  return `- ${skillDisplayName(skill)}: ${trimmed}${bareAliasSuffix(skill)} (file: ${skill.path})`;
}

function skillDisplayName(skill: SkillMetadata): string {
  return skill.qualifiedName ?? skill.name;
}

function bareAliasSuffix(skill: SkillMetadata): string {
  return skill.qualifiedName && skill.qualifiedName !== skill.name
    ? ` (also loadable as ${skill.name})`
    : "";
}
