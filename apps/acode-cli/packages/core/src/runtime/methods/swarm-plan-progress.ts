import {
  SessionEventType,
  type SwarmPlanProgressPayload,
  type TraceContext,
} from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";

/**
 * 把一条 swarm plan 提交投影事件追加到**父会话**（plan 自己没有会话）。
 * specs/swarm-observability-projection.md R6：照 recordDynamicWorkflowRunProgress 的
 * 同款纪律——出回合追加（提交可能发生在父回合执行中或空闲时，两种都必须落地）、
 * `rootTraceContext`（turnId 为空，事件属于 plan、不冒领任何一轮；冷恢复的 merge
 * 不会把它插回某一轮的尾部）。
 *
 * 事件源在 bootstrap 的 swarm-plan-runtime（onChange 观测口），那一层拿不到
 * AgentRuntimeInternal，所以需要这个公共方法；同形先例是 recordDynamicWorkflowRunProgress
 * 与 recordTargetChanged。
 *
 * 本方法**不吞错**（与 dwf 同款）：R8 的「投影永不反噬图」由调用方（onChange 发射点）
 * catch + warn 落实——错误属于观察面，plan-store 的提交事务已经在此之前完成。
 */
export async function recordSwarmPlanProgress(
  this: AgentRuntimeInternal,
  input: SwarmPlanProgressPayload & { traceContext?: TraceContext },
): Promise<void> {
  const { traceContext: provided, ...payload } = input;
  const traceContext = provided ?? this.rootTraceContext;
  await this.appendEvent(
    this.createEvent(
      SessionEventType.SwarmPlanProgress,
      payload satisfies SwarmPlanProgressPayload,
      traceContext,
    ),
    traceContext,
  );
}
