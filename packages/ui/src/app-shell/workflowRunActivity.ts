import {
  aggregateRunStatuses,
  statusOfRunNode,
} from "@/components/workflow-graph/run-status.js";
import type { StepRunStatus } from "@/components/workflow-graph/types.js";
import type { WorkflowRunActor, WorkflowRunNode, WorkflowRunState } from "@acode/shared/acode-protocol-v4";

/**
 * 详情侧栏「实时活动」主体的纯模型：把 `workflowRuns` 投影折成按阶段分组的清单。
 *
 * 抽成纯函数有两个理由，都与仓库既有分工一致（`workflowRunPanel.ts` 之于侧栏）：
 *   1. 分组与状态折叠是**规则**，规则要能被穷举单测，不该藏在 JSX 里；
 *   2. 组件文件带 `@/` 别名与 React/lucide 依赖，测试导入它会把整棵渲染树拖进来。
 *
 * ## 为什么不从投影合成一张因果图
 *
 * 既有主体 `WorkflowRunPhaseList` 绑在静态因果图上（`WorkflowCausalityGraphData` →
 * `buildWorkflowTimeline` → `model.stations`），而图里有 lanes、arcs、bands 与并行带——
 * 那些是静态分析的产物（谁 fan-out 出谁、哪几条并行）。脚本工作流不编译、不做静态分析，
 * `RunWorkflow` 的工具行上没有图。投影只知道「这些阶段被进入过、这些子代理跑过、这些节点
 * 结算了」，拿它去造 lanes 与 arcs 等于**编造因果**：读者会把一条时间顺序读成依赖关系。
 * 所以这里只输出投影确实有的三样东西，一条边都不画。
 */

export interface WorkflowActivityGroup {
  /** 缺席表示「未分组」那一桶（actor 与其节点都没有阶段坐标）。 */
  name: string | undefined;
  actors: readonly WorkflowRunActor[];
  nodes: readonly WorkflowRunNode[];
  /** 该组节点状态的折叠；一个节点都没有时为 undefined（缺席不是状态，不凭空造一个）。 */
  status: StepRunStatus | undefined;
  /** 已结算节点数，分母是 `nodes.length`。 */
  settled: number;
}

/** 节点归属到子代理的键；`actorSiteId`/`actorOrdinal` 缺席（world-read 之类）即无主。 */
function nodeActorKey(node: WorkflowRunNode): string | undefined {
  if (node.actorSiteId === undefined || node.actorOrdinal === undefined) return undefined;
  return `${node.actorSiteId}@${node.actorOrdinal}`;
}

export function workflowActorKey(actor: WorkflowRunActor): string {
  return `${actor.siteId}@${actor.ordinal}`;
}

/** actor 三态 → 叠加视图的四值词汇表。没有 failed：dwf 的 actor 三态里本来就没有它。 */
export function actorStatusToStepStatus(status: WorkflowRunActor["status"]): StepRunStatus {
  switch (status) {
    case "running":
      return "running";
    case "completed":
      return "done";
    default:
      return "pending";
  }
}

/**
 * 一个子代理的展示状态：优先用它名下节点折叠出的结果（硬事实：跑没跑、成没成），
 * 一个节点都没有时才退回 actor 自己的三态。两套词汇表不同，所以必须显式桥接而不是混用。
 */
export function workflowActorStepStatus(
  actor: WorkflowRunActor,
  nodes: readonly WorkflowRunNode[],
): StepRunStatus {
  return aggregateRunStatuses(nodes.map(statusOfRunNode)) ?? actorStatusToStepStatus(actor.status);
}

