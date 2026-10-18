import { ACODE_OFFICIAL_PLUGIN_MARKETPLACE } from "@acode/contracts";
import { BIGMODEL_SKILLS_OFFICIAL_PLUGIN_DEFINITIONS } from "./official-plugin-bigmodel-skills.js";
import {
  DOCUMENT_STYLE_OFFICIAL_PLUGIN_DEFINITIONS,
  OFFICIAL_ACODE_GUIDE_REQUIRED_SEED_PATHS,
  OFFICIAL_BROWSER_USE_REQUIRED_SEED_PATHS,
  OFFICIAL_CUA_REQUIRED_SEED_PATHS,
  OFFICIAL_NODE_REPL_HOST_REQUIRED_SEED_PATHS,
  OFFICIAL_PLUGIN_ICON,
  ZAI_AUTHOR,
  type OfficialPluginDefinition,
} from "./official-plugin-shared.js";

// 类型与共享常量因架构 ratchet 400 行上限下沉到 official-plugin-shared.ts
// （specs/agent-teams-derived-config.md R8）；对外导出面经 re-export 保持不变，
// 既有消费方无需改 import 路径。
export type {
  OfficialPluginDefinition,
  OfficialPluginListingSeed,
} from "./official-plugin-shared.js";
export { OFFICIAL_BROWSER_USE_REQUIRED_SEED_PATHS };

const OFFICIAL_BROWSER_USE_PLUGIN_NAME = "browser-use";
export const OFFICIAL_BROWSER_USE_PLUGIN_ID = `${OFFICIAL_BROWSER_USE_PLUGIN_NAME}@${ACODE_OFFICIAL_PLUGIN_MARKETPLACE}`;
/**
 * node_repl 宿主。它不是面向用户的插件：没有 skill、没有 listing、不进市场，唯一职责是
 * 携带 `dist/mcp/server.js` 这个 Browser Use 与 Computer Use 共用的运行时产物。
 *
 * 为什么它需要成为一个 seed 单元：宿主产物过去长在 browser-use 包里，于是
 * resolveBuiltInNodeReplMcpServers 只能在 browser-use 的 rootPath 下找它 —— browser-use
 * 包缺失时，即便 Computer Use 自己启用也拿不到宿主。做成独立 seed 单元后，两个插件
 * 各自只贡献自己的领域资产，谁启用都能拿到同一个宿主。
 */
export const OFFICIAL_NODE_REPL_HOST_PLUGIN_NAME = "node-repl-host";
export const OFFICIAL_NODE_REPL_HOST_PLUGIN_ID = `${OFFICIAL_NODE_REPL_HOST_PLUGIN_NAME}@${ACODE_OFFICIAL_PLUGIN_MARKETPLACE}`;
const OFFICIAL_CUA_PLUGIN_NAME = "computer-use";
export const OFFICIAL_CUA_PLUGIN_ID = `${OFFICIAL_CUA_PLUGIN_NAME}@${ACODE_OFFICIAL_PLUGIN_MARKETPLACE}`;

