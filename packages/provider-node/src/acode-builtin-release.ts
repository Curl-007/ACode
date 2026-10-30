import { z } from "zod";
import {
  parseACodeBuiltinModelConfigRules,
  parseACodeBuiltinProviderConfigRules,
  type ModelConfigRules,
  type ProviderConfigMap,
  type ProviderTemplateMap,
} from "@acode/provider";

export const ACODE_BUILTIN_RELEASE_SCHEMA_VERSION = 1 as const;
const RETIRED_ZAPI_PROVIDER_ID = "builtin:zapi";
// 2026-10-30 用户裁决：智谱账号 provider（zai/bigmodel 两家族八条 plan）退出本产品构建。
// 与 ZAPI 同机制：旧 Remote Release / LKG 不得把已退条目重新发布进 Built-in 集合，
// 命中即拒整份 Release、Source 回落兼容候选（bundled 已删这些条目）。
const RETIRED_ZHIPU_ACCOUNT_PROVIDER_IDS = new Set([
  "account:zai-individual-coding-plan",
  "account:zai-team-coding-plan",
  "account:zai-start-plan",
  "account:bigmodel-individual-coding-plan",
  "account:bigmodel-team-coding-plan",
  "account:bigmodel-start-plan",
  "account:zai-offpeak-idle-plan",
  "account:bigmodel-offpeak-idle-plan",
]);

export interface ACodeBuiltinConfigContent {
  readonly providers: ProviderConfigMap;
  readonly providerTemplates: ProviderTemplateMap;
  readonly modelConfigRules: ModelConfigRules;
}

export interface ACodeBuiltinRelease {
  readonly schemaVersion: typeof ACODE_BUILTIN_RELEASE_SCHEMA_VERSION;
  readonly revision: number;
  readonly config: ACodeBuiltinConfigContent;
}

const releaseSchema = z
  .object({
    schemaVersion: z.literal(ACODE_BUILTIN_RELEASE_SCHEMA_VERSION),
    revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    config: z
      .object({
        providerConfigRules: z.unknown(),
        modelConfigRules: z.unknown(),
      })
      .strict(),
  })
  .strict();

export function decodeACodeBuiltinRelease(input: unknown): ACodeBuiltinRelease {
  const parsed = releaseSchema.parse(input);
  const { providers, providerTemplates } = parseACodeBuiltinProviderConfigRules(
    parsed.config.providerConfigRules,
  );
  // ZAPI 已退出产品，旧 Remote Release 或 LKG 不能在 Renderer 静态入口删除后
  // 又通过目标 Host Registry 将它重新发布。拒绝整份不兼容 Release，让 Source 回落到兼容候选。
  if (providers.has(RETIRED_ZAPI_PROVIDER_ID)) {
    throw new Error(`ACode Built-in Release 包含已退出的 Provider: ${RETIRED_ZAPI_PROVIDER_ID}`);
  }
  for (const retiredId of RETIRED_ZHIPU_ACCOUNT_PROVIDER_IDS) {
    if (providers.has(retiredId)) {
      throw new Error(`ACode Built-in Release 包含已退出的智谱账号 Provider: ${retiredId}`);
    }
  }
  return Object.freeze({
    schemaVersion: ACODE_BUILTIN_RELEASE_SCHEMA_VERSION,
    revision: parsed.revision,
    config: Object.freeze({
      providers,
      providerTemplates,
      modelConfigRules: parseACodeBuiltinModelConfigRules(parsed.config.modelConfigRules),
    }),
  });
}

export function encodeACodeBuiltinRelease(release: ACodeBuiltinRelease): object {
  return {
    schemaVersion: ACODE_BUILTIN_RELEASE_SCHEMA_VERSION,
    revision: release.revision,
    config: {
      providerConfigRules: {
        templateRules: release.config.providerTemplates.toJSON(),
        providerRules: release.config.providers.toJSON(),
      },
      modelConfigRules: release.config.modelConfigRules.toACodeBuiltinJSON(),
    },
  };
}

export function serializeACodeBuiltinRelease(release: ACodeBuiltinRelease): string {
  return JSON.stringify(encodeACodeBuiltinRelease(release));
}
