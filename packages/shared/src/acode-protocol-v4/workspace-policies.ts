import { z } from "zod";
import { acodeWorkspaceRefSchema } from "../acode-protocol-legacy-types.js";

// workspace 授权/配置同步面的 v4 域零件（M2-8，specs/m2-8-workspace-provider-process.md）：
// hooks/trustGrant（workspace 级 hook 预信任授权，CLI 侧带 accepted→session 重载联动）+
// updateInteractionPreferences / updateModelIoPreferences / updateOffPeakToolPolicy /
// updateDynamicWorkflowPolicy（host 判定结论的 workspace 级进程缓存同步）。
//
// 形状纪律：与 legacy barrel 对应段**逐字 parity**（同字段、同 strict、同值域），消费者语义
// 零变化；不反向 import legacy barrel（protocol-boundary 纪律），两侧形状由
// packages/shared/tests/protocol-boundary.test.mjs 钉住。digest 正则与 reasonCode 六值
// 枚举本地逐字再声明（白名单只登记 acodeWorkspaceRefSchema）。

// ── v4/workspace/hooks/trustGrant ──
// 与 legacy barrel 的 workspaceHookSha256DigestSchema 逐字同值。
const v4WorkspaceHookSha256DigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
export const v4WorkspaceHookTrustGrantParamsSchema = z
  .object({
    workspace: acodeWorkspaceRefSchema,
    bundleDigest: v4WorkspaceHookSha256DigestSchema,
    hookDeclarationDigest: v4WorkspaceHookSha256DigestSchema,
  })
  .strict();
export type V4WorkspaceHookTrustGrantParams = z.infer<
  typeof v4WorkspaceHookTrustGrantParamsSchema
>;
export const v4WorkspaceHookTrustGrantReasonCodeSchema = z.enum([
  "workspace_hooks_blocked_by_policy",
  "workspace_hooks_bundle_changed",
  "workspace_hooks_snapshot_mismatch",
  "workspace_hooks_policy_requires_pretrust",
  "workspace_hooks_trust_store_corrupt",
  "workspace_hooks_config_unreadable",
]);
export type V4WorkspaceHookTrustGrantReasonCode = z.infer<
  typeof v4WorkspaceHookTrustGrantReasonCodeSchema
>;
export const v4WorkspaceHookTrustGrantResultSchema = z
  .object({
    accepted: z.boolean(),
    reasonCode: v4WorkspaceHookTrustGrantReasonCodeSchema.optional(),
  })
  .strict();
export type V4WorkspaceHookTrustGrantResult = z.infer<
  typeof v4WorkspaceHookTrustGrantResultSchema
>;

// ── v4/workspace/updateInteractionPreferences ──
export const v4InteractionPreferencesSchema = z
  .object({
    askUserQuestionAutoResolutionEnabled: z.boolean(),
  })
  .strict();
export type V4InteractionPreferences = z.infer<typeof v4InteractionPreferencesSchema>;

export const v4WorkspaceUpdateInteractionPreferencesParamsSchema = z
  .object({
    workspace: acodeWorkspaceRefSchema,
    preferences: v4InteractionPreferencesSchema,
  })
  .strict();
export type V4WorkspaceUpdateInteractionPreferencesParams = z.infer<
  typeof v4WorkspaceUpdateInteractionPreferencesParamsSchema
>;

export const v4WorkspaceUpdateInteractionPreferencesResultSchema = z
  .object({
    workspace: acodeWorkspaceRefSchema,
    askUserQuestionAutoResolutionEnabled: z.boolean(),
    snoozedInteractionCount: z.number().int().nonnegative(),
  })
  .strict();
export type V4WorkspaceUpdateInteractionPreferencesResult = z.infer<
  typeof v4WorkspaceUpdateInteractionPreferencesResultSchema
>;

// ── v4/workspace/updateModelIoPreferences ──
export const v4ModelIoPreferencesSchema = z
  .object({
    fullRetentionEnabled: z.boolean(),
  })
  .strict();
export type V4ModelIoPreferences = z.infer<typeof v4ModelIoPreferencesSchema>;

export const v4WorkspaceUpdateModelIoPreferencesParamsSchema = z
  .object({
    workspace: acodeWorkspaceRefSchema,
    preferences: v4ModelIoPreferencesSchema,
  })
  .strict();
export type V4WorkspaceUpdateModelIoPreferencesParams = z.infer<
  typeof v4WorkspaceUpdateModelIoPreferencesParamsSchema
>;

export const v4WorkspaceUpdateModelIoPreferencesResultSchema = z
  .object({
    workspace: acodeWorkspaceRefSchema,
    fullRetentionEnabled: z.boolean(),
    updatedSessionCount: z.number().int().nonnegative(),
  })
  .strict();
export type V4WorkspaceUpdateModelIoPreferencesResult = z.infer<
  typeof v4WorkspaceUpdateModelIoPreferencesResultSchema
>;

// ── v4/workspace/updateOffPeakToolPolicy ──
export const v4WorkspaceUpdateOffPeakToolPolicyParamsSchema = z
  .object({
    workspace: acodeWorkspaceRefSchema,
    enabled: z.boolean(),
  })
  .strict();
export type V4WorkspaceUpdateOffPeakToolPolicyParams = z.infer<
  typeof v4WorkspaceUpdateOffPeakToolPolicyParamsSchema
>;

export const v4WorkspaceUpdateOffPeakToolPolicyResultSchema = z
  .object({
    workspace: acodeWorkspaceRefSchema,
    enabled: z.boolean(),
  })
  .strict();
export type V4WorkspaceUpdateOffPeakToolPolicyResult = z.infer<
  typeof v4WorkspaceUpdateOffPeakToolPolicyResultSchema
>;

// ── v4/workspace/updateDynamicWorkflowPolicy ──
// 动态工作流灰度门禁：workspace 级事实，与 Off-Peak 同一套 host→CLI 同步模式；
// 旧 CLI method-not-found → host 降级忽略。
export const v4WorkspaceUpdateDynamicWorkflowPolicyParamsSchema = z
  .object({
    workspace: acodeWorkspaceRefSchema,
    enabled: z.boolean(),
  })
  .strict();
export type V4WorkspaceUpdateDynamicWorkflowPolicyParams = z.infer<
  typeof v4WorkspaceUpdateDynamicWorkflowPolicyParamsSchema
>;

export const v4WorkspaceUpdateDynamicWorkflowPolicyResultSchema = z
  .object({
    workspace: acodeWorkspaceRefSchema,
    enabled: z.boolean(),
  })
  .strict();
export type V4WorkspaceUpdateDynamicWorkflowPolicyResult = z.infer<
  typeof v4WorkspaceUpdateDynamicWorkflowPolicyResultSchema
>;