export const OFFICIAL_PLUGIN_DEFINITIONS: readonly OfficialPluginDefinition[] = [
  {
    // 无 listing：宿主不进市场、不对用户露出。它必须始终可用，因为 node_repl 的注册门禁
    // 是「Browser Use 或 Computer Use 任一启用」，宿主自己不参与那个判断。
    //
    // 这里的 defaultEnabled 不违反「仅限内容型插件」那条约定（见下方 computer-use 的说明）：
    // 约定要防的是「首启即注入整套工具集并拉起 Helper」，而 seed 宿主两件都不做——工具是否
    // 进模型工具池由两个能力插件的启停决定，Helper 由 SDK 首次调用时才拉起。
    defaultEnabled: true,
    name: OFFICIAL_NODE_REPL_HOST_PLUGIN_NAME,
    requiredSeedPaths: OFFICIAL_NODE_REPL_HOST_REQUIRED_SEED_PATHS,
    rootCandidates: [
      "packages/node-repl-host",
      "../node-repl-host",
      "../../node-repl-host",
      "../../../node-repl-host",
    ],
    version: "0.6.0",
  },
  {
    listing: {
      author: ZAI_AUTHOR,
      category: "developer-tools",
      displayName: "Android Emulator",
      displayName_i18n: { "zh-CN": "Android 模拟器" },
      icon: OFFICIAL_PLUGIN_ICON,
      description_i18n: {
        "zh-CN": "提供 Android 开发工作流与模拟器自动化能力。",
      },
    },
    name: "android-emulator",
    rootCandidates: [
      "packages/android-emulator-plugin",
      "../android-emulator-plugin",
      "../../android-emulator-plugin",
      "../../../android-emulator-plugin",
    ],
    version: "0.1.0",
  },
  {
    // manifest 只声明 browser-use skill；宿主 node_repl MCP 独立注入，package 另外携带其 server/client
    // runtime 资产。默认启用仅控制「何时/如何用内置浏览器」的 skill 与 browser bridge。
    defaultEnabled: true,
    hostMcpServerNames: ["node_repl"],
    listing: {
      author: ZAI_AUTHOR,
      category: "productivity",
      displayName: "Browser Use",
      displayName_i18n: { "zh-CN": "浏览器操作" },
      icon: OFFICIAL_PLUGIN_ICON,
      description_i18n: {
        "zh-CN": "操作 ACode 内置浏览器，检查网页并验证交互。",
      },
    },
    name: OFFICIAL_BROWSER_USE_PLUGIN_NAME,
    requiredSeedPaths: OFFICIAL_BROWSER_USE_REQUIRED_SEED_PATHS,
    rootCandidates: [
      "packages/browser-use-plugin",
      "../browser-use-plugin",
      "../../browser-use-plugin",
      "../../../browser-use-plugin",
    ],
    // 插件 package/manifest 升版时遗漏官方 seed 版本，会继续加载旧缓存目录。
    // package、manifest、definition 三处版本应保持一致，避免发布内容和安装版本再次分叉。
    version: "0.5.1",
  },
  ...DOCUMENT_STYLE_OFFICIAL_PLUGIN_DEFINITIONS,
  {
    // 沿用原聚合文档插件的官方搜图能力，仅拆出独立开关；认证仍由官方 MCP adapter 注入。
    defaultEnabled: true,
    listing: {
      author: ZAI_AUTHOR,
      category: "productivity",
      displayName: "Image Search",
      displayName_i18n: { "zh-CN": "搜图" },
      description_i18n: { "zh-CN": "搜图 MCP 服务，用于查找插图与参考配图。" },
    },
    name: "image-search",
    requiredSeedPaths: [".mcp.json"],
    rootCandidates: [
      "packages/image-search-plugin",
      "../image-search-plugin",
      "../../image-search-plugin",
      "../../../image-search-plugin",
    ],
    version: "0.1.1",
  },
  {
    listing: {
      author: ZAI_AUTHOR,
      category: "developer-tools",
      displayName: "iOS Simulator",
      displayName_i18n: { "zh-CN": "iOS 模拟器" },
      icon: OFFICIAL_PLUGIN_ICON,
      description_i18n: {
        "zh-CN": "提供 iOS 开发工作流与模拟器自动化能力。",
      },
    },
    name: "ios-simulator",
    rootCandidates: [
      "packages/ios-simulator-plugin",
      "../ios-simulator-plugin",
      "../../ios-simulator-plugin",
      "../../../ios-simulator-plugin",
    ],
    version: "0.1.0",
  },
  {
    listing: {
      author: ZAI_AUTHOR,
      category: "utilities",
      displayName: "Restore Legacy Sessions",
      displayName_i18n: { "zh-CN": "恢复旧版会话" },
      icon: OFFICIAL_PLUGIN_ICON,
      description_i18n: {
        "zh-CN": "将旧版会话恢复为 ACode 任务与会话记录。",
      },
    },
    name: "restore-legacy-sessions",
    rootCandidates: [
      "packages/restore-legacy-sessions-plugin",
      "../restore-legacy-sessions-plugin",
      "../../restore-legacy-sessions-plugin",
      "../../../restore-legacy-sessions-plugin",
    ],
    version: "0.1.0",
  },
  {
    defaultEnabled: true,
    name: "plugin-creator",
    version: "0.1.1",
    listing: {
      author: ZAI_AUTHOR,
      category: "utilities",
      displayName: "Plugin Creator",
      // 创建器使用客户端自带图标，不再借用 skill-creator 的远端图片。
      displayName_i18n: { "zh-CN": "插件创建器" },
      description_i18n: {
        "zh-CN": "开发、校验 ACode 插件，完成本地 dev 市场安装、试用与更新。",
      },
    },
    rootCandidates: [
      "packages/plugin-creator-plugin",
      "../plugin-creator-plugin",
      "../../plugin-creator-plugin",
      "../../../plugin-creator-plugin",
    ],
    requiredSeedPaths: [
      "skills/plugin-creator/SKILL.md",
      "skills/plugin-creator/scripts/create-basic-plugin.mjs",
      "skills/plugin-creator/scripts/marketplace-files.mjs",
      "skills/plugin-creator/scripts/upsert-dev-marketplace.mjs",
      "skills/plugin-creator/scripts/scaffold-files.mjs",
      "skills/plugin-creator/scripts/validate-plugin.mjs",
      "skills/plugin-creator/references/plugin-json-spec.md",
      "skills/plugin-creator/references/installing-and-updating.md",
    ],
  },
  {
    defaultEnabled: true,
    listing: {
      author: ZAI_AUTHOR,
      category: "utilities",
      displayName: "Skill Creator",
      displayName_i18n: { "zh-CN": "技能创建器" },
      icon: OFFICIAL_PLUGIN_ICON,
      description_i18n: { "zh-CN": "创建、编辑和验证可复用的 ACode 技能。" },
    },
    name: "skill-creator",
    rootCandidates: [
      "packages/skill-creator-plugin",
      "../skill-creator-plugin",
      "../../skill-creator-plugin",
      "../../../skill-creator-plugin",
    ],
    version: "0.1.0",
  },
  {
    // 纯内容型插件（只有 commands + skills，无 MCP / 无系统依赖），默认启用，
    // 让用户/agent 开箱即用地拿到 ACode 配置指南、自诊断技能与 dynamic workflow 编写指南。
    defaultEnabled: true,
    listing: {
      author: ZAI_AUTHOR,
      category: "utilities",
      displayName: "ACode Guide",
      displayName_i18n: { "zh-CN": "ACode 使用指南" },
      icon: OFFICIAL_PLUGIN_ICON,
      description_i18n: {
        "zh-CN": "提供 ACode 配置指南与插件、技能、MCP、命令和钩子诊断。",
      },
      examplePrompts: [
        "How do I configure MCP servers in ACode?",
        "Diagnose my current ACode setup",
      ],
      examplePrompts_i18n: {
        "zh-CN": ["ACode 里怎么配置 MCP 服务器？", "帮我诊断当前的 ACode 配置"],
      },
    },
    name: "acode-guide",
    requiredSeedPaths: OFFICIAL_ACODE_GUIDE_REQUIRED_SEED_PATHS,
    rootCandidates: [
      "packages/acode-guide-plugin",
      "../acode-guide-plugin",
      "../../acode-guide-plugin",
      "../../../acode-guide-plugin",
    ],
    version: "0.3.0",
  },
  {
    // 产品决策：电脑控制回退为默认关闭，需用户在设置页显式开启。
    // 因此这里不声明 defaultEnabled——computer-use 携带 MCP server 与系统 Helper 依赖，
    // 默认开启意味着每个新用户首启即注入整套工具集并拉起 Helper。
    // 「defaultEnabled 仅限内容型插件」的旧约定随之恢复完整。
    // 判定式是 enabledPlugins[id] ?? defaultEnabled：曾在设置页手动开过的用户已落盘
    // 显式 true，不受本次默认值变更影响。改回默认开启时，需同步
    // packages/shared/src/plugin-marketplaces.ts 的名单（bootstrap 单测机械对照两者）、
    // isACodeCuaInternalFeatureEnabled（打包层默认 true）与输入框入口 hidden 默认值的联动语义。
    name: "computer-use",
    hostMcpServerNames: ["node_repl"],
    // 用户露出名统一为「Computer Use / 电脑控制」。包名与 producer 仓库仍保持 acode-cua，
    // 以兼容原生 Helper identity；EN 描述基线走 manifest
    // description，这里只放 zh-CN 覆盖；resolveLocalizedText 在 en-US 时回退到 manifest。
    listing: {
      author: ZAI_AUTHOR,
      category: "productivity",
      displayName: "Computer Use",
      displayName_i18n: { "zh-CN": "电脑控制" },
      description_i18n: {
        "zh-CN": "自动化桌面应用：智能体驱动鼠标、键盘与界面元素，代你完成实际任务。",
      },
      // 插件更名为 computer-use 后，CDN 图标仍发布在 acode-cua 目录；沿用资源路径避免 404。
      icon: OFFICIAL_PLUGIN_ICON,
    },
    rootCandidates: [
      "packages/acode-cua-plugin",
      "../acode-cua-plugin",
      "../../acode-cua-plugin",
      "../../../acode-cua-plugin",
    ],
    requiredSeedPaths: OFFICIAL_CUA_REQUIRED_SEED_PATHS,
    // 当前 CUA 为不可用占位包，无需复制 native runtime；避免把本地旧依赖继续带入缓存。
    runtimeTopLevelPaths: [],
    // 这里的 version 追踪上游 acode-cua runtime 版本，使插件 UI 展示、缓存路径、
    // marketplace 条目都对齐；具体版本由原子 producer bump 工作流维护。
    version: "0.6.3",
  },
  {
    // 默认启用是 2026-10-15 产品拍板（specs/agent-teams-derived-config.md R1），
    // 与源分支的 opt-in 形态不同：开箱即得 14 个 agent_teams_* 工具、/team 命令与
    // agent-teams:member subagent。这是对「defaultEnabled 仅限内容型插件」旧约定的
    // 显式例外（本插件携带 stdio MCP server，会话按需拉起子进程）；例外理由与
    // 四份发布暂存清单的硬验收登记在 spec R1/R2。改默认值需同步
    // packages/shared/src/plugin-marketplaces.ts 的镜像名单（parity 单测机械对照两者）。
    //
    // MCP server 通过 .mcp.json 声明为 stdio 子进程，状态通知走 acode-plugin-state: 前缀
    // （宿主未接线时被优雅忽略，不影响工具运行）。dist/mcp/server.js 是 esbuild 产物
    // （gitignore，不入库），发布链四份清单负责构建暂存；seed 完整性门把它钉为必需资产。
    defaultEnabled: true,
    listing: {
      author: ZAI_AUTHOR,
      category: "productivity",
      displayName: "AgentTeams",
      displayName_i18n: { "zh-CN": "智能体团队" },
      icon: OFFICIAL_PLUGIN_ICON,
      description_i18n: {
        "zh-CN":
          "AgentTeams 多智能体协作：当前会话成为队长，组建可续跑的成员团队，把目标拆成依赖任务 DAG，经成员邮箱直连协作，由指令式调度推进，并提供只读团队面板。",
      },
      examplePrompts: [
        "Use AgentTeams to review the last two commits and fix findings",
        "组建一个团队并行实现这三个模块",
      ],
      examplePrompts_i18n: {
        "zh-CN": ["用 AgentTeams 审查最近两个提交并修复问题", "组建一个团队并行实现这三个模块"],
      },
    },
    name: "agent-teams",
    rootCandidates: [
      "packages/agent-teams-plugin",
      "../agent-teams-plugin",
      "../../agent-teams-plugin",
      "../../../agent-teams-plugin",
    ],
    requiredSeedPaths: [
      ".mcp.json",
      "agents/member.md",
      "commands/team.md",
      "dist/mcp/server.js",
      "skills/agent-teams/SKILL.md",
    ],
    version: "0.1.0",
  },
  // 智谱 BigModel 技能集 8 个分类内容包（specs/bigmodel-skills-marketplace-plugins.md）：
  // 表驱动生成，默认关闭，用户在市场按需启用。
  ...BIGMODEL_SKILLS_OFFICIAL_PLUGIN_DEFINITIONS,
];

