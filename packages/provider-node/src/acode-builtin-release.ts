import { z } from "zod";
import {
  parseACodeBuiltinModelConfigRules,
  parseACodeBuiltinProviderConfigRules,
  ProviderConfigMap,
  type ModelConfigRules,
  type ProviderTemplateMap,
} from "@acode/provider";

export const ACODE_BUILTIN_RELEASE_SCHEMA_VERSION = 1 as const;
// 退役 Provider 清单（解码期剥离，见 decodeACodeBuiltinRelease 注释）：
// builtin:zapi（ZAPI 已退出产品）+ 2026-10-30 用户裁决退役的智谱账号 provider 八条。
const RETIRED_PROVIDER_IDS = new Set([
  "builtin:zapi",
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
  // 退役条目剥离（2026-10-30 语义修订，取代整份拒绝）：Remote/LKG/Active 缓存可能仍携带
  // 已退役 Provider（远端 release 不受本分支控制；agent spawn env 的 bundled 候选即 Active
  // 路径，整份拒绝会让 bundled/active 同源同败 → host 崩溃循环）。剥离保证退役条目永不进入
  // 发布快照（ZAPI 原顾虑仍成立），其余条目按正常 LKG 语义继续服务。
  const retiredPresent = [...providers.entries()]
    .map(([providerId]) => providerId)
    .filter((providerId) => RETIRED_PROVIDER_IDS.has(providerId));
  const strippedProviders =
    retiredPresent.length > 0
      ? new ProviderConfigMap(
          [...providers.entries()].filter(([providerId]) => !RETIRED_PROVIDER_IDS.has(providerId)),
        )
      : providers;
  return Object.freeze({
    schemaVersion: ACODE_BUILTIN_RELEASE_SCHEMA_VERSION,
    revision: parsed.revision,
    config: Object.freeze({
      providers: strippedProviders,
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
