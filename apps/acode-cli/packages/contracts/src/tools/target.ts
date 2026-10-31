// ============================================================
// Goal Tools - session-local long-running goal
// ============================================================
//
// 例外偿还（contracts-onboarding-max-file-lines-target）：本文件原为 437 行单体，
// 已拆为 2 个叶子并降级为 barrel——Goal 域核心形态在 goal-schema（含 GoalStatus，
// 原文件头部的状态词表随 SessionGoal 下沉），完成验证提示词/解析在
// goal-completion-verify；公开导出面（含下方 Target* 兼容别名）逐名不变，消费方零改动。
// 依赖单向：goal-completion-verify → goal-schema，本文件只 re-export，无叶子回边。

import type {
  GoalCompletionVerificationOutput,
  GoalReadInput,
  GoalReadOutput,
  SessionGoal,
} from "./goal-schema.js";
import type { GoalStatus as GoalStatusType } from "./goal-schema.js";
import {
  GoalStatus,
  GoalStatusSchema,
  GoalTokenBudgetSchema,
  GoalObjectiveSchema,
  SessionGoalSchema,
  GoalReadInputSchema,
  GoalReadInputJsonSchema,
  GoalReadOutputSchema,
  GoalReadOutputJsonSchema,
  GoalCompletionVerificationOutputSchema,
  MAX_GOAL_OBJECTIVE_CHARS,
  normalizeGoalObjective,
  formatGoalStateForModel,
  formatGoalContinuationPrompt,
  escapeGoalPromptText,
} from "./goal-schema.js";
import { GOAL_COMPLETION_VERIFICATION_QUERY_SOURCE } from "./goal-completion-verify.js";
import {
  formatGoalCompletionVerificationPrompt,
  formatGoalCompletionVerificationFailurePrompt,
  formatGoalCompletionVerificationPassedContent,
  parseGoalCompletionVerificationText,
  failedGoalCompletionVerification,
  failOpenGoalCompletionVerification,
} from "./goal-completion-verify.js";

// —— 叶子 re-export（`export *` 要求跨叶无重名；Goal 域符号仅在 goal-schema 定义）——
export * from "./goal-schema.js";
export * from "./goal-completion-verify.js";

// —— Target* 兼容别名（旧命名面；持久化行与 ACP wire 仍称 target）——
export const TargetStatus = GoalStatus;
export type TargetStatus = GoalStatusType;
export const MAX_TARGET_OBJECTIVE_CHARS = MAX_GOAL_OBJECTIVE_CHARS;
export const TARGET_COMPLETION_VERIFICATION_QUERY_SOURCE =
  GOAL_COMPLETION_VERIFICATION_QUERY_SOURCE;
export const TargetStatusSchema = GoalStatusSchema;
export const TargetTokenBudgetSchema = GoalTokenBudgetSchema;
export const TargetObjectiveSchema = GoalObjectiveSchema;
export type SessionTarget = SessionGoal;
export const SessionTargetSchema = SessionGoalSchema;
export const TargetReadInputSchema = GoalReadInputSchema;
export type TargetReadInput = GoalReadInput;
export const TargetReadInputJsonSchema = GoalReadInputJsonSchema;
export const TargetReadOutputSchema = GoalReadOutputSchema;
export type TargetReadOutput = GoalReadOutput;
export const TargetReadOutputJsonSchema = GoalReadOutputJsonSchema;
export const TargetCompletionVerificationOutputSchema =
  GoalCompletionVerificationOutputSchema;
export type TargetCompletionVerificationOutput =
  GoalCompletionVerificationOutput;
export const normalizeTargetObjective = normalizeGoalObjective;
export const formatTargetStateForModel = formatGoalStateForModel;
export const formatTargetContinuationPrompt = formatGoalContinuationPrompt;
export const formatTargetCompletionVerificationPrompt =
  formatGoalCompletionVerificationPrompt;
export const formatTargetCompletionVerificationFailurePrompt =
  formatGoalCompletionVerificationFailurePrompt;
export const formatTargetCompletionVerificationPassedContent =
  formatGoalCompletionVerificationPassedContent;
export const parseTargetCompletionVerificationText =
  parseGoalCompletionVerificationText;
export const failedTargetCompletionVerification =
  failedGoalCompletionVerification;
export const failOpenTargetCompletionVerification =
  failOpenGoalCompletionVerification;
export const escapeTargetPromptText = escapeGoalPromptText;
