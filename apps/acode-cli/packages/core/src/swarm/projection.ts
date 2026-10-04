// K2 对话内 Swarm 任务图 R5（specs/swarm-task-graph.md）：plan 的只读投影——PlanStatus
// 工具面与 2b 的 runtime-task 快照（R4「对 runtime-task 的投影：快照含 done/failed/
// running/stalled 计数与图摘要」）共用同一份推导，防两个可见面各自渲染后漂移。
//
// 纯函数、零 IO：输入 plan（读者快照），输出 JSON-safe 视图。ready/stalled 全部由
// graph/schedule.ts 推导（blocked 不落存储的单一事实源），本模块不做第二份推导。

import type { SwarmPlanNode, SwarmTaskPlan, WorkflowArtifactConfidence } from "@acode/contracts";
import {
  planTerminalState,
  readyNodeIds,
  stalledNodeIds,
  type SwarmPlanTerminalState,
} from "./graph/schedule.js";

/** 上游 artifact 摘要的单行截断（投影是摘要不是转载——全文走 dataflow 装配面）。 */
const UPSTREAM_SUMMARY_MAX_CHARS = 160;

export interface SwarmUpstreamArtifactSummary {
  confidence: WorkflowArtifactConfidence | undefined;
  id: string;
  summary: string;
}

export interface SwarmPlanNodeView {
  artifactRequeues: number;
  dependsOn: string[];
  expanded: boolean;
  id: string;
  isGate: boolean;
  kind: SwarmPlanNode["kind"];
  origin: SwarmPlanNode["origin"];
  owner: string | null;
  priority: number;
  status: SwarmPlanNode["status"];
  /** 直接上游中已 done 且带产物者的摘要（R5「上游 artifact 摘要」）。 */
  upstreamArtifacts: SwarmUpstreamArtifactSummary[];
}

export interface SwarmPlanStatusView {
  counts: {
    done: number;
    failed: number;
    gates: number;
    queued: number;
    running: number;
    stalled: number;
  };
  goal: string;
  mode: SwarmTaskPlan["mode"];
  /** ready 的 gate 节点（主对话的待审计队列——deep 模式不可绕过的收尾义务，R7）。 */
  readyGateIds: string[];
  /** ready 的 worker 节点（等调度点/槽位）。 */
  readyWorkerIds: string[];
  stalledNodeIds: string[];
  terminalState: SwarmPlanTerminalState;
  nodes: SwarmPlanNodeView[];
  noArtifactRequeues: number;
  version: number;
}

export function buildSwarmPlanStatus(plan: SwarmTaskPlan): SwarmPlanStatusView {
  const nodesById = new Map(plan.nodes.map((node) => [node.id, node]));
  const ready = new Set(readyNodeIds(plan));
  const stalled = new Set(stalledNodeIds(plan));
  const views = plan.nodes.map((node) => ({
    artifactRequeues: node.artifactRequeues,
    dependsOn: [...node.dependsOn],
    expanded: node.expanded,
    id: node.id,
    isGate: node.isGate,
    kind: node.kind,
    origin: node.origin,
    owner: node.owner,
    priority: node.priority,
    status: node.status,
    upstreamArtifacts: summarizeUpstreams(node, nodesById),
  }));
  return {
    counts: {
      done: count(plan, (node) => node.status === "done"),
      failed: count(plan, (node) => node.status === "failed"),
      gates: count(plan, (node) => node.isGate),
      queued: count(plan, (node) => node.status === "queued"),
      running: count(plan, (node) => node.status === "running"),
      stalled: stalled.size,
    },
    goal: plan.goal,
    mode: plan.mode,
    readyGateIds: plan.nodes
      .filter((node) => node.isGate && ready.has(node.id))
      .map((node) => node.id),
    readyWorkerIds: plan.nodes
      .filter((node) => !node.isGate && ready.has(node.id))
      .map((node) => node.id),
    stalledNodeIds: [...stalled],
    terminalState: planTerminalState(plan),
    nodes: views,
    noArtifactRequeues: plan.noArtifactRequeues,
    version: plan.version,
  };
}

function count(plan: SwarmTaskPlan, predicate: (node: SwarmPlanNode) => boolean): number {
  return plan.nodes.filter(predicate).length;
}

function summarizeUpstreams(
  node: SwarmPlanNode,
  nodesById: Map<string, SwarmPlanNode>,
): SwarmUpstreamArtifactSummary[] {
  const summaries: SwarmUpstreamArtifactSummary[] = [];
  for (const dep of node.dependsOn) {
    const upstream = nodesById.get(dep);
    if (upstream === undefined || upstream.status !== "done" || upstream.output === null) {
      continue;
    }
    summaries.push({
      confidence: upstream.output.confidence,
      id: upstream.id,
      summary: singleLine(upstream.output.findings, UPSTREAM_SUMMARY_MAX_CHARS),
    });
  }
  return summaries;
}

function singleLine(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars)}…`;
}
