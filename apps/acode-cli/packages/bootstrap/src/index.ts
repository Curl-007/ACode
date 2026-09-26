// Bootstrap public API surface.

export * from "./app/create-app.js";
export type {
  ListACodeSessionsOptions,
  PromptInput,
  ResolveLatestSessionOptions,
  ResumeOptions,
  RunACodeProtocolAgentOptions,
  SendInputOptions,
  SendInputResult,
  SetLocaleResult,
  SteerTurnOptions,
  SubmitPromptOptions,
  UserPromptInput,
  ACodeApp,
  ACodeAppOptions,
  ACodeModelOption,
} from "./app/types.js";
export * from "./auth-login.js";
export {
  inspectACodeCustomCommand,
  listACodeCustomCommands,
  loadACodeCustomCommand,
} from "./custom-commands.js";
export type {
  InspectACodeCustomCommandOptions,
  ListACodeCustomCommandsOptions,
  ACodeCustomCommandInspection,
} from "./custom-commands.js";
export { createModelAdapter } from "./model-factory.js";
export type { CreateModelAdapterOptions } from "./model-factory.js";
export { startProcessProviderRegistryRuntime } from "./app/process-provider-registry-runtime.js";
export type { ProcessProviderRegistryRuntimeOptions } from "./app/process-provider-registry-runtime.js";
export {
  addACodePluginMarketplace,
  getACodePluginsOverview,
  installACodeMarketplacePlugin,
  listACodePlugins,
  removeACodePluginMarketplace,
  resolveACodePlugins,
  setACodePluginEnabled,
  uninstallACodeMarketplacePlugin,
  updateACodeMarketplacePlugin,
  updateACodePluginMarketplace,
  validateACodePluginPath,
} from "./plugins.js";
export type {
  AddACodeMarketplaceOptions,
  InstallACodeMarketplacePluginOptions,
  ListACodePluginsOptions,
  RemoveACodeMarketplaceOptions,
  ResolveACodePluginsOptions,
  SetACodePluginEnabledOptions,
  SetACodePluginEnabledResult,
  UninstallACodeMarketplacePluginOptions,
  UpdateACodeMarketplaceOptions,
  UpdateACodeMarketplacePluginOptions,
  ValidateACodePluginPathOptions,
  ACodeAvailablePluginData,
  ACodeInstalledPluginData,
  ACodeMarketplaceSummaryData,
  ACodeMarketplaceUpdateData,
  ACodePluginInstallData,
  ACodePluginUpdateData,
  ACodePluginsOverviewData,
} from "./plugins.js";
export { runACodeProtocolAgent } from "./acode-protocol-entrypoint.js";
// Exposed for the CLI's --output-format stream-json: it needs the same event
// shape the protocol server emits, rather than inventing a second one.
export { mapSessionEvent } from "./acode-protocol/session-mapper.js";
export type { SessionTranscriptMessage, SessionTranscriptPart } from "./session-transcript.js";
export { listACodeSessions, resolveLatestSession } from "./sessions.js";
export { inspectACodeSkill, listACodeSkills } from "./skills.js";
export type {
  InspectACodeSkillOptions,
  ListACodeSkillsOptions,
  ACodeSkillInspection,
} from "./skills.js";
// Exposed for the CLI's headless slash routing: it must decide "is this a real
// custom command?" with the *same* reserved-name gate the app facade's
// customCommandPromptResolver applies, or the two disagree and a reserved name
// reaches the model as literal prompt text. See prompt-command.ts.
export { isReservedACodeSlashCommandName } from "./slash-command-surface.js";
export {
  grantWorkspaceHookTrust,
  inspectWorkspaceHookTrust,
  revokeWorkspaceHookTrustCli,
} from "./workspace-hook-trust-cli.js";
export type {
  WorkspaceHookTrustCliItem,
  WorkspaceHookTrustCliStatus,
  WorkspaceHookTrustCliTarget,
} from "./workspace-hook-trust-cli.js";
