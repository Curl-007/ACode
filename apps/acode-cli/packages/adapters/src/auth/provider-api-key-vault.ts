import { providerApiKeyCredentialKey, type ProviderApiKeyVault } from "@acode/provider";
import type { SharedACodeCredentialStore } from "./shared-credentials.js";

/**
 * 用 CLI 的 `SharedACodeCredentialStore` 实现 `ProviderApiKeyVault`（安全加固 P1-5）。
 *
 * CLI 侧的注入实现。与桌面 host 的 `createCredentialServiceApiKeyVault` 对应——两者底层都是
 * 同一份 `~/.acode/v2/credentials.json`，且都用 `providerApiKeyCredentialKey(providerId)` 生成
 * **确定性**引用键。这一点是跨进程正确性的前提：桌面写入的 `credentialRef`，CLI 必须能用同一个
 * 键读回明文，否则用户在桌面配置的 BYO Provider 会在 TUI/Agent 里静默失效。
 */
export function createSharedCredentialStoreApiKeyVault(
  credentialStore: SharedACodeCredentialStore,
): ProviderApiKeyVault {
  return {
    async load(credentialRef: string): Promise<string | null> {
      return credentialStore.load(credentialRef);
    },
    async save(providerId: string, apiKey: string): Promise<string> {
      const credentialRef = providerApiKeyCredentialKey(providerId);
      await credentialStore.save(credentialRef, apiKey);
      return credentialRef;
    },
    async delete(credentialRef: string): Promise<void> {
      // SharedACodeCredentialStore.delete 对不存在的键是无操作，天然满足接口的幂等要求。
      await credentialStore.delete(credentialRef);
    },
  };
}
