export { resolveEffectiveBashShellSelection } from "./bash-shell-provider.js";
export {
  EXEC_HIJACK_CODE_INJECTION_ENV_KEYS,
  EXEC_HIJACK_ENV_KEY_PREFIXES,
  EXEC_HIJACK_ENV_KEYS,
  EXEC_HIJACK_NETWORK_REDIRECT_ENV_KEYS,
  EXEC_HIJACK_SHELL_BEHAVIOR_ENV_KEYS,
  applyExecHijackEnvGuard,
  isExecHijackEnvKey,
} from "./exec-hijack-env-guard.js";
export {
  applyResolvedShellCommandForTest,
  buildExecutionEnv,
  resolveExecutionCommand,
  setResolvedShellLoginMode,
} from "./execution-command.js";
export type { ResolvedSpawnCommand } from "./execution-command.js";
export type { NodeExecutionAdapterOptions } from "./execution-adapter-types.js";
export { createNodeExecutionAdapter, NodeExecutionAdapter } from "./node-execution-adapter.js";
export { decodeExecutionOutputBuffer } from "./outputEncoding.js";