// 在 official plugin 定义里标了 defaultEnabled: true 的, 拼成 `<name>@<marketplace>` 形式,
// 透传给 adapter 让它在用户没显式配置时默认开启 (内容型 plugin 才适用)。
// 注意: 任何解析 plugin 的入口 (CLI 子命令 resolveACodePlugins、应用启动 resolveStartupPlugins)
// 都必须把这个集合传给 discoverNodePluginsSync, 否则 defaultEnabled 不生效。
export const DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS: ReadonlySet<string> = new Set(
  OFFICIAL_PLUGIN_DEFINITIONS.filter((definition) => definition.defaultEnabled).map(
    (definition) => `${definition.name}@${ACODE_OFFICIAL_PLUGIN_MARKETPLACE}`,
  ),
);

export function resolveOfficialPluginHostMcpServerNames(pluginId: string): string[] {
  const definition = OFFICIAL_PLUGIN_DEFINITIONS.find(
    (candidate) => `${candidate.name}@${ACODE_OFFICIAL_PLUGIN_MARKETPLACE}` === pluginId,
  );
  return definition?.hostMcpServerNames ? [...definition.hostMcpServerNames] : [];
}

/**
 * 官方插件由 host CLI 注入的 MCP（如 browser-use 的 `node_repl`）server name 不带 `plugin:` 前缀，
 * 资源管理器归属插件时需要反查所属官方插件名。
 */
export function resolveOfficialPluginNameByHostMcpServerName(
  serverName: string,
): string | undefined {
  return OFFICIAL_PLUGIN_DEFINITIONS.find((definition) =>
    definition.hostMcpServerNames?.includes(serverName),
  )?.name;
}
