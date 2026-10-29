import { z } from "zod";
import { acodeWorkspaceRefSchema } from "../acode-session-types.js";
import {
  v4PluginComponentGroupSchema,
  v4PluginDiagnosticSchema,
  v4PluginInfoSchema,
  v4PluginMarketplaceSummarySchema,
  v4AvailablePluginSummarySchema,
  v4InstalledPluginSummarySchema,
  v4PluginScopeSchema,
  v4PluginStoreListingSchema,
} from "./plugins.js";

// plugins 域读路径（M2-5，specs/m2-5-plugins.md）：list/overview/describe/validate/
// referenceCatalog/resolveSuggestedReference 六法。域零件在 ./plugins.js；写路径在
// ./plugins-commands.js。形状与 legacy barrel 逐字 parity（protocol-boundary 测试钉住）。

const nonEmptyString = z.string().trim().min(1);
// 与 acode-protocol-legacy-types.ts 的 acodeDeliveryKindSchema 逐字同值。v4-imports-legacy-protocol
// 白名单只登记了 acodeWorkspaceRefSchema，本符号按「结构化再声明」纪律本地定义；
// 值域 parity 由 protocol-boundary 测试钉住。
const v4DeliveryKindSchema = z.enum(["desktop-continuous", "web-remote-replayable"]);

// ── v4/plugins/list ──
export const v4PluginsListParamsSchema = z
  .object({
    workspace: acodeWorkspaceRefSchema,
    configScope: v4PluginScopeSchema.optional(),
  })
  .strict();
export type V4PluginsListParams = z.infer<typeof v4PluginsListParamsSchema>;
export const v4PluginsListResultSchema = z
  .object({
    plugins: z.array(v4PluginInfoSchema),
    diagnostics: z.array(v4PluginDiagnosticSchema),
  })
  .strict();
export type V4PluginsListResult = z.infer<typeof v4PluginsListResultSchema>;

// ── v4/plugins/overview ──
export const v4PluginsOverviewParamsSchema = z
  .object({
    workspace: acodeWorkspaceRefSchema,
    configScope: v4PluginScopeSchema.optional(),
  })
  .strict();
export type V4PluginsOverviewParams = z.infer<typeof v4PluginsOverviewParamsSchema>;
export const v4PluginsOverviewResultSchema = z
  .object({
    marketplaces: z.array(v4PluginMarketplaceSummarySchema),
    availablePlugins: z.array(v4AvailablePluginSummarySchema),
    installedPlugins: z.array(v4InstalledPluginSummarySchema),
    restorableBuiltins: z.array(v4AvailablePluginSummarySchema),
    diagnostics: z.array(v4PluginDiagnosticSchema),
    // Host 注入的展示态：官方插件市场开关；agent 不返回，缺省视为可用（旧客户端兼容）。
    officialMarketplaceEnabled: z.boolean().optional(),
    capability: z
      .object({
        supported: z.boolean(),
        reason: z.string().optional(),
      })
      .strict(),
  })
  .strict();
export type V4PluginsOverviewResult = z.infer<typeof v4PluginsOverviewResultSchema>;

// ── v4/plugins/describe ──
// 按需枚举单个插件的组件「名称 + 描述」；已安装读本地缓存目录，未安装候选临时 clone 后清理。
export const v4PluginsDescribeParamsSchema = z
  .object({
    workspace: acodeWorkspaceRefSchema,
    pluginName: nonEmptyString,
    marketplace: nonEmptyString,
  })
  .strict();
