import { ApiKeyAccessConfig, ProviderConfig } from "./config/provider-config.js";
import type { ProviderConfigMap } from "./config/index.js";

/**
 * BYO Provider API Key 的加密凭据库接口（安全加固 P1-5）。
 *
 * `provider_config.json` 里只存 `credentialRef`（稳定字符串引用），真值托管在加密凭据库
 * （`credentials.json`，即 P0-4 已加固的存储）。本接口把「凭据库在哪、怎么加解密」这件事
 * 抽象成一个注入点，使 `@acode/provider` / `@acode/provider-node` 不必反向依赖 `@acode/services`
 * （那会构成循环依赖：services 已依赖 provider-node）。
 *
 * 注入来源：
 * - 桌面 host：`@acode/services` 的 `ProviderConfigRuntime` 注入，底层是 `ICredentialService`；
 * - CLI：`auth-login` / provider runtime 注入它已有的 `SharedACodeCredentialStore`。
 * - 不注入（纯 builtin、测试、凭据库不可用）：调用方退化为「不迁移、明文照读」的安全空操作。
 */
export interface ProviderApiKeyVault {
  /**
   * 按引用读出明文 Key。返回 null 表示引用不存在（凭据库被清、跨机器迁移未带凭据等）；
   * 抛错表示凭据库不可用。两种情况调用方都应回退到「文件里残留的明文 apiKey」而非崩溃。
   */
  load(credentialRef: string): Promise<string | null>;

  /**
   * 存入明文 Key，返回新建的稳定引用（形如 `provider:apikey:<providerId>`）。
   * 写入必须成功返回后，调用方才允许把文件里的明文替换为该引用（见迁移的非破坏性约束）。
   */
  save(providerId: string, apiKey: string): Promise<string>;

  /**
   * 删除引用对应的凭据条目（安全加固 P1-5 回归修复：引用消失即清理）。
   * 必须幂等：条目不存在时为无操作、不抛错——provisioning 的 credential 回滚与
   * 写入漏斗的孤儿清理可能对同一引用各删一次。调用方只在文件已提交新状态之后调用，
   * 保证最坏情况是留下孤儿条目（非破坏），绝不出现「引用还在、真值先没」的丢 Key 状态。
   */
  delete(credentialRef: string): Promise<void>;
}

/** 凭据库引用键的命名空间，与 CLI 既有 `standaloneAccountProviderCredentialKey` 风格一致。 */
export function providerApiKeyCredentialKey(providerId: string): string {
  return `provider:apikey:${providerId}`;
}

function isApiKeyAccess(
  access: ProviderConfig["access"],
): access is ApiKeyAccessConfig {
  return access instanceof ApiKeyAccessConfig;
}

/**
 * 把 `ProviderConfigMap` 里每个「有 credentialRef 但无明文 apiKey」的 BYO provider，
 * 经凭据库 hydrate 回明文 apiKey，返回**新的** map（不改入参，遵守其冻结/不可变约定）。
 *
 * 唯一调用点是 `ProviderRegistryService.#runRefreshLoop`（已异步），在同步的
 * `#resolver.resolve(...)` 之前。因此 registry 及其下游约 39 处同步读 `access.apiKey`
 * 的消费者拿到的都是明文真值，无需改动。
 *
 * **安全/健壮性约束**：
 * - 未注入 vault → 原样返回（安全空操作）。
 * - 某 provider 的 `vault.load` 返回 null 或抛错 → 保留其原 access（可能含残留明文 apiKey），
 *   **绝不**因为一个 provider 的凭据问题让整个 registry 刷新失败或把 apiKey 置空。
 *   这保证「凭据库暂时不可用」时用户的 provider 不会当场失效（明文回退兼容）。
 * - 只有「有 ref 且当前无明文 apiKey」才需要 hydrate；已经有明文的（迁移前/回退态）跳过。
 */
export async function hydrateProviderConfigCredentialRefs(
  providers: ProviderConfigMap,
  vault: ProviderApiKeyVault | undefined,
): Promise<ProviderConfigMap> {
  if (!vault) {
    return providers;
  }

  const rules = providers.rules();
  // 先筛出确实需要 hydrate 的规则，避免对整张表做无谓的 await。
  const pending = rules.filter((rule) => {
    const access = rule.config.access;
    if (!isApiKeyAccess(access)) return false;
    const hasRef = typeof access.credentialRef === "string" && access.credentialRef.trim().length > 0;
    const hasKey = typeof access.apiKey === "string" && access.apiKey.trim().length > 0;
    return hasRef && !hasKey;
  });
  if (pending.length === 0) {
    return providers;
  }

  // 逐条 hydrate；单条失败不影响其它条，也不抛到刷新循环外。
  const hydratedByProviderId = new Map<string, ProviderConfig>();
  await Promise.all(
    pending.map(async (rule) => {
      const access = rule.config.access as ApiKeyAccessConfig;
      const ref = access.credentialRef as string;
      let apiKey: string | null = null;
      try {
        apiKey = await vault.load(ref);
      } catch {
        // 凭据库不可用：保留原 access（含可能的残留明文），不置空、不抛错。
        return;
      }
      if (apiKey === null || apiKey.trim().length === 0) {
        // 引用悬空（凭据被清/跨机未带）：同样保留原 access，让明文回退路径有机会生效。
        return;
      }
      hydratedByProviderId.set(
        rule.providerId,
        new ProviderConfig({
          ...rule.config,
          access: new ApiKeyAccessConfig({
            type: access.type,
            apiKey,
            // 保留 ref：内存里 apiKey 是运行期真值，ref 仍在，落盘时 toJSON() 只写 ref、不写明文。
            apiKeyManagementUrl: access.apiKeyManagementUrl,
            credentialRef: ref,
          }),
        }),
      );
    }),
  );

  if (hydratedByProviderId.size === 0) {
    return providers;
  }

  return providers.mapConfigs((config, providerId) => hydratedByProviderId.get(providerId) ?? config);
}
