import { z } from "zod";
import { modelSelectionSchema } from "./model-selection.js";
import { providerFamilyConnectionSelectionSettingsSchema } from "./provider-family-connection-selection.js";

const nonEmptyString = z.string().trim().min(1);

export const providerProvisioningTriggerSchema = z.enum([
  "environment-online",
  "personal-config",
  "configured-default",
  "account-settings",
  "credential",
]);
export type ProviderProvisioningTrigger = z.infer<typeof providerProvisioningTriggerSchema>;

/** Provisioning 中允许跨 Environment 传输的凭据类别。 */
export const providerProvisioningCredentialScopeSchema = z.enum([
  "oauth-session",
  "account-provider",
  "provider-apikey",
]);

export type ProviderProvisioningCredentialScope = z.infer<
  typeof providerProvisioningCredentialScopeSchema
>;

/** 只允许同步 Account Provider 的请求期 API key，不同步账号身份或未来其它扩展字段。 */
export function isProviderProvisioningAccountCredentialKey(key: string): boolean {
  const normalized = key.trim();
  return normalized === key && /^account-provider:.+:api-key$/.test(normalized);
}

/**
 * 只允许同步 BYO Provider 的 vault 化 API key（`provider:apikey:<providerId>`，P1-5 的确定性引用键）。
 * 键格式与 `@acode/provider` 的 `providerApiKeyCredentialKey` 一致；本包不能反向依赖 provider，
 * 故以同一正则在此声明。provider_config.json 里只存 ref，真值必须随信封传输，
 * 否则目标端 hydrate 得 null、BYO provider 在远程/迁移环境静默失效。
 */
export function isProviderProvisioningProviderApiKeyCredentialKey(key: string): boolean {
  const normalized = key.trim();
  return normalized === key && /^provider:apikey:.+$/.test(normalized);
}

/** Personal Config 的 Envelope；具体字段由 @acode/provider 在目标 Environment 再校验。 */
export const providerProvisioningPersonalConfigSchema = z
  .object({
    providerConfigRules: z.object({ providerRules: z.array(z.unknown()) }).strict(),
    modelConfigRules: z
      .object({
        providerModelRules: z.array(z.unknown()),
        manualProviderModelRules: z.array(z.unknown()),
      })
      .strict(),
    providerOrder: z.array(nonEmptyString).optional(),
    defaultModelSelection: modelSelectionSchema.optional(),
  })
  .strict();

export type ProviderProvisioningPersonalConfig = z.infer<
  typeof providerProvisioningPersonalConfigSchema
>;

export const providerProvisioningAccountSettingsSchema = z
  .object({
    providerFamilyDomain: z.enum(["zai", "bigmodel"]).nullable(),
    providerFamilyConnectionSelections: providerFamilyConnectionSelectionSettingsSchema,
  })
  .strict();

export type ProviderProvisioningAccountSettings = z.infer<
  typeof providerProvisioningAccountSettingsSchema
>;

export const providerProvisioningCredentialEntrySchema = z
  .object({
    scope: providerProvisioningCredentialScopeSchema,
    key: nonEmptyString,
    value: z.string(),
  })
  .strict();

export type ProviderProvisioningCredentialEntry = z.infer<
  typeof providerProvisioningCredentialEntrySchema
>;

export const providerProvisioningEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(1),
    syncId: nonEmptyString,
    personalConfig: providerProvisioningPersonalConfigSchema,
    accountSettings: providerProvisioningAccountSettingsSchema,
    credentials: z.array(providerProvisioningCredentialEntrySchema).max(256),
  })
  .strict();

export type ProviderProvisioningEnvelope = z.infer<typeof providerProvisioningEnvelopeSchema>;

export const providerProvisioningResultSchema = z
  .object({
    syncId: nonEmptyString,
    status: z.enum(["applied", "already-applied", "unsupported", "failed", "rollback_failed"]),
    personalProviderCount: z.number().int().nonnegative(),
    credentialCount: z.number().int().nonnegative(),
    configRevision: nonEmptyString.optional(),
    errorMessage: z.string().optional(),
    rolledBack: z.boolean(),
  })
  .strict();

export type ProviderProvisioningResult = z.infer<typeof providerProvisioningResultSchema>;
