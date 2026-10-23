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
// jcode-bridge（specs/jcode-agent-bridge.md R1/接口节）：外部 agent 桥接子命令复用
// host 无关的 v4 网关与 NDJSON 传输，自写瘦 dispatch 绕过 native server（server 构造
// 强依赖 createACodeApp，无 host 注入缝）。网关/传输本就不在公开面，此处按需导出。
export { ConversationV4Gateway } from "./acode-protocol-v4/v4-gateway.js";
export type { V4GatewayHost } from "./acode-protocol-v4/v4-gateway.js";
export { ACodeProtocolNdjsonConnection } from "./acode-protocol/transport.js";
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
// 项目 MCP 信任门（specs/project-mcp-trust-gate.md）：CLI `acode mcp trust` 的命令面。
export {
  grantProjectMcpTrust,
  inspectProjectMcpTrust,
  revokeProjectMcpTrustCli,
} from "./project-mcp-trust-cli.js";
export type {
  ProjectMcpTrustCliItem,
  ProjectMcpTrustCliStatus,
  ProjectMcpTrustCliTarget,
} from "./project-mcp-trust-cli.js";
