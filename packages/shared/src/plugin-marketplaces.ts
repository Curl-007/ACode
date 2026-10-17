import { isOfficialServiceEnabled } from "./officialPlatformPolicy.js";

export interface DefaultPluginMarketplace {
  id: string;
  source: string;
  name: string;
  description: string;
  pluginCount: number;
  lastUpdated?: string;
}

export const ACODE_OFFICIAL_PLUGIN_MARKETPLACE_ID = "acode-plugins-official";

/**
 * 第三方预置市场 The Wasp Nest 的 canonical id：必须与其 manifest
 * （.claude-plugin/marketplace.json）的 name 一致，否则注册表会出现同来源双条目
 * （specs/plugin-marketplace-defaults.md 规则 2）。
 */
export const WASP_NEST_MARKETPLACE_ID = "wasp-nest";

/** Settings 三类资源发现共用；Bootstrap 单测与官方 definition 的 defaultEnabled 机械对照。 */
export const DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS: ReadonlySet<string> = new Set([
  "browser-use@acode-plugins-official",
  "image-search@acode-plugins-official",
  "documents@acode-plugins-official",
  "pdf@acode-plugins-official",
  "presentations@acode-plugins-official",
  "spreadsheets@acode-plugins-official",
  // node_repl 宿主：不进市场、不对用户露出，也不贡献任何 skill/command/subagent，但必须
  // 始终可用 —— node_repl 的注册门禁是「Browser Use 或 Computer Use 任一启用」，宿主自己
  // 不参与那个判断。Browser Use 默认开着，宿主若默认关就等于它上来就没有宿主。
  "node-repl-host@acode-plugins-official",
  "skill-creator@acode-plugins-official",
  "plugin-creator@acode-plugins-official",
  "acode-guide@acode-plugins-official",
  // AgentTeams 默认启用（自启动）是 2026-10-15 产品拍板：开箱即得团队工具与
  // agent-teams:member subagent（apps/acode-cli/specs/agent-teams-derived-config.md R1）。
  // 携带 stdio MCP server，是「defaultEnabled 仅限内容型插件」约定的显式例外（spec 登记）。
  "agent-teams@acode-plugins-official",
  // 电脑控制回退为默认关闭，故 computer-use 不在此名单内。
  // 该集合必须与 official-plugin-definitions.ts 里标了 defaultEnabled 的插件逐一对应，
  // bootstrap 的「Settings 默认启用集合与 CLI 的官方插件声明一致」单测机械对照两者。
]);

// 默认市场来源定义保留在这里；是否进入默认市场集合由 marketplace 开关决定
// （见 resolveDefaultPluginMarketplaces）。关闭时不 seed，保持审计版默认断连。
export const DEFAULT_PLUGIN_MARKETPLACES: DefaultPluginMarketplace[] = [
  {
    // ACode 官方唯一市场：本地 seed 分片与 CDN 分片在 Agent storage 内合并。
    // CDN manifest 的 name 必须与该 canonical id 一致。
    id: ACODE_OFFICIAL_PLUGIN_MARKETPLACE_ID,
    source: "https://cdn-zcode.z.ai/zcode/official-plugin/marketplace.json",
    name: ACODE_OFFICIAL_PLUGIN_MARKETPLACE_ID,
    description: "Official ACode plugins marketplace: built-in and community plugins for ACode.",
    pluginCount: 0,
  },
  {
    // 第三方社区市场（specs/plugin-marketplace-defaults.md，2026-10-17 产品决定）：
    // The Wasp Nest——21 插件（184 agents/223 skills，Claude 生态 manifest 形态，
    // 市场层按 .claude-plugin/marketplace.json 兼容探测）。AGPL-3.0-or-later：
    // 只预置市场来源链接与 manifest 事实字段，不复制其任何内容进本仓库（link-only
    // 纪律）；插件获取与安装始终由用户显式动作触发，注册本身不执行插件代码。
    // source 必须写 owner/repo 简写：种子解析器只把简写归为 github 源（clone 仓库
    // 找 manifest）；完整 URL 会被当成直指 JSON 的 url 源，指向仓库页必然拉取失败。
    id: WASP_NEST_MARKETPLACE_ID,
    source: "legioncodeinc/vibe-coding-tools",
    name: WASP_NEST_MARKETPLACE_ID,
    description: "The Wasp Nest: core plus add-on packs.",
    pluginCount: 21,
  },
];

/**
 * 默认插件市场集合按官方服务开关过滤：种子表全部是远程市场来源（官方 CDN 与
 * 第三方 GitHub），统一受 marketplace 开关约束——审计版默认断连时不 seed 任何
 * 远程市场。本地内置插件与个人来源不在本表，不经过该过滤。
 * agent 进程的开关来自 Desktop 的 env 投影或 CLI 手动的 ACODE_ENABLE_OFFICIAL_*。
 */
export function resolveDefaultPluginMarketplaces(): DefaultPluginMarketplace[] {
  if (!isOfficialServiceEnabled("marketplace")) return [];
  return DEFAULT_PLUGIN_MARKETPLACES;
}

// 商店「公开」分段只有一个 ACode 官方市场 id，内置与 CDN 不再拆分身份。
export const PUBLIC_STORE_MARKETPLACE_IDS = [ACODE_OFFICIAL_PLUGIN_MARKETPLACE_ID] as const;

export function isPublicStoreMarketplaceId(id: string): boolean {
  return (PUBLIC_STORE_MARKETPLACE_IDS as readonly string[]).includes(id);
}
