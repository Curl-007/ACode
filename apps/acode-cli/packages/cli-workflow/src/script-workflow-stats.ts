// ============================================================
// ScriptWorkflowRuntime：用量统计的收集、入账与实时投影（R1/R2/R5 系列）
// ============================================================
// script-workflow-runtime.ts 偿还 W1-R3 max-lines 例外：把「会话用量收集 → run 累计入账 →
// 观察投影 → 不完整登记」这整条链拆到本文件。对 store / statsWrites / ownerFacts 的全部触碰经
// {@link ScriptWorkflowStatsHost} 显式递进来；原方法体逐字保留（仅 `this.` → `host.`）。公开类形状不变。
//
// 依赖方向（无运行时环）：run-body → 本文件（函数），run-agent → 本文件（函数），
// 本文件 → session-store.port（类型 + 函数）。
// statsWrites 的串行化链注释随迁本文件（它描述的正是本文件的写入链）。
//
// 依赖注入：收集与登记函数只经 {@link ScriptWorkflowStatsHost} 接触 runtime 状态；
// 主类构造时构造一个满足本接口的宿主对象传入（与主类的 host 共享同一批引用）。

import { emptyScriptWorkflowStats } from "./script-workflow-format.js";
import { collectScriptWorkflowSessionStats, isRecord, serializeError } from "./script-workflow-utils.js";
import type { SessionId } from "@acode/contracts";
import type { ScriptWorkflowRuntimeDeps } from "./script-workflow-runtime-deps.js";
import type { ScriptWorkflowRunStats, ScriptWorkflowStorePort } from "@acode/contracts";

/** 统计面经此接触 runtime 的私有状态：累计写入链、store 窄化、事件追加与 run 行的所有权列。 */
export interface ScriptWorkflowStatsHost {
  /** 事件追加（与 run 编排共用同一个实现，观察投影纪律见 script-workflow-run-body.ts）。 */
  appendEvent(runId: string, type: string, payload?: unknown): Promise<void>;
  readonly deps: ScriptWorkflowRuntimeDeps;
  /** run 行的所有权列（D3/R4 的写时事实；可能为空对象）。 */
  ownerFacts(): { ownerGeneration: number; ownerToken: string } | Record<string, never>;
  readonly statsWrites: Map<string, Promise<void>>;
  store(): ScriptWorkflowStorePort;
}

/** 按会话聚合子代理的用量统计（原 collectSessionStats 方法体）。 */
export async function collectSessionStats(
  deps: ScriptWorkflowRuntimeDeps,
  sessionId: SessionId,
): Promise<ScriptWorkflowRunStats> {
  return collectScriptWorkflowSessionStats(deps.sessionStore, sessionId, emptyScriptWorkflowStats);
}

/**
 * 入账及实时投影的串行化链，按 runId 各一条（原类内字段注释随迁）。
 *
 * SQLite 事务负责 durable 统计及 activity 幂等；这里让每笔提交后的累计用量投影有序，
 * 避免并发 agent 的观察通知晚到后把卡片里的 token 总量改回旧值。
 *
 * 链只串行同一 run；不同 run 互不阻塞。清理点与 agentCallCounts 同一个（run 结算），
 * 否则长会话里每个 run 漏一条 Map 项——那条注释里记的正是同款 bug。
 */

/** 把一笔 activity 用量排进该 run 的串行写链（原 addRunStatsForActivity 方法体）。 */
export function addRunStatsForActivity(
  host: ScriptWorkflowStatsHost,
  runId: string,
  delta: ScriptWorkflowRunStats,
  activityId: string,
): Promise<void> {
  const previous = host.statsWrites.get(runId) ?? Promise.resolve();
  const next = previous.then(() => writeRunStatsForActivity(host, runId, delta, activityId));
  return trackStatsWrite(host, runId, next);
}

function trackStatsWrite(
  host: ScriptWorkflowStatsHost,
  runId: string,
  next: Promise<void>,
): Promise<void> {
  // 链上存的是吞掉失败的版本：一次写失败不该把这条 run 后续所有的写都堵死。
  // 调用方拿到的仍是会 reject 的 `next`（runAgent 在 try/catch 里 await 它）。
  host.statsWrites.set(
    runId,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

async function writeRunStatsForActivity(
  host: ScriptWorkflowStatsHost,
  runId: string,
  delta: ScriptWorkflowRunStats,
  activityId: string,
): Promise<void> {
  const run = await host.store().recordScriptWorkflowActivityUsage({
    activityId,
    delta,
    eventId: `workflow_event_${crypto.randomUUID()}`,
    runId,
    ...host.ownerFacts(),
  });
  // SQLite 同一事务提交累计值与 activityId 账本；重试只读回原值。这里仅做观察投影，
  // 失败不会改变 activity 终态，亦不会重新累计已经持久化的真实用量。
  try {
    host.deps.progressAdapter?.onEvent({
      payload: { spentTokens: run.budgetSpent },
      runId,
      type: "workflow_usage",
    });
  } catch (error) {
    host.deps.logger?.warn?.("Script workflow usage projection failed", {
      error: error instanceof Error ? error.message : String(error),
      event: "workflow.usage.projection_failed",
      module: "bootstrap.workflow",
      runId,
      spentTokens: run.budgetSpent,
    });
  }
}

/** 登记一笔用量结算未完成的标记（原 markUsageIncomplete 方法体）。 */
export async function markUsageIncomplete(
  host: ScriptWorkflowStatsHost,
  runId: string,
  activityId: string,
  result: unknown,
  error: unknown,
): Promise<void> {
  await host.store().updateScriptWorkflowActivity({
    id: activityId,
    result: {
      ...(isRecord(result) ? result : {}),
      usageAccounting: { error: serializeError(error), status: "incomplete" },
    },
  });
  try {
    await host.appendEvent(runId, "workflow_usage_incomplete", { activityId });
  } catch (eventError) {
    // result 标记已经落盘，是冷恢复的真值；通知写入失败不能再次失败结算已完成的 activity。
    host.deps.logger?.warn?.("Script workflow usage incomplete event failed", {
      activityId,
      error: eventError instanceof Error ? eventError.message : String(eventError),
      event: "workflow.usage.incomplete_event_failed",
      module: "bootstrap.workflow",
      runId,
    });
  }
}
