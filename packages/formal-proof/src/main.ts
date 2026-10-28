// 2026-12-31 例外债务偿还：main.ts（原 905 行）按职责拆出五叶——
// appShell（HTML 骨架）/ graphModel（状态空间图模型与纯展示 helper）/
// columnBands（d3 列带）/ renderBudget（渲染预算折叠）/ reviewCases
//（review 持久化与 case 导出）。本文件保留编排：DOM 装配、事件接线、
// d3 图渲染与详情弹层。行为零改动。

import * as d3 from "d3";
import { renderAppShell } from "./appShell.js";
import { renderColumnBands } from "./columnBands.js";
import {
  buildStateSpaceGraph,
  edgePath,
  graphNodeClass,
  isEdgeDimmed,
  nodeTypeLabel,
  shortText,
  type GraphEdgeDatum,
  type GraphNodeDatum,
} from "./graphModel.js";
import {
  buildTraceTree,
  collectStats,
  contextLabel,
  decisionLabel,
  flatten,
  profiles,
  type DecisionKind,
  type TraceNode,
} from "./model.js";
import { cloneForRender } from "./renderBudget.js";
import {
  buildCaseRows,
  findPath,
  readReview,
  reviewKey,
  statusOptions,
  type ReviewStatus,
} from "./reviewCases.js";
import "./styles.css";

interface TreeViewState {
  root: TraceNode;
  renderRoot: TraceNode;
  nodes: TraceNode[];
  selectedId: string;
  activeRule: string;
  activeDecision: DecisionKind | "all";
  review: Record<string, ReviewStatus>;
}

const numberFormat = new Intl.NumberFormat("zh-CN");
const app = mustQuery<HTMLDivElement>("#app");

let zoomBehavior: d3.ZoomBehavior<SVGSVGElement, unknown> | null = null;
let fitTransform: d3.ZoomTransform | null = null;
let defaultTransform: d3.ZoomTransform | null = null;
let graphNodeIndex = new Map<string, GraphNodeDatum>();
let viewState: TreeViewState;

app.innerHTML = renderAppShell();

const elements = {
  profileSelect: mustQuery<HTMLSelectElement>("#profileSelect"),
  roundSelect: mustQuery<HTMLSelectElement>("#roundSelect"),
  budgetSelect: mustQuery<HTMLSelectElement>("#budgetSelect"),
  decisionSelect: mustQuery<HTMLSelectElement>("#decisionSelect"),
  metricNodes: mustQuery<HTMLElement>("#metricNodes"),
  metricCases: mustQuery<HTMLElement>("#metricCases"),
  metricRejects: mustQuery<HTMLElement>("#metricRejects"),
  metricUndefined: mustQuery<HTMLElement>("#metricUndefined"),
  metricQueue: mustQuery<HTMLElement>("#metricQueue"),
  metricRendered: mustQuery<HTMLElement>("#metricRendered"),
  ruleList: mustQuery<HTMLElement>("#ruleList"),
  tree: mustQuery<SVGSVGElement>("#tree"),
  nodePopover: mustQuery<HTMLElement>("#nodePopover"),
  detailTitle: mustQuery<HTMLElement>("#detailTitle"),
  detailKind: mustQuery<HTMLElement>("#detailKind"),
  detailContext: mustQuery<HTMLElement>("#detailContext"),
  detailText: mustQuery<HTMLElement>("#detailText"),
  detailE2e: mustQuery<HTMLElement>("#detailE2e"),
  detailPath: mustQuery<HTMLElement>("#detailPath"),
  reviewButtons: mustQuery<HTMLElement>("#reviewButtons"),
  closeDetail: mustQuery<HTMLButtonElement>("#closeDetail"),
  zoomIn: mustQuery<HTMLButtonElement>("#zoomIn"),
  zoomOut: mustQuery<HTMLButtonElement>("#zoomOut"),
  fitTree: mustQuery<HTMLButtonElement>("#fitTree"),
  resetTree: mustQuery<HTMLButtonElement>("#resetTree"),
  exportCases: mustQuery<HTMLButtonElement>("#exportCases"),
};

const initialRoot = rebuildRoot();
viewState = {
  root: initialRoot,
  renderRoot: initialRoot,
  nodes: [],
  selectedId: "",
  activeRule: "all",
  activeDecision: "all",
  review: readReview(),
};

renderReviewButtons();
renderAll();

for (const select of [elements.profileSelect, elements.roundSelect, elements.budgetSelect]) {
  select.addEventListener("change", () => {
    viewState.selectedId = "";
    viewState.root = rebuildRoot();
    renderAll();
  });
}

