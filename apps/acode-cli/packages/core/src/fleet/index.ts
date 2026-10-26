// ============================================================
// Fleet Module - 会话舰队（agent 可管理的并行会话工具族）的机制层
// apps/acode-cli/specs/session-fleet.md
// ============================================================
// 所有权与生命周期事实的唯一所有者（registry）+ 模式裁决（mode-policy）+
// 回合报告 note（notes）+ worktree provision/重键（worktree-provision）+
// launch 编排（session-launch）+ 归档级联（archive）+ 列表投影（projection）。
// 工具 handler 只做契约投影与上下文取数，机制全部在这里。

export {
  FleetRegistry,
  getFleetRegistry,
  resetFleetRegistryForTest,
  type FleetOwnershipFailure,
  type FleetOwnershipResolution,
  type FleetReportNote,
  type FleetSessionRecord,
  type FleetWorktreeFact,
} from "./registry.js";
export {
  buildFleetModeEntry,
  isFleetModeEscalation,
  resolveFleetLaunchMode,
  resolveFleetModeBinding,
  resolveLauncherEffectiveMode,
  type FleetLaunchModeDecision,
} from "./mode-policy.js";
export {
  extractFleetReportText,
  subscribeFleetReportBack,
  type FleetNoteWatcherDeps,
} from "./notes.js";
export {
  adoptFleetWorktreeForChild,
  provisionFleetWorktree,
  releaseFleetWorktreeProvision,
  type FleetWorktreeDeps,
  type FleetWorktreeProvision,
  type FleetWorktreeProvisionResult,
} from "./worktree-provision.js";
export {
  FLEET_PLAN_VESSEL_AGENT_TYPE,
  FLEET_IDENTITY_PREAMBLE,
  FLEET_SESSION_NAME_MAX_CHARS,
  buildFleetChildFirstMessage,
  buildFleetSessionName,
  launchFleetSession,
  type FleetLaunchContext,
  type FleetLaunchInput,
  type FleetLaunchResult,
  type FleetSpawnSlotGate,
} from "./session-launch.js";
// WI-E4（specs/cli-governor.md）：内存压力会话治理——机制在 runtime/cli-governor，
// 舰队组合面（单例/驱逐端口懒接/LRU peek/per-App deps 注册表）在这里。
export {
  attachCliGovernorEvictionPort,
  configureCliGovernor,
  getCliGovernor,
  peekFleetLruIdleVictim,
  registerCliGovernorAppDeps,
  resetCliGovernorForTest,
  type CliGovernorEvictionPort,
  type FleetGovernorDeps,
} from "./governor.js";
// 批 2 R11：own_initiative 提案卡（预算/判重/过期纯规则；存储归 registry）。
export {
  FLEET_PROPOSAL_MAX_PER_TURN,
  FLEET_PROPOSAL_TTL_MS,
  buildFleetProposal,
  evaluateFleetProposalAdmission,
  isFleetProposalExpired,
  normalizeFleetProposalTitle,
  resolveFleetProposalForLaunch,
  type FleetProposalRecord,
  type FleetProposalRejection,
} from "./proposals.js";
export {
  executeFleetArchive,
  isFleetSessionRunning,
  resolveFleetArchivePlan,
  type FleetArchiveDeps,
  type FleetArchiveExecutionDeps,
  type FleetArchivePlan,
} from "./archive.js";
export {
  buildFleetListRows,
  projectFleetPermissionMode,
  projectFleetSessionStatus,
  type FleetListProjectionInput,
} from "./projection.js";
