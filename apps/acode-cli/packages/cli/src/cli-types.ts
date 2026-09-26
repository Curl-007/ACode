import type { TuiReadClipboardImage, TuiWriteClipboardText } from "@acode/tui";
import type { UiLocale } from "@acode/i18n";
import type { Logger } from "@acode/contracts";
import type {
  createManagedCdpBrowserRuntime,
  ManagedCdpBrowserRuntimeOptions,
} from "@acode/adapters/browser";
import type {
  createModelAdapter,
  createACodeApp,
  CreateModelAdapterOptions,
  configureCodingPlanApiKey,
  ConfigureCodingPlanApiKeyOptions,
  inspectACodeSkill,
  inspectWorkspaceHookTrust,
  grantWorkspaceHookTrust,
  revokeWorkspaceHookTrustCli,
  inspectACodeCustomCommand,
  InspectACodeCustomCommandOptions,
  InspectACodeSkillOptions,
  loginACodeCli,
  loginBigmodelCodingPlan,
  LoginBigmodelCodingPlanOptions,
  LoginACodeCliOptions,
  listACodeCustomCommands,
  ListACodeCustomCommandsOptions,
  loadACodeCustomCommand,
  listACodeSessions,
  listACodeSkills,
  ListACodeSessionsOptions,
  ListACodeSkillsOptions,
  logoutACodeCli,
  LogoutACodeCliOptions,
  resolveLatestSession,
  ResolveLatestSessionOptions,
  RunACodeProtocolAgentOptions,
  startProcessProviderRegistryRuntime,
  ACodeAppOptions,
} from "@acode/bootstrap";
import type { CliEnv, DotenvLoadResult, LoadCliDotenvOptions } from "./env.js";
import type { PluginsCommandOverrides } from "./plugins-command.js";
import type { CliShutdownProcess } from "./shutdown.js";
import type { resolveWorkspaceGitBranch } from "./tui-workspace-git.js";

export type BootstrapModule = typeof import("@acode/bootstrap");

export interface RunDependencies extends PluginsCommandOverrides {
  protocolLifecycle?: RunACodeProtocolAgentOptions["lifecycle"];
  protocolInput?: NodeJS.ReadableStream;
  createManagedCdpBrowserRuntime?: (
    options?: ManagedCdpBrowserRuntimeOptions,
  ) => ReturnType<typeof createManagedCdpBrowserRuntime>;
  createModelAdapter?: (
    options?: CreateModelAdapterOptions,
  ) => ReturnType<typeof createModelAdapter>;
  createACodeApp?: (
    options?: ACodeAppOptions,
  ) => Awaited<ReturnType<typeof createACodeApp>> | ReturnType<typeof createACodeApp>;
  /**
   * Session-event shaper for --output-format stream-json. Defaults to the
   * bootstrap module's, which is also what the protocol server uses; injectable
   * so a caller that supplies its own `createACodeApp` (tests, embedders) can
   * still stream, since the bootstrap module is not loaded on that path.
   */
  mapSessionEvent?: BootstrapModule["mapSessionEvent"];
  cwd?: () => string;
  env?: CliEnv;
  inspectSkill?: (options: InspectACodeSkillOptions) => ReturnType<typeof inspectACodeSkill>;
  inspectWorkspaceHookTrust?: typeof inspectWorkspaceHookTrust;
  grantWorkspaceHookTrust?: typeof grantWorkspaceHookTrust;
  revokeWorkspaceHookTrustCli?: typeof revokeWorkspaceHookTrustCli;
  inspectCustomCommand?: (
    options: InspectACodeCustomCommandOptions,
  ) => ReturnType<typeof inspectACodeCustomCommand>;
  loginACodeCli?: (options?: LoginACodeCliOptions) => ReturnType<typeof loginACodeCli>;
  loginBigmodelCodingPlan?: (
    options?: LoginBigmodelCodingPlanOptions,
  ) => ReturnType<typeof loginBigmodelCodingPlan>;
  configureCodingPlanApiKey?: (
    options: ConfigureCodingPlanApiKeyOptions,
  ) => ReturnType<typeof configureCodingPlanApiKey>;
  loadDotenv?: (options?: LoadCliDotenvOptions) => DotenvLoadResult;
  projectConfigPath?: string;
  listSessions?: (options: ListACodeSessionsOptions) => ReturnType<typeof listACodeSessions>;
  listCustomCommands?: (
    options: ListACodeCustomCommandsOptions,
  ) => ReturnType<typeof listACodeCustomCommands>;
  loadCustomCommand?: (
    options: InspectACodeCustomCommandOptions,
  ) => ReturnType<typeof loadACodeCustomCommand>;
  // headless slash 路由要和 app facade 的保留名 gate 用同一个判据；默认取 bootstrap 的，
  // 注入点只为让单测不必拉起整个 bootstrap 模块。见 prompt-command.ts。
  isReservedSlashCommandName?: BootstrapModule["isReservedACodeSlashCommandName"];
  listSkills?: (options: ListACodeSkillsOptions) => ReturnType<typeof listACodeSkills>;
  logger?: Logger;
  readClipboardImage?: TuiReadClipboardImage;
  writeClipboardText?: TuiWriteClipboardText;
  resolveLatestSession?: (
    options: ResolveLatestSessionOptions,
  ) => ReturnType<typeof resolveLatestSession>;
  resolveWorkspaceGitBranch?: typeof resolveWorkspaceGitBranch;
  logoutACodeCli?: (options?: LogoutACodeCliOptions) => ReturnType<typeof logoutACodeCli>;
  runACodeProtocolAgent?: (options?: RunACodeProtocolAgentOptions) => Promise<void>;
  runTui?: typeof import("@acode/tui").runTui;
  skipUserConfig?: boolean;
  userConfigPath?: string;
  exitProcess?: (code: number) => void;
  shutdownCleanupTimeoutMs?: number;
  shutdownProcess?: CliShutdownProcess;
  startProcessProviderRegistryRuntime?: typeof startProcessProviderRegistryRuntime;
}

export type CliPermissionMode = "build" | "plan" | "edit" | "yolo";
export type CliRuntimeMode = CliPermissionMode | "auto";

export interface CliModeState {
  current?: CliRuntimeMode;
  override?: CliPermissionMode;
}

export interface CliTargetRequest {
  objective: string;
  replaceExisting: boolean;
}

export type ModeCapableApp = Awaited<ReturnType<typeof createACodeApp>> & {
  getMode?: () => CliRuntimeMode;
  setLocale?: (locale: UiLocale) => Promise<{ locale: "en-US" | "zh-CN" }>;
  setMode?: (mode: CliRuntimeMode) => Promise<{ mode: CliRuntimeMode }>;
};

export interface CliResumeRequest {
  continueSession: boolean;
  resumeSessionId?: string;
}
