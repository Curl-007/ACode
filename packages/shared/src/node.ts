/**
 * Node-only shared utilities.
 *
 * This subpath must not be imported by renderer/browser bundles.
 */
export { acquireFileLock } from "./node/atomicFileLock.js";
export { scanOfficialPluginCacheRoots } from "./node/officialPluginCache.js";
export {
  migrateUserSubagentMarkdown,
  migrateSubagentStateFile,
} from "./node/subagentMarkdownMigration.js";
export {
  atomicWritePrivateTextFile,
  backupCorruptFile,
  withFileLock,
  type SharedFileLockOptions,
} from "./node/privateFilePersistence.js";
export {
  assertServerAuthInvariant,
  describeNoAuthLoopbackWarning,
  fingerprintPrincipal,
  isLoopbackBindHost,
  isLoopbackHostname,
  isTokenProtectedPathname,
  isWebSocketUpgradePathname,
  parseBearerToken,
  readPresentedServerToken,
  resolveHostCapabilityBinding,
  resolveRequestOriginTrust,
  resolveServerTokenAuth,
  SERVER_LITE_TOKEN_COOKIE_NAME,
  timingSafeTokenEquals,
  type HostCapabilityBindingInput,
  type HostCapabilityBindingResult,
  type RequestOriginTrustInput,
  type RequestOriginTrustResult,
  type ServerAuthInvariantInput,
  type ServerTokenAuthResult,
  type ServerTokenRequestView,
} from "./node/serverAuth.js";
export {
  createTerminalClientCredentialGuard,
  isTerminalClientCredentialKeyAllowed,
  TERMINAL_CLIENT_CREDENTIAL_ALLOWED_KEYS,
  type CredentialChannelLike,
} from "./node/credentialChannelAccess.js";
export {
  ANONYMOUS_HOST_CAPABILITY_PRINCIPAL,
  createHostCapabilityStore,
  DEFAULT_HOST_CAPABILITY_TTL_MS,
  MAX_LIVE_HOST_CAPABILITIES,
  type HostCapabilityPrincipal,
  type HostCapabilityStore,
  type HostCapabilityStoreOptions,
} from "./node/hostCapability.js";
export {
  createACodeCredentialCipher,
  createCredentialCipherProvider,
  isEncryptedACodeCredentialValue,
  isEncryptedACodeCredentialValueV1,
  type ACodeCredentialCipher,
  type CreateACodeCredentialCipherOptions,
  type CredentialCipherProvider,
} from "./node/credentialCipher.js";
export {
  CREDENTIAL_KEY_FILE_NAME,
  CREDENTIAL_KEY_FILE_VERSION,
  CREDENTIAL_SECRET_ENV_KEY,
  resolveCredentialKeyFilePath,
  resolveCredentialMasterKey,
  type CredentialMasterKeySource,
  type ResolveCredentialMasterKeyOptions,
  type ResolvedCredentialMasterKey,
} from "./node/credentialMasterKey.js";
export {
  CREDENTIAL_KEYCHAIN_SERVICE,
  WINDOWS_DPAPI_BLOB_FILE_NAME,
  createCredentialKeychain,
  credentialKeychainAccount,
  windowsDpapiBlobPath,
  type CredentialKeychainAccess,
  type CredentialKeychainDeps,
  type CredentialKeychainReadResult,
  type CredentialKeychainWriteResult,
} from "./node/credentialKeychain.js";
export {
  ACODE_MANAGED_POLICY_FILE_ENV,
  loadManagedPolicyFile,
  resolveManagedPolicyFilePath,
  type ManagedPolicyFileData,
  type ManagedPolicyFileLoadResult,
  type ManagedPolicyFileOptions,
  type ManagedPolicyFileStatus,
  type ManagedPolicyInvalidKind,
  type ManagedPolicyRule,
} from "./node/managedPolicy.js";
