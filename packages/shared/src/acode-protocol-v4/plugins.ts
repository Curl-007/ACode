import { z } from "zod";

// 插件管理面（设置页 / Picker / 推荐 Prompt 链）的 v4 域零件（M2-5，
// specs/m2-5-plugins.md）。读路径六法在 ./plugins-queries.js，写路径十法在
// ./plugins-commands.js；本叶子只放被两侧复用的实体/零件 schema。
//
// ⚠ 域边界：workspace 级、无会话的管理/查询面，每次调用现扫配置与市场快照，不投影、不订阅；
// 与会话内任何 projection 键族无关。`plugins/cancelOperation` 刻意**不在**本域——中止注册表按
// operationId 键控、与协议代际无关，保留 legacy 词（spec §4）。
//
// 形状纪律：与 legacy barrel 的 plugins* 段**逐字 parity**（同字段、同 strict、同值域），
// 消费者语义零变化；不反向 import legacy barrel（protocol-boundary 纪律），两侧形状由
// packages/shared/tests/protocol-boundary.test.mjs 钉住。legacy 段自述其镜像
// @acode/contracts 的 PluginMetadata，本文件因此也与 contracts 间接同形。

const nonEmptyString = z.string().trim().min(1);
// 与 legacy barrel 的局部 jsonObjectSchema 同形（marketplace source 载体）。
const jsonObjectSchema = z.record(z.string(), z.unknown());

// ── 域零件（option/scope/hook/userConfig/component/diagnostic）──
export const v4PluginOptionValueSchema = z.union([z.string(), z.number(), z.boolean()]);
export type V4PluginOptionValue = z.infer<typeof v4PluginOptionValueSchema>;
export const v4PluginScopeSchema = z.enum(["user", "workspace"]);
export type V4PluginScope = z.infer<typeof v4PluginScopeSchema>;
export const v4PluginHookDetailSchema = z
  .object({
    event: nonEmptyString,
    matcher: z.string().optional(),
    type: z.enum(["command", "process"]),
    command: nonEmptyString,
    args: z.array(z.string()).optional(),
    async: z.boolean().optional(),
    shell: z.union([z.literal(true), z.string()]).optional(),
    timeout: z.number().positive().optional(),
    timeoutMs: z.number().int().positive().optional(),
    statusMessage: z.string().optional(),
    sourcePath: z.string(),
    runnable: z.boolean(),
  })
  .strict();
export const v4PluginUserConfigOptionSchema = z
  .object({
    default: v4PluginOptionValueSchema.optional(),
    description: z.string().optional(),
    required: z.boolean().optional(),
    sensitive: z.boolean().optional(),
    title: z.string().optional(),
    type: z.enum(["string", "number", "boolean", "directory", "file"]).optional(),
  })
  .strict();
export type V4PluginUserConfigOption = z.infer<typeof v4PluginUserConfigOptionSchema>;

// 组件类型与详情弹窗/市场详情共用的分组顺序保持一致：agent / command / skill / hook / mcp。
export const v4PluginComponentKindSchema = z.enum(["agent", "command", "skill", "hook", "mcp"]);
export type V4PluginComponentKind = z.infer<typeof v4PluginComponentKindSchema>;

export const v4PluginComponentItemSchema = z
  .object({
    name: nonEmptyString,
    // 描述来自组件 frontmatter（SKILL.md / command / agent）或 manifest；缺失时省略，不伪造。
    description: z.string().optional(),
  })
  .strict();
export const v4PluginComponentGroupSchema = z
  .object({
    kind: v4PluginComponentKindSchema,
    items: z.array(v4PluginComponentItemSchema),
  })
  .strict();
export type V4PluginComponentGroup = z.infer<typeof v4PluginComponentGroupSchema>;

