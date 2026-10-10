import type {
  BackgroundWorkSummary,
  RunningSubagentSummary,
  SubagentProjectionState,
  SwarmPlanState,
  WorkflowRunState,
  WorkflowRunsState,
} from "@acode/shared/acode-protocol-v4";
import { workflowRunStepCounts } from "@acode/shared/acode-protocol-v4";

/**
 * 统一编排 side pane 的纯模型（packages/ui/specs/orchestration-side-pane.md R0/R2）。
 *
 * 单一信源 = v4 snapshot 三键（subagents / workflowRuns / swarmPlan）；本模块只做
 * 「构造即过滤」的视图派生——不缓存事实、不写状态、不自行推导 run status（消费投影
 * 端的派生事实，workflow-runs.ts「reducer 只搬运」同款纪律）。步数计数走 shared 的
 * workflowRunStepCounts（唯一实现，run 卡/时间线/状态坞同源）。
 *
 * 每段独立空隐（R2）：键缺席（旧 CLI 投影）或空值 → 该段 null，组件不渲染；三段全
 * null → pane 级空态。swarmPlan=null（显式清除）与缺席同待遇。
 */

/** swarm 节点行的渲染上限（spec R2）：wire 上限 512 仍在 snapshot 事实里，pane 不背全量渲染。 */
export const ORCHESTRATION_SWARM_NODE_DISPLAY_LIMIT = 200;

/**
 * swarm 节点状态灯 → 语义 token 类（spec R5：与 workflow timeline station lamp 同一
 * 语义映射——done=success、running=warning、failed=destructive、queued=中性空心）。
 * 放模型层（纯数据）而不是组件里：映射是视图语义的单点，测试可直接钉住。
 */
export const ORCHESTRATION_SWARM_LAMP_CLASS: Record<
  "queued" | "running" | "done" | "failed",
  string
> = {
  queued: "border-foreground-subtlest",
  running: "bg-warning",
  done: "bg-success",
  failed: "bg-destructive",
};

export interface OrchestrationWorkflowRow {
  runId: string;
  status: WorkflowRunState["status"];
  nodesSettled: number;
  nodesTotal: number;
  /** 题名来自 backgroundWorks 的 workId≡runId 联接（与状态坞同一联接规则）；缺席显示 runId。 */
  title?: string;
  toolCallId?: string;
  dialect?: "dwf" | "script";
  startedAt?: number;
}

export interface OrchestrationSwarmNodeRow {
  id: string;
  kind: SwarmPlanState["nodes"][number]["kind"];
  status: SwarmPlanState["nodes"][number]["status"];
  isGate: boolean;
  dependsOnCount: number;
  contentPreview?: string;
}

export interface OrchestrationSwarmModel {
  goal: string;
  mode: SwarmPlanState["mode"];
  terminalState: SwarmPlanState["terminalState"];
  counts: SwarmPlanState["counts"];
  nodes: OrchestrationSwarmNodeRow[];
  nodeTotal: number;
  /** 渲染上限截断（本模块行为）；与 wireTruncated（投影上限截断）分别标注。 */
  nodeDisplayTruncated: boolean;
  wireTruncated: boolean;
  updatedAtMs: number;
}

export interface OrchestrationPanelModel {
  agents: {
    running: readonly RunningSubagentSummary[];
    endedTotal: number;
  } | null;
  workflows: {
    rows: OrchestrationWorkflowRow[];
  } | null;
  swarm: OrchestrationSwarmModel | null;
  empty: boolean;
}

export interface BuildOrchestrationPanelModelInput {
  backgroundWorks?: readonly BackgroundWorkSummary[] | null;
  subagents?: SubagentProjectionState | null;
  swarmPlan?: SwarmPlanState | null;
  workflowRuns?: WorkflowRunsState | null;
}

function buildWorkflowRows(
  runs: readonly WorkflowRunState[] | undefined,
  backgroundWorks: readonly BackgroundWorkSummary[] | undefined,
): OrchestrationWorkflowRow[] {
  if (!runs?.length) return [];
  const workByRunId = new Map<string, BackgroundWorkSummary>();
  for (const work of backgroundWorks ?? []) {
    if (work.kind === "workflow") workByRunId.set(work.workId, work);
  }
  // 顺序 = 投影 runs 序 = 启动序，模型不排序（conversationStatusPanelModel 同款纪律：
  // 重排会让行在每次投影更新时跳位）。
  return runs.map((run) => {
    const work = workByRunId.get(run.runId);
    const steps = workflowRunStepCounts(run);
    return {
      runId: run.runId,
      status: run.status,
      nodesSettled: steps.settled,
      nodesTotal: steps.total,
      ...(run.toolCallId ? { toolCallId: run.toolCallId } : {}),
      ...(run.dialect ? { dialect: run.dialect } : {}),
      ...(work ? { title: work.title, startedAt: work.startedAt } : {}),
    };
  });
}

function buildSwarmModel(plan: SwarmPlanState): OrchestrationSwarmModel {
  const nodeTotal = plan.nodes.length;
  const nodes = plan.nodes.slice(0, ORCHESTRATION_SWARM_NODE_DISPLAY_LIMIT).map((node) => ({
    id: node.id,
    kind: node.kind,
    status: node.status,
    isGate: node.isGate,
    dependsOnCount: node.dependsOn.length,
    ...(node.contentPreview ? { contentPreview: node.contentPreview } : {}),
  }));
  return {
    goal: plan.goal,
    mode: plan.mode,
    terminalState: plan.terminalState,
    counts: plan.counts,
    nodes,
    nodeTotal,
    nodeDisplayTruncated: nodeTotal > ORCHESTRATION_SWARM_NODE_DISPLAY_LIMIT,
    wireTruncated: plan.truncated === true,
    updatedAtMs: plan.updatedAtMs,
  };
}

export function buildOrchestrationPanelModel(
  input: BuildOrchestrationPanelModelInput,
): OrchestrationPanelModel {
  const subagents = input.subagents;
  const agents =
    subagents && (subagents.running.length > 0 || subagents.endedTotal > 0)
      ? { running: subagents.running, endedTotal: subagents.endedTotal }
      : null;
  const rows = buildWorkflowRows(input.workflowRuns?.runs, input.backgroundWorks ?? undefined);
  const workflows = rows.length > 0 ? { rows } : null;
  const swarm = input.swarmPlan ? buildSwarmModel(input.swarmPlan) : null;
  return {
    agents,
    workflows,
    swarm,
    empty: agents === null && workflows === null && swarm === null,
  };
}
