/**
 * D5 并发治理面只读诊断投影（specs/concurrency-diagnostics-projection.md）。
 *
 * 四个并发域（tool scheduler / dynamic-workflow / Plan Explore / subagent 后台）今天各自
 * 持有自己的上限事实，没有一处能回答「这个会话此刻的并发治理事实是什么」。本模块是唯一的
 * 聚合点：把四域的 `caps / current / degraded` 投影成同一个形状，供 runtime 公开只读方法
 * `getConcurrencyDiagnostics()` 与每 turn 一条的 debug 日志消费。
 *
 * 三条纪律（R2，验收红线）：
 * - **纯投影**：只读既有状态，不新增 admission 判断、不改任何调度决策、不持有跨调用状态；
 * - **缺失即未知**：端口/方法缺席时投影 "unavailable" 或 undefined，绝不猜测或伪造哨兵数字；
 * - **只写本地 debug 日志**：不进遥测通道、不落持久化存储（no-telemetry 红线）。
 *
 * 刻意否决的全局信号量统一 admission 不在这里发生——三域语义不同（turn 内 / run 级 / 会话级），
 * 统一会破坏 CommandInbox 与 owner/lease 边界（方案文档 D5 裁定，spec R0 登记）。
 */

import { traceContextToLogContext } from "../deps.js";
import type { ModelRequestAdmissionBucketSnapshot, TraceContext } from "../deps.js";
import { planResearchAgentCount } from "../helpers/runtime-reminders.js";
import { EXPLORE_AGENT_TYPE } from "../../subagent/explore.js";
import type { RuntimeTaskSnapshot } from "../../runtime-task/contract.js";
import type { AgentRuntimeInternal } from "../internal.js";

/** 四个固定域 id（spec R1）；新增域必须先改 spec 的口径表。 */
export type ConcurrencyDomainId =
  | "tool_scheduler"
  | "dynamic_workflow"
  | "plan_explore"
  | "subagent_background";

/**
 * 单域快照。`caps === undefined` 表示该域**无显式上限**（如实投影，不用 Infinity/-1 伪造）；
 * `current` 的口径按域定义（spec R3 的表是唯一权威），读面不得跨域直接比较。
 */
export interface ConcurrencyDomainSnapshot {
  caps: number | undefined;
  current: number;
  degraded: boolean;
  facts?: Record<string, unknown>;
}

export interface ConcurrencyDiagnosticsSnapshot {
  /** 投影生成时刻（runtime 注入的 now()，ms epoch）。 */
  generatedAtMs: number;
  domains: Record<ConcurrencyDomainId, ConcurrencyDomainSnapshot>;
}

export function getConcurrencyDiagnostics(
  this: AgentRuntimeInternal,
): ConcurrencyDiagnosticsSnapshot {
  const nowMs = this.now().getTime();
  const tasks = Object.values(this.runtimeTaskRegistry.all());
  return {
    generatedAtMs: nowMs,
    domains: {
      tool_scheduler: projectToolSchedulerDomain(this),
      dynamic_workflow: projectDynamicWorkflowDomain(this, tasks, nowMs),
      plan_explore: projectPlanExploreDomain(tasks),
      subagent_background: projectSubagentBackgroundDomain(tasks),
    },
  };
}

/**
 * 每 turn 至多一条的 debug 日志（spec R5）。free function 形态（先例：`rebuildContextPrefix(this)`），
 * 不进 proto——日志辅助不是 runtime 的对外能力，`getConcurrencyDiagnostics` 才是。
 */
export function logConcurrencyDiagnostics(
  runtime: AgentRuntimeInternal,
  traceContext: TraceContext,
): void {
  runtime.logger?.debug("Concurrency diagnostics snapshot", {
    ...traceContextToLogContext(traceContext),
    event: "concurrency_diagnostics_snapshot",
    module: "core.runtime",
    status: "completed",
    ...getConcurrencyDiagnostics.call(runtime),
  });
}