export const v4PluginInfoSchema = z
  .object({
    id: nonEmptyString,
    name: nonEmptyString,
    description: z.string().optional(),
    version: z.string().optional(),
    enabled: z.boolean(),
    source: nonEmptyString,
    marketplace: nonEmptyString,
    // manifest（plugin.json）的作者/主页回退字段；商店 listing 缺失时详情页信息区用它兜底。
    author: z.string().optional(),
    authorUrl: z.string().optional(),
    homepage: z.string().optional(),
    skillCount: z.number().int().nonnegative().optional(),
    skillRootCount: z.number().int().nonnegative(),
    commandRootCount: z.number().int().nonnegative(),
    // 权威组件清单（名称 + 可选描述），由 CLI 对插件根目录枚举得出，与启用态无关。
    components: z.array(v4PluginComponentGroupSchema).optional(),
    declaredMcpServerNames: z.array(z.string()).optional(),
    hostMcpServerNames: z.array(z.string()).optional(),
    mcpServerNames: z.array(z.string()),
    hookDetails: z.array(v4PluginHookDetailSchema).optional(),
    rootPath: z.string(),
    userConfig: z.record(z.string(), v4PluginUserConfigOptionSchema).optional(),
    configuredOptions: z.record(z.string(), v4PluginOptionValueSchema).optional(),
    // 缺省表示 package 可用；missing 用于保留已声明但目标 Host 尚未物化的配置行。
    packageStatus: z.literal("missing").optional(),
    rootSource: v4PluginScopeSchema.optional(),
    enabledSource: v4PluginScopeSchema.optional(),
    optionSources: z.record(z.string(), v4PluginScopeSchema).optional(),
  })
  .strict();
export type V4PluginInfo = z.infer<typeof v4PluginInfoSchema>;

export const v4PluginDiagnosticSchema = z
  .object({
    code: z.string(),
    message: z.string(),
    severity: z.enum(["warning", "error"]).optional(),
    pluginId: z.string().optional(),
  })
  .strict();
export type V4PluginDiagnostic = z.infer<typeof v4PluginDiagnosticSchema>;

// 商店信息（Store Listing）：目录条目携带的展示性元数据，全部可选，UI 缺失时按降级矩阵处理。
export const v4PluginStoreListingSchema = z
  .object({
    displayName: z.string().optional(),
    displayNameI18n: z.record(z.string(), z.string()).optional(),
    descriptionI18n: z.record(z.string(), z.string()).optional(),
    icon: z.string().optional(),
    category: z.string().optional(),
    author: z.string().optional(),
    authorUrl: z.string().optional(),
    homepage: z.string().optional(),
    privacyPolicy: z.string().optional(),
    termsOfService: z.string().optional(),
    heroImage: z.string().optional(),
    examplePrompts: z.array(z.string()).optional(),
    examplePromptsI18n: z.record(z.string(), z.array(z.string())).optional(),
    // 需要付费套餐才好用的插件：描述「使用条件」而非「收费商品」，不参与安装门禁与计费。
    requiresPaidPlan: z.boolean().optional(),
  })
  .strict();
export type V4PluginStoreListing = z.infer<typeof v4PluginStoreListingSchema>;

export const v4PluginMarketplaceSummarySchema = z
  .object({
    id: nonEmptyString,
    name: nonEmptyString,
    source: jsonObjectSchema,
    description: z.string().optional(),
    lastUpdated: z.string().optional(),
    pluginCount: z.number().int().nonnegative(),
    isOfficial: z.boolean().optional(),
    // 目录顶层 featured 策展名单（商店「公开」分段 Featured 区）。
    featured: z.array(z.string()).optional(),
    refreshFailure: z
      .object({
        code: z.string(),
        failedAt: z.string(),
        message: z.string(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type V4PluginMarketplaceSummary = z.infer<typeof v4PluginMarketplaceSummarySchema>;

export const v4AvailablePluginSummarySchema = z
  .object({
    id: nonEmptyString,
    name: nonEmptyString,
    marketplace: nonEmptyString,
    description: z.string().optional(),
    version: z.string().optional(),
    installed: z.boolean(),
    componentTypes: z.array(z.string()).optional(),
    listing: v4PluginStoreListingSchema.optional(),
  })
  .strict();
export type V4AvailablePluginSummary = z.infer<typeof v4AvailablePluginSummarySchema>;

export const v4InstalledPluginSummarySchema = z
  .object({
    id: nonEmptyString,
    name: nonEmptyString,
    marketplace: nonEmptyString,
    description: z.string().optional(),
    version: z.string().optional(),
    enabled: z.boolean(),
    scope: v4PluginScopeSchema,
    installPath: z.string().optional(),
    installedAt: z.string().optional(),
    componentTypes: z.array(z.string()).optional(),
    hookDetails: z.array(v4PluginHookDetailSchema).optional(),
    updateStatus: z.enum(["none", "update-available", "version-changed"]).optional(),
    latestVersion: z.string().optional(),
    listing: v4PluginStoreListingSchema.optional(),
  })
  .strict();
export type V4InstalledPluginSummary = z.infer<typeof v4InstalledPluginSummarySchema>;
