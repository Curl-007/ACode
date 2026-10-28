import { z } from "zod";
import { acodeWorkspaceRefSchema } from "../acode-protocol-legacy-types.js";
import {
  v4PluginDiagnosticSchema,
  v4PluginInfoSchema,
  v4PluginMarketplaceSummarySchema,
  v4InstalledPluginSummarySchema,
  v4PluginScopeSchema,
} from "./plugins.js";

// plugins 域写路径（M2-5，specs/m2-5-plugins.md）：setEnabled/marketplace×3/install/
// uninstall/update/restoreBuiltin/configure/resetConfig 十法。形态 = v4 名字空间的普通
// 请求-响应 RPC（workspace 级、无会话、无 CAS），不是 conversation v4/command 信封。
// cancelOperation 刻意不在本域（中止注册表按 operationId 键控、与协议代际无关，保留
// legacy 词，spec §4）。形状与 legacy barrel 逐字 parity（protocol-boundary 测试钉住）。

const nonEmptyString = z.string().trim().min(1);
// 与 legacy barrel 的局部 jsonObjectSchema 同形（configure options 载体）。
const jsonObjectSchema = z.record(z.string(), z.unknown());

// ── v4/plugins/setEnabled ──
export const v4PluginsSetEnabledParamsSchema = z
  .object({
    workspace: acodeWorkspaceRefSchema,
    pluginId: nonEmptyString,
    enabled: z.boolean(),
    operationId: nonEmptyString.optional(),
    scope: v4PluginScopeSchema.optional(),
  })
  .strict();
export type V4PluginsSetEnabledParams = z.infer<typeof v4PluginsSetEnabledParamsSchema>;
export const v4PluginsSetEnabledResultSchema = z
  .object({
    plugin: v4PluginInfoSchema,
    enabled: z.boolean(),
  })
  .strict();
export type V4PluginsSetEnabledResult = z.infer<typeof v4PluginsSetEnabledResultSchema>;

// ── v4/plugins/marketplace/{add,remove,update} ──
export const v4PluginsMarketplaceAddParamsSchema = z
  .object({
    workspace: acodeWorkspaceRefSchema,
    source: nonEmptyString,
    dryRun: z.boolean().optional(),
    operationId: nonEmptyString.optional(),
  })
  .strict();
export type V4PluginsMarketplaceAddParams = z.infer<typeof v4PluginsMarketplaceAddParamsSchema>;
export const v4PluginsMarketplaceRemoveParamsSchema = z
  .object({
    workspace: acodeWorkspaceRefSchema,
    marketplace: nonEmptyString,
  })
  .strict();
export type V4PluginsMarketplaceRemoveParams = z.infer<
  typeof v4PluginsMarketplaceRemoveParamsSchema
>;
export const v4PluginsMarketplaceUpdateParamsSchema = z
  .object({
    workspace: acodeWorkspaceRefSchema,
    marketplace: nonEmptyString.optional(),
    operationId: nonEmptyString.optional(),
  })
  .strict();
export type V4PluginsMarketplaceUpdateParams = z.infer<
  typeof v4PluginsMarketplaceUpdateParamsSchema
>;
export const v4PluginsMarketplaceMutationResultSchema = z
  .object({
    marketplace: v4PluginMarketplaceSummarySchema.optional(),
    marketplaces: z.array(v4PluginMarketplaceSummarySchema).optional(),
    diagnostics: z.array(v4PluginDiagnosticSchema).optional(),
  })
  .strict();
export type V4PluginsMarketplaceMutationResult = z.infer<
  typeof v4PluginsMarketplaceMutationResultSchema
>;

// ── v4/plugins/install ──
export const v4PluginsInstallParamsSchema = z
  .object({
    workspace: acodeWorkspaceRefSchema,
    pluginName: nonEmptyString,
    marketplace: nonEmptyString,
    scope: v4PluginScopeSchema.optional(),
    dryRun: z.boolean().optional(),
    operationId: nonEmptyString.optional(),
  })
  .strict();
export type V4PluginsInstallParams = z.infer<typeof v4PluginsInstallParamsSchema>;
export const v4PluginsInstallResultSchema = z
  .object({
    installedPlugins: z.array(v4InstalledPluginSummarySchema),
    dependencyClosure: z.array(z.string()),
    diagnostics: z.array(v4PluginDiagnosticSchema),
  })
  .strict();
export type V4PluginsInstallResult = z.infer<typeof v4PluginsInstallResultSchema>;

// ── v4/plugins/uninstall ──
export const v4PluginsUninstallParamsSchema = z
  .object({
    workspace: acodeWorkspaceRefSchema,
    pluginId: nonEmptyString.optional(),
    pluginName: nonEmptyString.optional(),
    marketplace: nonEmptyString.optional(),
    removeCache: z.boolean().optional(),
  })
  .strict();
export type V4PluginsUninstallParams = z.infer<typeof v4PluginsUninstallParamsSchema>;
export const v4PluginsUninstallResultSchema = z
  .object({
    removedPlugin: v4InstalledPluginSummarySchema.optional(),
    diagnostics: z.array(v4PluginDiagnosticSchema),
  })
  .strict();
export type V4PluginsUninstallResult = z.infer<typeof v4PluginsUninstallResultSchema>;

// ── v4/plugins/update ──
export const v4PluginsUpdateParamsSchema = z
  .object({
    workspace: acodeWorkspaceRefSchema,
    pluginId: nonEmptyString.optional(),
    marketplace: nonEmptyString.optional(),
  })
  .strict();
export type V4PluginsUpdateParams = z.infer<typeof v4PluginsUpdateParamsSchema>;

// ── v4/plugins/restoreBuiltin ──
export const v4PluginsRestoreBuiltinParamsSchema = z
  .object({
    workspace: acodeWorkspaceRefSchema,
    pluginId: nonEmptyString,
  })
  .strict();
export type V4PluginsRestoreBuiltinParams = z.infer<typeof v4PluginsRestoreBuiltinParamsSchema>;
export const v4PluginsRestoreBuiltinResultSchema = z
  .object({
    pluginId: nonEmptyString,
    diagnostics: z.array(v4PluginDiagnosticSchema),
  })
  .strict();
export type V4PluginsRestoreBuiltinResult = z.infer<typeof v4PluginsRestoreBuiltinResultSchema>;

// ── v4/plugins/configure ──
export const v4PluginsConfigureParamsSchema = z
  .object({
    workspace: acodeWorkspaceRefSchema,
    pluginId: nonEmptyString,
    options: jsonObjectSchema,
    clearOptionKeys: z.array(nonEmptyString).optional(),
    scope: v4PluginScopeSchema.optional(),
    dryRun: z.boolean().optional(),
  })
  .strict();
export type V4PluginsConfigureParams = z.infer<typeof v4PluginsConfigureParamsSchema>;
export const v4PluginsConfigureResultSchema = z
  .object({
    pluginId: nonEmptyString,
    diagnostics: z.array(v4PluginDiagnosticSchema),
  })
  .strict();
export type V4PluginsConfigureResult = z.infer<typeof v4PluginsConfigureResultSchema>;

// ── v4/plugins/resetConfig ──
export const v4PluginsResetConfigParamsSchema = z
  .object({
    workspace: acodeWorkspaceRefSchema,
    pluginId: nonEmptyString,
    scope: v4PluginScopeSchema.optional(),
  })
  .strict();
export type V4PluginsResetConfigParams = z.infer<typeof v4PluginsResetConfigParamsSchema>;
