/**
 * CLI 侧凭据 cipher（`@acode/adapters/auth`）。
 *
 * 安全加固 P0-4：此前这里独立实现了一份与 `@acode/services` 完全等价的 AES-256-GCM cipher，
 * 密钥同样为可离线推导的 `sha256("acode-credential-fallback:{platform}:{homedir}:{username}")`。
 * 现改为委托 `@acode/shared/node` 的单一实现，密钥来源改为每安装随机 / env / 显式
 * （见 `packages/shared/src/node/credentialMasterKey.ts`），新写入一律 `enc:v2:`，
 * 历史 `enc:v1:` 仍可解密以保证升级不丢凭据。
 *
 * 保留本文件与既有导出名，使 `shared-credentials.ts`、`auth-login.ts`、`mcp/index.ts`
 * 等调用点无需改动。
 */
export type {
  ACodeCredentialCipher,
  CreateACodeCredentialCipherOptions as ACodeCredentialCipherOptions,
} from "@acode/shared/node";
export { createACodeCredentialCipher, isEncryptedACodeCredentialValue } from "@acode/shared/node";
