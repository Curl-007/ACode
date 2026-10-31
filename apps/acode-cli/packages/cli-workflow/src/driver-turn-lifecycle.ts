// ============================================================
// AgentRuntime-backed WorkflowDriver：turn 生命周期（时序 1-3 的后半）
// ============================================================
// workflow-driver.ts 偿还 W1-R3 max-lines 例外：把 turn 派发之后的全部分支——resolve 时的观察回报与
// 交换结算、reject 时的取消判定与模型侧收容——拆到本文件成自由函数；driver 类上只留一处入口。
// 公开面不变，仍从 workflow-driver.ts 导出（工厂留在原文件）。
//
// 对 driver 状态的全部触碰都经 {@link TurnLifecycleHost} 显式递进来（依赖、向上回报面、升级与模型失败两个
// 宿主面），本文件不持有任何自己的状态——原方法体逐字保留，只把 `this.` 换成 `host.`。

import type { TurnResult } from "@acode/core";
import {
  type InstanceRef,
  type WorkflowReportSink,
} from "@acode/dynamic-workflow";
import {
  withdrawSessionEscalations,
  type EscalationHost,
} from "./workflow-driver-escalation.js";
import { handleModelTurnFailure, type ModelFailureHost } from "./workflow-driver-model-failure.js";
import {
  isTurnCancelled,
  reportTurnObservations,
  toWorkflowError,
} from "./workflow-driver-helpers.js";
import {
  countSessionTranscript,
  journalAskMessageBoundary,
} from "./workflow-driver-transcript.js";
import type { AgentRuntimeWorkflowDriverDeps, SessionState } from "./workflow-driver-types.js";

/**
 * driver 交给 turn 生命周期的宿主面：依赖、向上回报面、以及按引用共享的两个宿主对象。
 */
export interface TurnLifecycleHost {
  readonly deps: AgentRuntimeWorkflowDriverDeps;
  readonly escalationHost: EscalationHost;
  readonly modelFailureHost: ModelFailureHost;
  readonly sink: WorkflowReportSink;
}

/**
 * 派发一轮 turn（原 {@link AgentRuntimeWorkflowDriver.runTurn} 方法体）。fire-and-forget：
 * promise 挂在 state.turn 上，结算/静默账在别处读它。
 */
export function runActorTurn(
  host: TurnLifecycleHost,
  state: SessionState,
  instance: InstanceRef,
  input: string,
  epilogueStart: number,
): void {
  const abortSignal = state.abortController?.signal;
  state.turnGeneration++;
  state.turn = state.runtime
    .executeTurn(input, undefined, {
      ...(abortSignal ? { abortSignal } : {}),
      epilogueStart,
    })
    .then(
      (result) => onTurnResolved(host, state, instance, result),
      (error) => onTurnRejected(host, state, instance, error),
    );
}

/**
 * turn resolve 时的两条路径（原 {@link AgentRuntimeWorkflowDriver.onTurnResolved} 方法体）。
 */
function onTurnResolved(
  host: TurnLifecycleHost,
  state: SessionState,
  instance: InstanceRef,
  result: TurnResult,
): void {
  // 一次 turn 解析的两条回报（进度先于用量），顺序与载荷都在 reportTurnObservations 里。
  reportTurnObservations(host.sink, state, instance, result);
  if (host.deps.actorTranscriptStore === undefined) {
    // 无转录存取面：原样的同步路径，一个 await 都不多欠（边界记账整体缺席，见 deps 字段注释）。
    reportTurnOutcome(host, state, instance, result);
    return;
  }
  void settleExchange(host, state, instance, result);
}

/**
 * 报告一个 turn 的终局，并回答「这次 ask 的交换到此为止了吗」。
 *
 * accept 之外只有一条路：把最终文本交给引擎（typed → nudge 或耗尽失败；untyped → 据此结算）。
 * nudge 时引擎会在**本调用栈内**经 respondToSubmit 起一轮全新 turn，于是 turnGeneration 变了——
 * 那正是"交换尚未结束"的判据（repair 轮不在此列：它们在同一个 turn 里，本方法根本不会被调用）。
 */
function reportTurnOutcome(
  host: TurnLifecycleHost,
  state: SessionState,
  instance: InstanceRef,
  result: TurnResult,
): boolean {
  // 已提交并被引擎 accept：ask 已结算，turn 结束只是确认，不再上报 askTurnEnded。
  if (state.accepted) return true;
  const generation = state.turnGeneration;
  host.sink.askTurnEnded(instance, result.response);
  return state.turnGeneration === generation;
}

/**
 * 一次交换的收尾：数消息 → 报终局 → 交换真的结束了就把边界写进 ask 的 journal 行。
 *
 * **先数后报**，顺序是载荷性的：报出去之后引擎可能立刻在同一个会话上派发这个 actor 的下一个
 * ask（per-actor FIFO 只保证串行，不保证之间有空隙），那一轮的消息会落进同一个会话，把本次
 * 计数撑大。先数下来，读到的就是这次交换结束那一刻的长度。
 */
async function settleExchange(
  host: TurnLifecycleHost,
  state: SessionState,
  instance: InstanceRef,
  result: TurnResult,
): Promise<void> {
  const boundary = await countSessionTranscript(host.deps, state, instance);
  const ended = reportTurnOutcome(host, state, instance, result);
  if (!ended || boundary === undefined) return;
  journalAskMessageBoundary(host.deps, state, instance, boundary);
}

/**
 * turn reject 时的收容（原 {@link AgentRuntimeWorkflowDriver.onTurnRejected} 方法体）。
 */
function onTurnRejected(
  host: TurnLifecycleHost,
  state: SessionState,
  instance: InstanceRef,
  error: unknown,
): void {
  // turn 死了就没有人再读工具结果了：停驻中的升级问答必须一并撤下，否则它们会永远留在
  // 快照的 pendingQuestions 里，请主代理去回答一个没有听众的问题。
  withdrawSessionEscalations(host.escalationHost, state);
  if (state.cancelled || isTurnCancelled(error)) {
    // 引擎发起的取消（abort）：引擎已结算该 ask，driver 不重复上报。
    return;
  }
  // 模型侧错误的收容住在 workflow-driver-model-failure.ts（策略表判 stop / context_exceeded /
  // 瞬态重驱）；不是模型层错误才是 driver 侧失败。
  if (handleModelTurnFailure(host.modelFailureHost, state, instance, error)) return;
  host.sink.askFailed(instance, toWorkflowError(error));
}