elements.decisionSelect.addEventListener("change", () => {
  viewState.activeDecision = elements.decisionSelect.value as DecisionKind | "all";
  renderAll();
});
elements.zoomIn.addEventListener("click", () => zoomBy(1.25));
elements.zoomOut.addEventListener("click", () => zoomBy(0.8));
elements.fitTree.addEventListener("click", () => applyTransform(fitTransform));
elements.resetTree.addEventListener("click", () => applyTransform(defaultTransform));
elements.exportCases.addEventListener("click", exportCases);
elements.closeDetail.addEventListener("click", () => {
  viewState.selectedId = "";
  updateSelectedNodeClasses();
  renderDetail();
});

function renderAll(): void {
  const budget = { remaining: Number(elements.budgetSelect.value) };
  viewState.renderRoot = cloneForRender(viewState.root, budget);
  viewState.nodes = flatten(viewState.root);
  renderMetrics();
  renderRules();
  renderGraph();
  renderDetail(selectedGraphNode());
}

function rebuildRoot(): TraceNode {
  const profile = profiles.find((item) => item.id === elements.profileSelect.value) ?? profiles[0];
  if (!profile) {
    throw new Error("No model profiles defined");
  }
  return buildTraceTree(profile.context, Number(elements.roundSelect.value));
}

function renderMetrics(): void {
  const stats = collectStats(viewState.root);
  elements.metricNodes.textContent = numberFormat.format(stats.nodes);
  elements.metricCases.textContent = numberFormat.format(stats.cases);
  elements.metricRejects.textContent = numberFormat.format(stats.rejects);
  elements.metricUndefined.textContent = numberFormat.format(stats.undefined);
  elements.metricQueue.textContent = numberFormat.format(stats.enqueued);
  elements.metricRendered.textContent = numberFormat.format(
    buildStateSpaceGraph(viewState.renderRoot).nodes.length,
  );
}

function renderRules(): void {
  const counts = new Map<string, number>();
  for (const node of viewState.nodes) {
    const rule = node.decision?.ruleId;
    if (rule) {
      counts.set(rule, (counts.get(rule) ?? 0) + 1);
    }
  }

  const all = document.createElement("button");
  all.type = "button";
  all.className = `rule-button${viewState.activeRule === "all" ? " active" : ""}`;
  all.innerHTML = "<b>全部规则</b><span>取消规则高亮</span>";
  all.addEventListener("click", () => {
    viewState.activeRule = "all";
    renderAll();
  });

  const buttons = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([rule, count]) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `rule-button${viewState.activeRule === rule ? " active" : ""}`;
      button.innerHTML = `<b>${rule} · ${numberFormat.format(count)}</b><span>${sampleRuleText(rule)}</span>`;
      button.addEventListener("click", () => {
        viewState.activeRule = rule;
        renderAll();
      });
      return button;
    });

  elements.ruleList.replaceChildren(all, ...buttons);
}

function renderGraph(): void {
  const svg = d3.select(elements.tree);
  svg.selectAll("*").remove();

  const graph = buildStateSpaceGraph(viewState.renderRoot);
  graphNodeIndex = new Map(graph.nodes.map((node) => [node.id, node]));

  const viewportWidth = elements.tree.clientWidth || 1120;
  const viewportHeight = elements.tree.clientHeight || 820;
  elements.tree.setAttribute("viewBox", `0 0 ${viewportWidth} ${viewportHeight}`);

  const group = svg.append("g");
  zoomBehavior = d3
    .zoom<SVGSVGElement, unknown>()
    .scaleExtent([0.06, 3])
    .on("zoom", (event) => group.attr("transform", event.transform));

  const fitScale = Math.max(
    0.06,
    Math.min(1, viewportWidth / graph.width, viewportHeight / graph.height),
  );
  defaultTransform = d3.zoomIdentity.translate(40, 34).scale(0.92);
  fitTransform = d3.zoomIdentity.translate(26, 28).scale(fitScale);
  svg.call(zoomBehavior).call(zoomBehavior.transform, defaultTransform);

  renderColumnBands(group, graph);

  group
    .append("g")
    .attr("class", "edge-layer")
    .selectAll<SVGPathElement, GraphEdgeDatum>("path")
    .data(graph.edges)
    .join("path")
    .attr("class", (edge) => `graph-edge${isEdgeDimmed(edge, viewState) ? " dimmed" : ""}`)
    .attr("d", edgePath);

  const node = group
    .append("g")
    .attr("class", "node-layer")
    .selectAll("g.graph-node")
    .data(graph.nodes)
    .join("g")
    .attr("class", (item) => graphNodeClass(item, viewState))
    .attr("transform", (item) => `translate(${item.x},${item.y})`)
    .on("click", (event, item) => {
      event.stopPropagation();
      viewState.selectedId = item.id;
      updateSelectedNodeClasses();
      renderDetail(item);
    });

  node
    .append("rect")
    .attr("width", (item) => item.width)
    .attr("height", (item) => item.height)
    .attr("rx", 8);

  node
    .append("text")
    .attr("class", "type")
    .attr("x", 12)
    .attr("y", 17)
    .text((item) => nodeTypeLabel(item));

  node
    .append("text")
    .attr("class", "count")
    .attr("x", (item) => item.width - 12)
    .attr("y", 17)
    .attr("text-anchor", "end")
    .text((item) =>
      item.members.length > 1 ? `x${numberFormat.format(item.members.length)}` : "",
    );

  node
    .append("text")
    .attr("class", "title")
    .attr("x", 12)
    .attr("y", 39)
    .text((item) => shortText(item.title, 30));

  node
    .append("text")
    .attr("class", "subtitle")
    .attr("x", 12)
    .attr("y", 58)
    .text((item) => shortText(item.subtitle, 34));
}