export type V4PluginsDescribeParams = z.infer<typeof v4PluginsDescribeParamsSchema>;
export const v4PluginsDescribeResultSchema = z
  .object({
    components: z.array(v4PluginComponentGroupSchema),
    diagnostics: z.array(v4PluginDiagnosticSchema).optional(),
    // 插件包内 plugin.json 的展示性回退字段；商店 listing 缺失时详情页信息区兜底。
    metadata: z
      .object({
        author: z.string().optional(),
        authorUrl: z.string().optional(),
        homepage: z.string().optional(),
        version: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type V4PluginsDescribeResult = z.infer<typeof v4PluginsDescribeResultSchema>;

// ── v4/plugins/validate ──
export const v4PluginsValidateParamsSchema = z
  .object({
    workspace: acodeWorkspaceRefSchema,
    pluginName: nonEmptyString.optional(),
    marketplace: nonEmptyString.optional(),
    source: nonEmptyString.optional(),
  })
  .strict();
export type V4PluginsValidateParams = z.infer<typeof v4PluginsValidateParamsSchema>;
export const v4PluginsValidateResultSchema = z
  .object({
    ok: z.boolean(),
    diagnostics: z.array(v4PluginDiagnosticSchema),
    compatibility: z
      .object({
        runnable: z.array(z.string()),
        diagnosticOnly: z.array(z.string()),
        unsupported: z.array(z.string()),
      })
      .strict(),
  })
  .strict();
export type V4PluginsValidateResult = z.infer<typeof v4PluginsValidateResultSchema>;

// ── v4/plugins/referenceCatalog ──
// Session-scoped 只读投影：带 sessionId → 该 Session 创建时冻结的身份 catalog；
// 不带 → workspace 当前 catalog（新建草稿 Picker）。session 不存在按协议错误 fail closed，
// 禁止静默回退 workspace authority。身份与能力字段 identifiers-only；
// icon/displayName(I18n)/description(I18n) 仅供 UI 展示与 Picker 搜索。
// v4 单方法**恒带 category**——合并 legacy referenceCatalog / referenceCatalogWithCategory
// 两词（WithCategory 是超集；entry.category 本就 optional，旧解析方读无 category 的
// payload 不受影响）。pre-v4 CLI 的降级链在 services 侧 fallback（spec §4）。
export const v4PluginReferenceCatalogEntrySchema = z
  .object({
    category: nonEmptyString.optional(),
    pluginId: nonEmptyString,
    name: nonEmptyString,
    marketplace: nonEmptyString,
    icon: z.string().optional(),
    displayName: z.string().optional(),
    displayNameI18n: z.record(z.string(), z.string()).optional(),
    description: z.string().optional(),
    descriptionI18n: z.record(z.string(), z.string()).optional(),
    enabled: z.boolean(),
    // 非空 = 与其他 enabled Plugin 共享 manifest name 的 V1 fail closed 冲突。
    conflictingPluginIds: z.array(nonEmptyString),
    skillQualifiedNames: z.array(nonEmptyString),
    mcpServerNames: z.array(nonEmptyString),
    // 旧 Host 不投影该字段时按空数组兼容；只有新 Agent 会把它用于 reminder live 交集。
    subagentNames: z.array(nonEmptyString).default([]),
  })
  .strict();
export type V4PluginReferenceCatalogEntry = z.infer<typeof v4PluginReferenceCatalogEntrySchema>;

export const v4PluginsReferenceCatalogParamsSchema = z
  .object({
    workspace: acodeWorkspaceRefSchema,
    sessionId: nonEmptyString.optional(),
  })
  .strict();
export type V4PluginsReferenceCatalogParams = z.infer<typeof v4PluginsReferenceCatalogParamsSchema>;
export const v4PluginsReferenceCatalogResultSchema = z
  .object({
    authority: z.enum(["session", "workspace"]),
    plugins: z.array(v4PluginReferenceCatalogEntrySchema),
  })
  .strict();
export type V4PluginsReferenceCatalogResult = z.infer<typeof v4PluginsReferenceCatalogResultSchema>;

// ── v4/plugins/resolveSuggestedReference ──
// 推荐 Prompt 的可信插件解析：UI 不拆解 stableId，也不从旧目录快照推断可安装性。
export const v4PluginSuggestedReferenceStatusSchema = z.enum([
  "ready",
  "disabled",
  "missing",
  "conflict",
  "unavailable",
]);
export type V4PluginSuggestedReferenceStatus = z.infer<
  typeof v4PluginSuggestedReferenceStatusSchema
>;
export const v4PluginsResolveSuggestedReferenceParamsSchema = z
  .object({
    workspace: acodeWorkspaceRefSchema,
    stableId: nonEmptyString,
    operationId: nonEmptyString,
    clientMode: v4DeliveryKindSchema,
    deliveryKind: v4DeliveryKindSchema,
  })
  .strict();
export type V4PluginsResolveSuggestedReferenceParams = z.infer<
  typeof v4PluginsResolveSuggestedReferenceParamsSchema
>;
export const v4PluginsResolveSuggestedReferenceResultSchema = z
  .object({
    stableId: nonEmptyString,
    status: v4PluginSuggestedReferenceStatusSchema,
    marketplace: nonEmptyString.optional(),
    pluginName: nonEmptyString.optional(),
    sourceTrust: z.literal("official").optional(),
    // 官方 Marketplace listing 的可选展示投影；不参与身份、安装或权限判断。
    icon: z.string().optional(),
    listing: v4PluginStoreListingSchema.optional(),
    diagnostics: z.array(v4PluginDiagnosticSchema),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status !== "ready" && value.status !== "disabled" && value.status !== "missing") {
      return;
    }
    if (!value.marketplace || !value.pluginName || value.sourceTrust !== "official") {
      context.addIssue({
        code: "custom",
        message: "actionable suggested Plugin results require trusted install identity",
      });
    }
  });
export type V4PluginsResolveSuggestedReferenceResult = z.infer<
  typeof v4PluginsResolveSuggestedReferenceResultSchema
>;
