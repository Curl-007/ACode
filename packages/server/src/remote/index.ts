export type {
  IRemoteBackend,
  RemoteEnvironment,
  RemoteUploadOptions,
  RemoteUploadProgress,
  StdioStream,
} from "./backend.js";
export { createRemoteBackend, type RemoteBackendOptions } from "./create-backend.js";
export { createKnownHostsTrust } from "./sshKnownHosts.js";
export { composeSSHHostKeyTrust } from "./sshAuth.js";
export {
  createManagedSSHHostKeyTrust,
  resolveManagedSSHHostKeyTrustPath,
} from "./sshManagedTrust.js";
export {
  SSHHostKeyVerificationError,
  SSHHostKeyDecisionError,
  buildSSHConnectConfig,
  createSSHHostKeyVerifier,
  normalizeSSHHostKeyFingerprint,
  type SSHConnectConfigInput,
  type SSHHostKeyChallenge,
  type SSHHostKeyChallengeHandler,
  type SSHHostKeyDecision,
  type SSHHostKeyDecisionAction,
  type SSHHostKeyResolution,
  type SSHHostKeyTrust,
  type SSHHostKeyVerificationStatus,
  type SSHConnectErrorContext,
} from "./sshAuth.js";
// 连接期提示通道与 keyboard-interactive 拒绝面（specs/ssh-prompt-mediation.md）：
// 通道抽象（host_key 第一个消费者，passphrase/otp 预留）、应答归一与 abort 闭集、
// 拒绝错误类型——Desktop 中介 UI 批次经 @acode/server/remote 公开面消费。
export {
  createSSHPromptChannel,
  createHostKeyChallengePromptHandler,
  type SSHPromptChannel,
  type SSHPromptChannelOptions,
  type SSHPromptHandler,
  type SSHPromptRequest,
} from "./sshPromptChannel.js";
export {
  isSSHPromptReplyShape,
  normalizeSSHPromptAnswerValue,
  SSH_PROMPT_ANSWER_MAX_BYTES,
  type SSHPromptAbortReason,
  type SSHPromptKind,
  type SSHPromptOutcome,
  type SSHPromptReply,
  type SSHSecretPromptKind,
} from "./sshPromptTypes.js";
export {
  classifyKeyboardInteractivePrompt,
  createKeyboardInteractiveResponder,
  describeSSHKeyboardInteractiveRefusal,
  SSHKeyboardInteractiveRefusalError,
  type SSHKeyboardInteractiveMediatorPort,
  type SSHKeyboardInteractivePromptClassification,
  type SSHKeyboardInteractiveRefusal,
  type SSHKeyboardInteractiveRefusalReason,
  type SSHKeyboardInteractiveResponder,
} from "./sshKeyboardInteractive.js";
export {
  connectRemote,
  pickRemoteRuntimeEnv,
  type ConnectOptions,
  type RemoteConnection,
  type RemoteRuntimeNetworkOptions,
  type RemoteRuntimeEnv,
  type RemoteRuntimeEnvKey,
} from "./connect.js";
export { deployServer, type DeployLockMode, type DeployOptions } from "./deploy.js";
export type { RemoteAssetNetworkPort } from "./remoteAssetNetwork.js";
export { wrapStdioStream } from "./stdio-socket.js";
export { performHandshake, type HandshakeResult } from "./handshake.js";
export { DockerBackend } from "./docker-backend.js";
export {
  isDockerAvailable,
  listDockerContainers,
  parseDockerContainerList,
  type DockerContainerInfo,
} from "./docker-detect.js";
export { WSLBackend } from "./wsl-backend.js";
export {
  isWSLAvailable,
  listWSLDistros,
  type WSLDistro,
  parseWSLDistroList,
} from "./wsl-detect.js";