function renderDetail(graphNode?: GraphNodeDatum): void {
  if (!graphNode) {
    elements.nodePopover.hidden = true;
    elements.reviewButtons.replaceChildren();
    elements.detailPath.replaceChildren();
    return;
  }

  const node = graphNode.representative;
  elements.nodePopover.hidden = false;
  elements.detailTitle.textContent = graphNode.title;
  elements.detailKind.textContent = [
    graphNode.kind,
    graphNode.members.length > 1
      ? `命中 ${numberFormat.format(graphNode.members.length)} 条 trace`
      : "",
    node.decision ? decisionLabel(node.decision) : "",
  ]
    .filter(Boolean)
    .join(" · ");
  elements.detailContext.textContent = contextLabel(graphNode.context);
  elements.detailText.textContent = graphNode.detail;
  elements.detailE2e.textContent = node.e2e ?? node.decision?.assertion ?? "-";
  renderReviewButtons(graphNode);

  const path = findPath(viewState.root, node.id);
  elements.detailPath.replaceChildren(
    ...path.map((item) => {
      const li = document.createElement("li");
      li.textContent = `${item.kind}: ${item.title}`;
      return li;
    }),
  );
}

function renderReviewButtons(graphNode = selectedGraphNode()): void {
  const node = graphNode?.representative;
  elements.reviewButtons.replaceChildren(
    ...statusOptions.map((status) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `review-button${node?.caseId && viewState.review[node.caseId] === status ? " active" : ""}`;
      button.textContent = status;
      button.disabled = !node?.caseId;
      button.addEventListener("click", () => {
        if (!node?.caseId) {
          return;
        }
        viewState.review[node.caseId] = status;
        localStorage.setItem(reviewKey, JSON.stringify(viewState.review));
        renderReviewButtons(graphNode);
      });
      return button;
    }),
  );
}

function updateSelectedNodeClasses(): void {
  d3.select(elements.tree)
    .selectAll<SVGGElement, GraphNodeDatum>("g.graph-node")
    .attr("class", (item) => graphNodeClass(item, viewState));
}

function selectedGraphNode(): GraphNodeDatum | undefined {
  if (!viewState.selectedId) {
    return undefined;
  }
  return graphNodeIndex.get(viewState.selectedId);
}

function exportCases(): void {
  const cases = buildCaseRows(viewState.nodes, viewState.review, viewState.root);
  const blob = new Blob([JSON.stringify(cases, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "conversation-state-space-cases.json";
  link.click();
  URL.revokeObjectURL(url);
}

function applyTransform(transform: d3.ZoomTransform | null): void {
  if (!zoomBehavior || !transform) {
    return;
  }
  d3.select(elements.tree).transition().duration(180).call(zoomBehavior.transform, transform);
}

function zoomBy(factor: number): void {
  if (!zoomBehavior) {
    return;
  }
  d3.select(elements.tree).transition().duration(180).call(zoomBehavior.scaleBy, factor);
}

function sampleRuleText(ruleId: string): string {
  const node = viewState.nodes.find((item) => item.decision?.ruleId === ruleId);
  return node?.decision?.reason ?? "规则命中路径";
}

function mustQuery<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Missing element: ${selector}`);
  }
  return element;
}
