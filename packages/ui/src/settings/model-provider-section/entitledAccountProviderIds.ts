import type { ProviderSettingsProviderView } from "@acode/services";

/**
 * 已授权（entitled）的 Account Provider id 集合（自 ModelProviderSection.tsx 迁出，
 * 维持该文件的行数 ratchet 不增长；纯函数，语义逐字不变）。
 * 只认 effectiveConfig 的 zhipu-account + entitled=true，不看权益查询的即时快照。
 */
export function resolveEntitledAccountProviderIds(
  providers: readonly ProviderSettingsProviderView[] | undefined,
): ReadonlySet<string> {
  return new Set(
    (providers ?? [])
      .filter(
        (provider) =>
          provider.effectiveConfig.access?.type === "zhipu-account" &&
          provider.effectiveConfig.access.entitled === true,
      )
      .map((provider) => provider.providerId),
  );
}