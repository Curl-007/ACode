import { providerApiKeyCredentialKey, type ProviderApiKeyVault } from "@acode/provider";
import type { ICredentialService } from "../credential/credential.js";

/**
 * 用 `ICredentialService`（P0-4 已加固的加密凭据库）实现 `ProviderApiKeyVault`（安全加固 P1-5）。
 *
 * 桌面 host 侧的注入实现：BYO Provider 的 API Key 不再明文落 `provider_config.json`，
 * 而是以 `provider:apikey:<providerId>` 为键存进 `credentials.json`（AES-GCM，主密钥来自
 * 每安装随机密钥 / env / OS 钥匙串，见 credential-storage.md），文件里只留这个引用。
 *
 * 引用键**确定性命名**（同一 providerId 恒定映射到同一键），这保证：
 * - 迁移幂等：同一把 Key 反复 vault.save 落到同一凭据条目，不产生孤儿；
 * - revision 稳定：文件里存的是稳定字符串引用，encode 结果确定，
 *   `revision = sha256(encode(...))` 不会每次轮询都变（无写放大）。
 */
export function createCredentialServiceApiKeyVault(
  credentialService: ICredentialService,
): ProviderApiKeyVault {
  return {
    async load(credentialRef: string): Promise<string | null> {
      return credentialService.load(credentialRef);
    },
    async save(providerId: string, apiKey: string): Promise<string> {
      const credentialRef = providerApiKeyCredentialKey(providerId);
      await credentialService.save(credentialRef, apiKey);
      return credentialRef;
    },
    async delete(credentialRef: string): Promise<void> {
      // ICredentialService.delete 对不存在的键是无操作，天然满足接口的幂等要求。
      await credentialService.delete(credentialRef);
    },
  };
}
