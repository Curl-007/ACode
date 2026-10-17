// 跨回合临时性故障自动恢复（specs/turn-auto-resume.md）模块出口。
// 引擎（classifier/coordinator/injector/status-event/runtime-api）只被 core runtime
// 接线消费；command 面（解析/回执/host 工厂）经 @acode/core 公开入口给 cli 与
// bootstrap v4 handler leaf 复用。
export * from "./types.js";
export {
  classifyAutoResumeFailure,
  isAutoResumeBudgetResultType,
  settlementClassification,
} from "./classifier.js";
export {
  AutoResumeCoordinator,
  computeAutoResumeBackoffDelayMs,
  defaultAutoResumeTimerScheduler,
} from "./coordinator.js";
export type {
  AutoResumeCoordinatorDeps,
  AutoResumeCoordinatorLog,
  AutoResumeTimerHandle,
  AutoResumeTimerScheduler,
} from "./coordinator.js";
export { AUTO_RESUME_CONTINUE_PROMPT, buildAutoResumeContinueText } from "./prompt.js";
export {
  buildAutoResumeInjectionOptions,
  buildAutoResumeInjectionPrompt,
  runAutoResumeInjection,
} from "./injector.js";
export { emitAutoResumeScheduledStatus } from "./status-event.js";
export {
  abortAutoResumeChain,
  applyAutoResumeCommand,
  disposeAutoResumeCoordinator,
  getAutoResumeCoordinator,
  getAutoResumeStatus,
  installAutoResumeRuntimeMethods,
  notifyAutoResumeTurnFailure,
  notifyAutoResumeTurnSettled,
  notifyAutoResumeUserInputAdmitted,
} from "./runtime-api.js";
export {
  AUTO_RESUME_MAX_MESSAGE_LENGTH,
  AUTO_RESUME_MAX_PAUSE_MS,
  createAutoResumeCommandHost,
  formatAutoResumeAppliedReceipt,
  formatAutoResumeDuration,
  formatAutoResumeStatusReceipt,
  handleAutoResumeCommand,
  normalizeAutoResumeLocale,
  parseAutoResumeCommand,
  parseAutoResumeDuration,
} from "./command.js";
export type {
  AutoResumeCommandAppLike,
  AutoResumeCommandHost,
  AutoResumeCommandIntent,
  AutoResumeCommandOutcome,
  AutoResumeCommandParseResult,
  AutoResumeDurationParseResult,
  AutoResumeLocale,
} from "./command.js";
