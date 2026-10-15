// 回合收尾协议（specs/turn-wrap-up.md R2/R3）：义务事实记录 + 成功收口评估。
//
// 观测先行：评估结果只落 info 日志，绝不阻塞收口、不注入 reminder、不发新事件
// （事件面闭集在本波所有权外，投影也不需要——载荷已在 toolCall row 的 input 上）。
// provider 可见的硬门 nudge 是登记的后续批次（spec §9.1），决策输入是这里的
// turn.wrapup.missing 日志违反率。
//
// 状态所有者：RegularTurnLoopState.turnWrapUp（每回合新建，收口即释放）。
// 写入点唯一：turn-tools.ts 的工具结果循环；评估点唯一：turn.ts 成功收口路径。
import { isWorkspaceMutatingToolCall, TURN_WRAP_UP_TOOL_NAME } from "@acode/contracts";
import type { ToolSideEffectScope } from "@acode/contracts";
import { traceContextToLogContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { RegularTurnLoopState, TurnWrapUpObligationState } from "./turn-loop-state.js";

/** 维护任务列表的工具（sideEffectScope=session，不落 workspace 写信号，spec R2 单列）。 */
const TURN_WRAP_UP_TODO_TOOL_NAME = "TodoWrite";

/**
 * 义务评估只适用于主对话的有人在场的轮（spec R2）：child 会话的收尾是它们自己的
 * report/submit 契约；side chat 是只读轻量通道，没有轮尾卡读者；automation/off-peak
 * 是无人值守轮，卡片没有当场读者。
 */
const TURN_WRAP_UP_EXCLUDED_TASK_TYPES: ReadonlySet<string> = new Set([
  "subagent_child",
  "workflow_child",
  "nested_workflow_child",
  "selection_side_chat",
]);

/** 义务信号工具的能力面（registry 元数据的结构子集；缺席按会改写处理，保守判义务）。 */
export interface TurnWrapUpToolCapability {
  readOnly?: boolean | undefined;
  sideEffectScope?: ToolSideEffectScope | undefined;
}

/**
 * 义务信号判别（spec R2 闭集）：TodoWrite 单列；其余按 isWorkspaceMutatingToolCall
 * 的同一份规则（写文件/git/不可证明只读的 shell；能力缺席保守视为会改写）。
 * TurnWrapUp 自身不是工作信号。
 */
export function isTurnWrapUpWorkSignalTool(
  toolName: string,
  capability: TurnWrapUpToolCapability | undefined,
): boolean {
  if (toolName === TURN_WRAP_UP_TOOL_NAME) return false;
  if (toolName === TURN_WRAP_UP_TODO_TOOL_NAME) return true;
  return isWorkspaceMutatingToolCall(capability ?? {});
}

/**
 * 工具结果循环的唯一写入点：成功失败都记工作信号（失败的写尝试也是工作上下文），
 * TurnWrapUp 只认成功结果（失败的调用没有记录任何载荷）。
 */
export function recordTurnWrapUpToolResults(
  state: RegularTurnLoopState,
  results: readonly { toolName: string; success: boolean }[],
  getToolCapability: (toolName: string) => TurnWrapUpToolCapability | undefined,
): void {
  for (const result of results) {
    if (result.toolName === TURN_WRAP_UP_TOOL_NAME) {
      if (!result.success) continue;
      const wrapUp = ensureTurnWrapUpState(state);
      wrapUp.recordedAtWorkSignalCount = wrapUp.workSignalCount;
      continue;
    }
    if (!isTurnWrapUpWorkSignalTool(result.toolName, getToolCapability(result.toolName))) {
      continue;
    }
    ensureTurnWrapUpState(state).workSignalCount += 1;
  }
}

function ensureTurnWrapUpState(state: RegularTurnLoopState): TurnWrapUpObligationState {
  state.turnWrapUp ??= { workSignalCount: 0, recordedAtWorkSignalCount: null };
  return state.turnWrapUp;
}

export type TurnWrapUpObligationOutcome = "not_required" | "recorded" | "missing" | "stale";

export interface TurnWrapUpObligationEvaluation {
  outcome: TurnWrapUpObligationOutcome;
  /** 义务是否触发（存在工作信号）；recorded/stale 都为 true，not_required 为 false。 */
  required: boolean;
  workSignalCount: number;
}

/**
 * 收口评估（纯函数）：
 * - 从未成功调用：有信号 = missing（义务违反），无信号 = not_required；
 * - 调用后又出现新信号 = stale（载荷可能过时，仍渲染最后一次成功调用）；
 * - 调用后无新信号 = recorded（义务满足；无信号的纯聊天轮主动调用也归这里，required=false）。
 */
export function evaluateTurnWrapUpObligation(
  wrapUp: TurnWrapUpObligationState | undefined,
): TurnWrapUpObligationEvaluation {
  const workSignalCount = wrapUp?.workSignalCount ?? 0;
  const recordedAt = wrapUp?.recordedAtWorkSignalCount ?? null;
  const required = workSignalCount > 0;
  if (recordedAt === null) {
    return {
      outcome: required ? "missing" : "not_required",
      required,
      workSignalCount,
    };
  }
  if (recordedAt < workSignalCount) {
    return { outcome: "stale", required, workSignalCount };
  }
  return { outcome: "recorded", required, workSignalCount };
}

/** 评估范围门（spec R2）：child/side-chat 会话与无人值守轮不评估。 */
export function shouldEvaluateTurnWrapUpObligation(
  runtime: Pick<AgentRuntimeInternal, "config">,
  state: RegularTurnLoopState,
): boolean {
  const taskType = runtime.config.taskType;
  if (taskType !== undefined && TURN_WRAP_UP_EXCLUDED_TASK_TYPES.has(taskType)) return false;
  if (state.automationId?.trim()) return false;
  if (state.offPeakTaskId?.trim()) return false;
  return true;
}

/**
 * turn.ts 成功收口路径的唯一评估点：只落日志（不落载荷原文——recap/nextStep 可能
 * 复述用户内容；status 键只用保留闭集值）。not_required 不产生日志（零信号轮是常态，
 * 不落噪声）。
 */
export function logTurnWrapUpObligationOutcome(
  runtime: AgentRuntimeInternal,
  state: RegularTurnLoopState,
): void {
  if (!shouldEvaluateTurnWrapUpObligation(runtime, state)) return;
  const evaluation = evaluateTurnWrapUpObligation(state.turnWrapUp);
  if (evaluation.outcome === "not_required") return;
  runtime.logger?.info("Turn wrap-up obligation outcome", {
    ...traceContextToLogContext(state.turnTraceContext),
    event: `turn.wrapup.${evaluation.outcome}`,
    module: "core.runtime",
    status: "completed",
    obligationRequired: evaluation.required,
    workSignalCount: evaluation.workSignalCount,
  });
}
