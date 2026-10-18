import type { ACodeProvider } from "@acode/shared";

type SkillSourceType = "glm" | "unknown";

function resolveSkillSourceType(skillPath: string): SkillSourceType {
  const normalized = skillPath.replaceAll("\\", "/").toLowerCase();
  if (normalized.includes("/.acode/skills/")) {
    return "glm";
  }
  if (normalized.includes("/.acode/cli/plugins/cache/")) {
    return "glm";
  }
  return "unknown";
}

const SKILL_ID_PROVIDER_RE = /^glm:/;

interface SkillSourceFilterOptions {
  /**
   * 是否放行 bundled（随 CLI 内容包分发的内置）技能。默认 false：bundled 路径既不在
   * `/.acode/skills/` 也不在 `/.acode/cli/plugins/cache/` 下，现路径启发式必拒；仅设置页
   * 显式传 true 放行。Composer 两个调用点（SlashCommandPlugin、skillsMentionProvider）
   * 保持默认不传——它们的数据源本就是 CLI catalog（已过滤 bundled），此处是结构性双保险：
   * 即使未来 catalog 过滤被误删，Composer 面板也不会因 settings 侧的放行而漏入 bundled
   * （specs/skills-bundled-visibility-and-official-cache-authority.md I4）。
   */
  includeBundled?: boolean;
}

function isAcodeSkill(
  skill: { id?: string; path: string; scope?: string },
  options?: SkillSourceFilterOptions,
): boolean {
  if (skill.scope === "bundled") {
    // bundled 必须显式放行：仅靠「不主动放行」不够——bundled 条目的 id 带glm: 前缀
    // （services buildSkillId），下方 id 前缀条件会把它误放行，路径启发式也拦不住。
    // 默认在此显式拒绝，Composer `$`/`/` 面板（用户裁决 2：bundled 不进引用面板）
    // 与设置页（includeBundled: true）各自走各自语义。
    return options?.includeBundled === true;
  }
  return (
    // plugin skill 的真实路径在 CLI plugin cache 下，不在 `.acode/skills`。
    // 服务层已用 scope 标记来源，前端过滤时要放行，否则 `/` 和 `$` 面板会漏掉插件技能。
    skill.scope === "plugin" ||
    (typeof skill.id === "string" && SKILL_ID_PROVIDER_RE.test(skill.id)) ||
    resolveSkillSourceType(skill.path) === "glm"
  );
}

export function filterSkillsForProvider<T extends { path: string; id?: string; scope?: string }>(
  skills: T[],
  _legacyProvider: ACodeProvider,
  options?: SkillSourceFilterOptions,
): T[] {
  return skills.filter((skill) => isAcodeSkill(skill, options));
}
