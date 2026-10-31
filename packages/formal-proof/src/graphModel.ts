// 2026-12-31 例外债务偿还：自 main.ts 按职责拆出——状态空间图模型层
//（TraceNode → StateSpaceGraph 的等价节点合并投影 + 布局/排序/路径/标签纯函数）。
// 除 GraphViewFilter 参数化（isGraphDimmed/isEdgeDimmed/graphNodeClass 原闭包
// 读取 viewState 的 activeRule/activeDecision/selectedId，改为显式入参，语义等价）
// 外全部逐字迁移，零行为改动。本叶不依赖 d3/DOM，可直接单测。

import { contextKey } from "./model.js";
import type {
  Candidate,
  Decision,
  DecisionKind,
  NodeKind,
  ProductContext,
  TraceNode,
} from "./model.js";

export interface GraphNodeDatum {
  readonly id: string;
  readonly kind: NodeKind;
  readonly representative: TraceNode;
  readonly members: TraceNode[];
  readonly title: string;
  readonly subtitle: string;
  readonly detail: string;
  readonly context: ProductContext;
  readonly candidate?: Candidate;
  readonly decision?: Decision;
  readonly caseId?: string;
  readonly e2e?: string;
  readonly column: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface GraphEdgeDatum {
  readonly id: string;
  readonly source: GraphNodeDatum;
  readonly target: GraphNodeDatum;
  readonly decision?: Decision;
}

export interface StateSpaceGraph {
  readonly nodes: GraphNodeDatum[];
  readonly edges: GraphEdgeDatum[];
  readonly columns: number[];
  readonly width: number;
  readonly height: number;
}

// 原 main.ts 中 viewState 的三个高亮/选中字段，拆叶后作为显式入参。
export interface GraphViewFilter {
  readonly activeRule: string;
  readonly activeDecision: DecisionKind | "all";
  readonly selectedId: string;
}

export function buildStateSpaceGraph(root: TraceNode): StateSpaceGraph {
  const nodesById = new Map<string, GraphNodeDatum>();
  const edgeIds = new Set<string>();
  const edgeRefs: Array<{ sourceId: string; targetId: string; decision?: Decision }> = [];

  visitGraph(root, undefined, 0);

  const nodes = [...nodesById.values()];
  const columns = [...new Set(nodes.map((node) => node.column))].sort((a, b) => a - b);
  const columnWidth = 304;
  const rowGap = 14;
  const headerHeight = 56;
  const left = 28;
  const top = 58;
  let graphHeight = 600;

  for (const column of columns) {
    const columnNodes = nodes
      .filter((node) => node.column === column)
      .sort((a, b) => graphSortKey(a).localeCompare(graphSortKey(b), "zh-CN"));

    columnNodes.forEach((node, index) => {
      node.x = left + column * columnWidth;
      node.y = top + headerHeight + index * (node.height + rowGap);
    });
    const height = top + headerHeight + columnNodes.length * (76 + rowGap) + 80;
    graphHeight = Math.max(graphHeight, height);
  }

  const graphWidth = left + (Math.max(...columns, 0) + 1) * columnWidth + 280;
  const edges: GraphEdgeDatum[] = edgeRefs
    .map((edge): GraphEdgeDatum | undefined => {
      const source = nodesById.get(edge.sourceId);
      const target = nodesById.get(edge.targetId);
      if (!source || !target) {
        return undefined;
      }
      const id = `${edge.sourceId}->${edge.targetId}`;
      return edge.decision
        ? { id, source, target, decision: edge.decision }
        : { id, source, target };
    })
    .filter((edge): edge is GraphEdgeDatum => Boolean(edge));

  return {
    nodes,
    edges,
    columns,
    width: graphWidth,
    height: graphHeight,
  };

  function visitGraph(
    node: TraceNode,
    parent: GraphNodeDatum | undefined,
    depth: number,
  ): GraphNodeDatum {
    const id = graphNodeId(node, parent?.id, depth);
    let datum = nodesById.get(id);
    if (datum) {
      datum.members.push(node);
    } else {
      datum = {
        id,
        kind: node.kind,
        representative: node,
        members: [node],
        title: node.title,
        subtitle: node.subtitle,
        detail: node.detail,
        context: node.context,
        candidate: node.candidate,
        decision: node.decision,
        caseId: node.caseId,
        e2e: node.e2e,
        column: columnFor(node, depth),
        x: 0,
        y: 0,
        width: widthFor(node),
        height: 76,
      };
      nodesById.set(id, datum);
    }

    if (parent) {
      const edgeId = `${parent.id}->${datum.id}`;
      if (!edgeIds.has(edgeId)) {
        edgeIds.add(edgeId);
        edgeRefs.push({
          sourceId: parent.id,
          targetId: datum.id,
          decision: node.decision ?? parent.decision,
        });
      }
    }

    for (const child of node.children) {
      visitGraph(child, datum, depth + 1);
    }
    return datum;
  }
}

export function graphNodeId(node: TraceNode, parentId: string | undefined, depth: number): string {
  const round = Math.floor(depth / 4) + 1;
  if (node.kind === "state") {
    return `state:${round}:${contextKey(node.context)}`;
  }
  if (node.kind === "candidate") {
    return `${parentId ?? "root"}:action:${node.candidate?.id ?? slug(node.title)}`;
  }
  if (node.kind === "guard") {
    return `${parentId ?? "root"}:guard:${node.decision?.kind ?? "none"}:${node.decision?.ruleId ?? slug(node.title)}`;
  }
  if (node.kind === "effect") {
    return `${parentId ?? "root"}:effect:${node.decision?.kind ?? "none"}:${node.decision?.ruleId ?? slug(node.title)}:${contextKey(node.context)}`;
  }
  if (node.kind === "summary") {
    return `${parentId ?? "root"}:summary:${slug(node.title)}`;
  }
  return `case:${node.caseId ?? node.id}`;
}

function columnFor(node: TraceNode, depth: number): number {
  const round = Math.floor(depth / 4);
  if (node.kind === "case" || node.kind === "summary") {
    return round * 5 + 4;
  }
  return round * 5 + (depth % 4);
}

function widthFor(node: TraceNode): number {
  if (node.kind === "case") {
    return 264;
  }
  if (node.kind === "state") {
    return 268;
  }
  return 252;
}

export function columnLabel(column: number): string {
  const round = Math.floor(column / 5) + 1;
  const slot = column % 5;
  if (slot === 0) {
    return `R${round} · State`;
  }
  if (slot === 1) {
    return "Action";
  }
  if (slot === 2) {
    return "Guard";
  }
  if (slot === 3) {
    return "Effect";
  }
  return "Case / Review";
}

export function graphSortKey(node: GraphNodeDatum): string {
  return [
    String(node.decision ? decisionRank(node.decision.kind) : 0),
    node.kind,
    node.decision?.ruleId ?? "",
    node.title,
    node.subtitle,
  ].join("|");
}

export function decisionRank(kind: DecisionKind): number {
  if (kind === "reject") {
    return 1;
  }
  if (kind === "undefined") {
    return 2;
  }
  if (kind === "enqueue") {
    return 3;
  }
  if (kind === "allow") {
    return 4;
  }
  return 5;
}

export function edgePath(edge: GraphEdgeDatum): string {
  const sx = edge.source.x + edge.source.width;
  const sy = edge.source.y + edge.source.height / 2;
  const tx = edge.target.x;
  const ty = edge.target.y + edge.target.height / 2;
  const mid = sx + Math.max(36, (tx - sx) * 0.5);
  return `M${sx},${sy} C${mid},${sy} ${mid},${ty} ${tx},${ty}`;
}

export function nodeTypeLabel(node: GraphNodeDatum): string {
  if (node.kind === "state" && isLongRunningState(node)) {
    return "State · long task";
  }
  if (node.kind === "candidate" && node.candidate?.kind === "system") {
    return "System event";
  }
  if (node.kind === "candidate") {
    return "User action";
  }
  if (node.kind === "guard") {
    return "Guard";
  }
  if (node.kind === "effect") {
    return "Effect";
  }
  if (node.kind === "case") {
    return "Case";
  }
  if (node.kind === "summary") {
    return "Folded";
  }
  return "State";
}

function isLongRunningState(node: GraphNodeDatum): boolean {
  return (
    node.kind === "state" &&
    (node.context.runPhase === "running" ||
      node.context.runPhase === "compacting" ||
      node.context.runPhase === "goalVerifying")
  );
}

function isGraphDimmed(node: GraphNodeDatum, view: GraphViewFilter): boolean {
  const ruleMatched =
    view.activeRule === "all" ||
    node.members.some((member) => member.decision?.ruleId === view.activeRule);
  const decisionMatched =
    view.activeDecision === "all" ||
    node.members.some((member) => member.decision?.kind === view.activeDecision);
  return !ruleMatched || !decisionMatched;
}

export function isEdgeDimmed(edge: GraphEdgeDatum, view: GraphViewFilter): boolean {
  return isGraphDimmed(edge.source, view) && isGraphDimmed(edge.target, view);
}

export function graphNodeClass(node: GraphNodeDatum, view: GraphViewFilter): string {
  const classes = ["graph-node", node.kind];
  if (node.decision) {
    classes.push(node.decision.kind);
  }
  if (isLongRunningState(node)) {
    classes.push("long-task");
  }
  if (isGraphDimmed(node, view)) {
    classes.push("dimmed");
  }
  if (view.selectedId === node.id) {
    classes.push("selected");
  }
  return classes.join(" ");
}

export function shortText(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}...` : value;
}

function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-|-$/g, "");
}
