/**
 * 官方插件定义的共享构件：listing seed 类型、定义类型、作者/图标常量、各插件的
 * requiredSeedPaths 常量与文档类插件的表驱动生成段。
 *
 * 拆分原因（specs/agent-teams-derived-config.md R8）：official-plugin-definitions.ts
 * 受架构 ratchet 400 行上限约束（HEAD 394 行），新增 agent-teams 条目即超限；
 * 把稳定不动的类型与常量段下沉到本文件，定义文件保留插件条目本体。
 */

// 内置插件的商店信息 seed（原样写入官方 marketplace.json 的条目 raw，键名与 CDN 目录
// schema 一致：displayName_i18n / examplePrompts_i18n 等），解析复用 adapter 的
// parseEntryStoreListing。icon 指向官方 assets CDN；请求失败时 UI 会安全降级为默认图标。
export interface OfficialPluginListingSeed {
  displayName?: string;
  displayName_i18n?: Record<string, string>;
  description_i18n?: Record<string, string>;
  category?: string;
  author?: { name: string; url?: string };
  icon?: string;
  homepage?: string;
  privacyPolicy?: string;
  termsOfService?: string;
  heroImage?: string;
  examplePrompts?: string[];
  examplePrompts_i18n?: Record<string, string[]>;
}

export interface OfficialPluginDefinition {
  // 内容型 plugin (无 MCP server / 无系统依赖) 可以设为 true,
  // 这样用户首次 `/skill <name>` 就能用,不必先 `acode plugins enable`。
  // 默认 false 保持 ios-simulator / android-emulator 这类重负载 plugin 原来行为。
  defaultEnabled?: boolean;
  listing?: OfficialPluginListingSeed;
  /**
   * 由宿主为该官方插件提供、但不属于 plugin manifest 的 MCP server。
   * 仅用于产品归属和设置页状态展示；运行时仍保留宿主 identity。
   */
  hostMcpServerNames?: readonly string[];
  name: string;
  /** filesystem/SEA seed 缺少任一项时拒绝生成残缺的官方插件缓存。 */
  requiredSeedPaths?: readonly string[];
  rootCandidates: readonly string[];
  /** Extra top-level paths intentionally staged as plugin runtime assets. */
  runtimeTopLevelPaths?: readonly string[];
  version: string;
}

export const ZAI_AUTHOR = { name: "Z.ai", url: "https://z.ai" } as const;
// 审计版不连接官方 CDN；使用内嵌图标，保留本地插件定义。
export const OFFICIAL_PLUGIN_ICON = "data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2232%22 height=%2232%22%3E%3Crect width=%2232%22 height=%2232%22 rx=%226%22 fill=%22%23666%22/%3E%3C/svg%3E";

export const OFFICIAL_NODE_REPL_HOST_REQUIRED_SEED_PATHS = ["dist/mcp/server.js"] as const;

export const OFFICIAL_BROWSER_USE_REQUIRED_SEED_PATHS = [
  "docs/api.json",
  "docs/documents.json",
  "docs/overview.md",
  // documents.json 已注册 recording lookup；若不强制校验正文，会 seed 出无法读取录屏指南的残缺插件。
  "docs/recording.md",
  "docs/workflow.md",
  "scripts/browser-client.mjs",
  "skills/control-browser/SKILL.md",
  "skills/web-gui-tester/SKILL.md",
] as const;

export const OFFICIAL_CUA_REQUIRED_SEED_PATHS = [
  "docs/computer-use.md",
  "scripts/computer-use-client.mjs",
  "skills/computer-use/SKILL.md",
] as const;

// acode-guide 原本没有 requiredSeedPaths，seed 丢文件时会静默装出一个
// 没有 /workflow 命令的插件——症状是命令不存在，没有任何诊断。commands/ 与技能正文都钉住。
export const OFFICIAL_ACODE_GUIDE_REQUIRED_SEED_PATHS = [
  "commands/workflow.md",
  "skills/dynamic-workflows/SKILL.md",
  "skills/dynamic-workflows/examples.md",
  "skills/dynamic-workflows/patterns.md",
] as const;

/** documents/pdf/presentations/spreadsheets 四个同构文档插件的表驱动定义段。 */
export const DOCUMENT_STYLE_OFFICIAL_PLUGIN_DEFINITIONS: readonly OfficialPluginDefinition[] = (
  [
    ["documents", "docx", "Documents", "Word文档", "0.1.7"],
    ["pdf", "pdf", "PDF", "PDF", "0.2.0"],
    ["presentations", "pptx", "Presentations", "演示文档", "0.1.7"],
    ["spreadsheets", "xlsx", "Spreadsheets", "电子表格", "0.1.7"],
  ] as const
).map(
  ([name, skill, displayName, chineseName, version]): OfficialPluginDefinition => ({
    defaultEnabled: true,
    listing: {
      author: ZAI_AUTHOR,
      category: "productivity",
      displayName,
      displayName_i18n: { "zh-CN": chineseName },
      // 复用已发布的文档图标，拆分插件无需依赖新 CDN 资源。
      icon: OFFICIAL_PLUGIN_ICON,
      description_i18n: { "zh-CN": `创建、编辑与审阅${chineseName}（${skill.toUpperCase()}）。` },
    },
    name,
    requiredSeedPaths: ["agents/visual-judge.md", `skills/${skill}/SKILL.md`],
    rootCandidates: [
      `packages/${name}-plugin`,
      `../${name}-plugin`,
      `../../${name}-plugin`,
      `../../../${name}-plugin`,
    ],
    version,
  }),
);
