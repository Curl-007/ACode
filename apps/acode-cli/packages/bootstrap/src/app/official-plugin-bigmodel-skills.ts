import { OFFICIAL_PLUGIN_ICON, type OfficialPluginDefinition } from "./official-plugin-shared.js";

/**
 * 智谱 BigModel 技能集：8 个纯内容官方插件（specs/bigmodel-skills-marketplace-plugins.md）。
 *
 * 来源是智谱 BigModel 技能市场的离线快照（125 技能，Apache-2.0 × 82 / MIT × 43，
 * 逐技能 LICENSE/UPSTREAM/MODIFICATIONS 原样保留在包内）。按平台自有分类拆包，
 * plugin.json `tier: "default_false"` 默认关闭：用户在市场按需启用，启用哪类才把
 * 哪类技能挂进模型技能列表（definition 不写 defaultEnabled，R5 与 tier parity 一致）。
 *
 * 本文件独立于 official-plugin-definitions.ts：后者受 400 行 ratchet 约束，8 个条目
 * 必须由紧凑表生成（R4）。description / description_i18n 单源 = 包内 plugin.json
 * （specs/skill-seeding-registration.md R3），listing seed 不重复描述文案。
 */

/** 合集策展方署名；单技能作者保留在各技能目录与包 README 清单中（R2）。 */
const BIGMODEL_SKILLS_AUTHOR = {
  name: "Zhipu BigModel Skill Market",
  url: "https://open.bigmodel.cn/managed-agents/skills",
} as const;

const BIGMODEL_SKILLS_VERSION = "0.1.0";

/**
 * [分类后缀, 商店 category, EN 显示名, zh-CN 显示名, seed 锚点技能目录]。
 * 锚点 = 该分类安装量最高技能的 SKILL.md（源 index.json installCount），
 * 与两份发布 staging 清单的 requiredSeedPaths 逐字一致（packaging-parity 断言 D 看守）。
 */
const BIGMODEL_SKILLS_PLUGIN_TABLE = [
  [
    "dev",
    "developer-tools",
    "BigModel Skills · Development",
    "智谱技能集 · 研发",
    "optimize-web-performance-cn",
  ],
  [
    "data",
    "productivity",
    "BigModel Skills · Data Analysis",
    "智谱技能集 · 数据分析",
    "finance-news-analysis",
  ],
  [
    "office",
    "productivity",
    "BigModel Skills · Office & Docs",
    "智谱技能集 · 文档办公",
    "verify-public-claims-cn",
  ],
  [
    "management",
    "productivity",
    "BigModel Skills · Management",
    "智谱技能集 · 企业管理",
    "plan-project-delivery-cn",
  ],
  [
    "sales",
    "productivity",
    "BigModel Skills · Sales & Service",
    "智谱技能集 · 销售客服",
    "discover-customer-opportunities-cn",
  ],
  [
    "content",
    "productivity",
    "BigModel Skills · Content Creation",
    "智谱技能集 · 内容创作",
    "video-clipper",
  ],
  [
    "product",
    "productivity",
    "BigModel Skills · Product Ops",
    "智谱技能集 · 产品运营",
    "marketing-psychology",
  ],
  [
    "ops",
    "developer-tools",
    "BigModel Skills · SRE & Ops",
    "智谱技能集 · 运维",
    "engineer-service-reliability-cn",
  ],
] as const;

export const BIGMODEL_SKILLS_OFFICIAL_PLUGIN_DEFINITIONS: readonly OfficialPluginDefinition[] =
  BIGMODEL_SKILLS_PLUGIN_TABLE.map(
    ([suffix, category, displayName, displayNameZh, anchorSkill]) => ({
      listing: {
        author: BIGMODEL_SKILLS_AUTHOR,
        category,
        displayName,
        displayName_i18n: { "zh-CN": displayNameZh },
        icon: OFFICIAL_PLUGIN_ICON,
      },
      name: `bigmodel-skills-${suffix}`,
      requiredSeedPaths: [`skills/${anchorSkill}/SKILL.md`],
      rootCandidates: [
        `packages/bigmodel-skills-${suffix}-plugin`,
        `../bigmodel-skills-${suffix}-plugin`,
        `../../bigmodel-skills-${suffix}-plugin`,
        `../../../bigmodel-skills-${suffix}-plugin`,
      ],
      version: BIGMODEL_SKILLS_VERSION,
    }),
  );