/** tool scheduler 域：caps = 生效 maxConcurrency；current = 最近一次调度的最大并行组宽度（R3）。 */
function projectToolSchedulerDomain(runtime: AgentRuntimeInternal): ConcurrencyDomainSnapshot {
  const snapshot = runtime.toolScheduler.snapshot();
  return {
    caps: snapshot.maxConcurrency,
    current: snapshot.lastScheduleMaxParallelGroupWidth,
    // 无自适应机制；用户配置下调 maxConcurrency 是配置事实，不是降级（spec R1）。
    degraded: false,
    facts: {
      currentBasis: "last_schedule_max_parallel_group_width",
    },
  };
}

/**
 * dynamic-workflow 域：caps = run 级并发天花板（端口可选方法，缺席 → undefined）；
 * current = 本 runtime 在跑的 dwf run 数；degraded = 任一 provider key 治理桶被 AIMD 压低
 * 或处于 Retry-After 冷却（R3）。每 run 的 caps 刻意不投影——那是 run 头的既有读面
 * （GetWorkflowRun / run-caps-changed），诊断面不建第二条读路径。
 */
function projectDynamicWorkflowDomain(
  runtime: AgentRuntimeInternal,
  tasks: RuntimeTaskSnapshot[],
  nowMs: number,
): ConcurrencyDomainSnapshot {
  const runningRuns = tasks.filter(
    (task) => task.type === "local_dynamic_workflow" && task.status === "running",
  );
  const ceiling = runtime.dynamicWorkflowRunPort?.concurrencyCeiling?.();
  const buckets: ModelRequestAdmissionBucketSnapshot[] | undefined =
    runtime.modelRequestAdmission?.concurrencyBuckets?.();
  const degraded = (buckets ?? []).some(
    (bucket) =>
      bucket.cap < bucket.ceiling ||
      (bucket.cooldownUntil !== undefined && bucket.cooldownUntil > nowMs),
  );
  return {
    caps: ceiling,
    current: runningRuns.length,
    degraded,
    facts: {
      capsBasis: "run_concurrency_ceiling",
      currentBasis: "running_local_dynamic_workflow_tasks",
      // 治理桶不可见时如实报 unavailable（R2 缺失即未知），degraded 保持 false。
      admission: buckets === undefined ? "unavailable" : buckets,
    },
  };
}

/**
 * Plan Explore 域：caps = 提示词纪律常量（与 Plan Workflow 文案同一个 `planResearchAgentCount`）；
 * current = registry 里在跑的 Explore 子代理数。这条上限**不是运行时硬闸**——facts 如实标注
 * enforced=false，读面不得把它当成会拒绝派发的信号（R3）。
 */
function projectPlanExploreDomain(tasks: RuntimeTaskSnapshot[]): ConcurrencyDomainSnapshot {
  const runningExplore = tasks.filter(
    (task) =>
      task.type === "local_agent" &&
      task.agentType === EXPLORE_AGENT_TYPE &&
      task.status === "running",
  );
  return {
    caps: planResearchAgentCount,
    current: runningExplore.length,
    degraded: false,
    facts: {
      enforced: false,
      carrier: "prompt",
    },
  };
}

/**
 * subagent 后台域：**无显式上限**（全仓无 background 并发 cap，caps 如实投影 undefined）；
 * current = backgrounded 且 running 的 local_agent 数；facts 附全部后台 running 任务按 type
 * 的分解（local_bash / local_dynamic_workflow 也在后台面板里，读面要能看到全景）。
 */
function projectSubagentBackgroundDomain(tasks: RuntimeTaskSnapshot[]): ConcurrencyDomainSnapshot {
  const backgroundRunning = tasks.filter(
    (task) => task.isBackgrounded === true && task.status === "running",
  );
  const backgroundRunningByType: Record<string, number> = {};
  for (const task of backgroundRunning) {
    backgroundRunningByType[task.type] = (backgroundRunningByType[task.type] ?? 0) + 1;
  }
  return {
    caps: undefined,
    current: backgroundRunningByType["local_agent"] ?? 0,
    degraded: false,
    facts: {
      currentBasis: "backgrounded_running_local_agent_tasks",
      backgroundRunningByType,
    },
  };
}