export function buildWorkflowActivityGroups(run: WorkflowRunState): readonly WorkflowActivityGroup[] {
  // 1) 节点按归属的子代理分桶，只为下一步的相位回退服务（actor 自己没坐标时看它名下节点）。
  //    无主节点（world-read 之类，actorSiteId 缺席）不进桶——它们的相位直接由自己决定。
  const nodesByActor = new Map<string, WorkflowRunNode[]>();
  for (const node of run.nodes) {
    const key = nodeActorKey(node);
    if (key === undefined) continue;
    const bucket = nodesByActor.get(key);
    if (bucket) bucket.push(node);
    else nodesByActor.set(key, [node]);
  }

  // 2) 每个子代理归到哪个阶段：优先用它自己的坐标；缺席时退到它名下节点里第一个有坐标的。
  //    这不是猜测——脚本可以给 agent 传 opts.phase 而不打 phase() 标记，于是 actor 上没有
  //    phaseName 而它的节点有。两处都缺席才落进「未分组」。
  const actorPhase = new Map<string, string | undefined>();
  for (const actor of run.actors) {
    const key = workflowActorKey(actor);
    const fromNodes = (nodesByActor.get(key) ?? []).find(
      (node) => node.phaseName !== undefined,
    )?.phaseName;
    actorPhase.set(key, actor.phaseName ?? fromNodes);
  }

  /**
   * 节点归到哪个阶段——**独立于 actor 是否在名册上**。
   *
   * 只经 actor 收集节点会静默丢活：actor 表是有界的（`maxActors`，满了就淘汰），而 node 表
   * 另有一界，两者不同步；旧 CLI 也可能压根不发 `actor-created`。于是「节点有 actorSiteId、
   * 但那个 actor 不在 `run.actors` 里」是可达状态，那种节点若只从 actor 那侧收集就凭空消失
   * ——正是适配器那边修过的「有活没人干」在渲染层重现。所以这里按节点自己的坐标定相，
   * actor 缺席时退回它名下任一节点的坐标，再缺席才落「未分组」。
   */
  const nodePhase = new Map<WorkflowRunNode, string | undefined>();
  for (const node of run.nodes) {
    if (node.phaseName !== undefined) {
      nodePhase.set(node, node.phaseName);
      continue;
    }
    const key = nodeActorKey(node);
    nodePhase.set(node, key === undefined ? undefined : actorPhase.get(key));
  }

  // 3) 阶段顺序：先按投影记录的**实际进入顺序**（run.phases），再补上只出现在坐标里而没发过
  //    phase-entered 的名字（按首次出现序）。「未分组」恒在最后。三段都是观测事实，不是猜测。
  const seen = new Set<string>();
  const names: string[] = [];
  const pushName = (name: string | undefined): void => {
    if (name === undefined || seen.has(name)) return;
    seen.add(name);
    names.push(name);
  };
  for (const phase of run.phases ?? []) pushName(phase.name);
  for (const actor of run.actors) pushName(actorPhase.get(workflowActorKey(actor)));
  for (const node of run.nodes) pushName(nodePhase.get(node));

  // 4) 分桶。actor 与 node 各按自己的相位归属，互不依赖——于是一个节点恰好落进一组
  //    （不重不漏），且不会因为它的 actor 缺席而被丢掉。
  const actorsByPhase = new Map<string | undefined, WorkflowRunActor[]>();
  for (const actor of run.actors) {
    const phase = actorPhase.get(workflowActorKey(actor));
    const bucket = actorsByPhase.get(phase);
    if (bucket) bucket.push(actor);
    else actorsByPhase.set(phase, [actor]);
  }
  const nodesByPhase = new Map<string | undefined, WorkflowRunNode[]>();
  for (const node of run.nodes) {
    const phase = nodePhase.get(node);
    const bucket = nodesByPhase.get(phase);
    if (bucket) bucket.push(node);
    else nodesByPhase.set(phase, [node]);
  }

  const groups: WorkflowActivityGroup[] = [];
  for (const name of [...names, undefined]) {
    const actors = actorsByPhase.get(name) ?? [];
    const nodes = nodesByPhase.get(name) ?? [];
    // 空组要不要留，取决于是谁声称它存在：
    //   - `run.phases` 里有它 → 它**确实被进入过**（phase-entered 是观测事实），
    //     「进了这一站但一件活都没干」本身就是要说的话，藏起来等于少报一站；
    //   - 只是「未分组」桶为空 → 没有任何事实支撑它，不造一个空壳出来。
    if (actors.length === 0 && nodes.length === 0 && !seen.has(name ?? "")) continue;
    groups.push({
      actors,
      name,
      nodes,
      settled: nodes.filter((node) => node.phase === "settled").length,
      // 折叠走 dwf 那一个函数（run-status.ts 的 aggregateRunStatuses）：自己再写一份，
      // 两套视图对同一批节点就会给出不同的灯。
      status: aggregateRunStatuses(nodes.map(statusOfRunNode)),
    });
  }
  return groups;
}
