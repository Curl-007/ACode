// 注入路径（specs/turn-auto-resume.md，形态仿 goal-continuation：target.ts 的
// wrapSystemReminderForSource → executeTurnCommand(prompt, undefined, {inputSource,
// inputVisibility:"model-only"})）。auto-resume 经 executeTurn 入口进 runtime command
// 队列，与用户输入共用同一条串行 admission。
import type { TurnBackgroundAttribution } from "@acode/contracts";
import { wrapSystemReminderForSource } from "../../system-reminder/source.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { ExecuteTurnOptions } from "../types.js";
import { buildAutoResumeContinueText } from "./prompt.js";
import type { AutoResumeInjectionPlan } from "./types.js";

/**
 * 安全红线（specs/turn-auto-resume.md「无人值守标记透传」）：automation/off-peak turn
 * 失败后的注入 turn 必须携带原 turn 的 automationId/offPeakTaskId（turn-loop-state 的
 * isAutomationMutationRestrictedTurn / isOffPeakCreateRestrictedTurn 据此继承同款
 * mutation 限制），并同批透传原 turn 的 toolDisallowlist 与 execution-scoped 模型选择——
 * auto-resume 不得把受限 turn 洗成无约束 turn，不得提升任何权限。
 */
export function buildAutoResumeInjectionOptions(input: {
  injectionContext: AutoResumeInjectionPlan["injectionContext"];
}): ExecuteTurnOptions {
  const context = input.injectionContext;
  const attribution: TurnBackgroundAttribution = context.automationId
    ? { automationId: context.automationId }
    : context.offPeakTaskId
      ? {
          offPeakTaskId: context.offPeakTaskId,
          ...(context.offPeakRunType ? { offPeakRunType: context.offPeakRunType } : {}),
        }
      : {};
  return {
    ...attribution,
    inputSource: "auto_resume",
    inputVisibility: "model-only",
    ...(context.modelExecution ? { modelExecution: context.modelExecution } : {}),
    ...(context.toolDisallowlist ? { toolDisallowlist: context.toolDisallowlist } : {}),
    traceContext: context.traceContext,
  };
}

export function buildAutoResumeInjectionPrompt(
  plan: AutoResumeInjectionPlan,
  customMessage?: string,
): string {
  return wrapSystemReminderForSource(
    "auto_resume",
    buildAutoResumeContinueText({
      count: plan.attempt,
      max: plan.maxResumes,
      ...(customMessage ? { customMessage } : {}),
    }),
  );
}

export async function runAutoResumeInjection(
  runtime: AgentRuntimeInternal,
  plan: AutoResumeInjectionPlan,
  customMessage?: string,
): Promise<void> {
  const prompt = buildAutoResumeInjectionPrompt(plan, customMessage);
  await runtime.executeTurn(
    prompt,
    undefined,
    buildAutoResumeInjectionOptions({ injectionContext: plan.injectionContext }),
  );
}
