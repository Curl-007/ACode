import type { SkillSummary } from "@acode/shared";
import type { CreateTaskOptions } from "@/app-shell/types.js";
import { buildSkillMentionMarkdown } from "@/mentions/mentionMarkdown.js";

const PLUGIN_CREATOR_SKILL = "plugin-creator";
const PLUGIN_CREATOR_ID = "plugin-creator@acode-plugins-official";

function buildPluginCreatorPrefill(skills: readonly SkillSummary[]): CreateTaskOptions {
  // 创建入口只信任官方来源，不让用户目录或同名市场技能截获这项产品动作。
  const skill = skills.find(
    (entry) =>
      entry.name === PLUGIN_CREATOR_SKILL &&
      entry.pluginId === PLUGIN_CREATOR_ID &&
      entry.scope === "plugin" &&
      entry.enabled &&
      entry.path.trim(),
  );
  // scope 再窄化一次：SkillScope 已含 "bundled"，而 Composer mention 数据面不接收 bundled
  // （用户裁决 2：bundled 不进 $ 面板）；上方 find 谓词已保证 scope === "plugin"，此处
  // 同时完成类型收窄（spec I2 穷举消费点同步）。
  if (!skill || skill.scope !== "plugin") throw new Error("plugin_creator_unavailable");
  const markdown = buildSkillMentionMarkdown(skill.name, skill.path);
  return {
    initialPrompt: `${markdown} `,
    initialPromptMention: {
      id: `skill:${skill.id}`,
      category: "skills",
      label: skill.name,
      value: skill.name,
      markdown,
      description: skill.description,
      data: { path: skill.path, scope: skill.scope },
    },
  };
}

export async function loadPluginCreatorPrefill(
  loadSkills: () => Promise<{ skills: SkillSummary[] }>,
  isCurrent: () => boolean,
): Promise<CreateTaskOptions | null> {
  const result = await loadSkills();
  return isCurrent() ? buildPluginCreatorPrefill(result.skills) : null;
}
