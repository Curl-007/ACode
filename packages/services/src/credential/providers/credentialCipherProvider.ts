import {
  createACodeCredentialCipher,
  type ACodeCredentialCipher,
  type CreateACodeCredentialCipherOptions,
} from "@acode/shared/node";

/**
 * 凭据加密 provider（`@acode/services` 侧）。
 *
 * 安全加固 P0-4：此前这里独立实现了一份 AES-256-GCM cipher，密钥为可离线推导的
 * `sha256("acode-credential-fallback:{platform}:{homedir}:{username}")`。现改为委托
 * `@acode/shared/node` 的单一实现——与 CLI 侧 `adapters/auth/credential-cipher.ts`
 * 收敛到同一处，密钥来源改为每安装随机 / env / 显式（见 `credentialMasterKey.ts`）。
 *
 * 保留本文件与既有导出名，使 `credentialService.ts`、`providerProvisioningSource.ts`
 * 等调用点无需改动。
 */

export interface CredentialCipherProvider extends ACodeCredentialCipher {}

export interface CredentialCipherProviderOptions extends CreateACodeCredentialCipherOptions {}

export function createCredentialCipherProvider(
  options: CredentialCipherProviderOptions = {},
): CredentialCipherProvider {
  return createACodeCredentialCipher(options);
}
