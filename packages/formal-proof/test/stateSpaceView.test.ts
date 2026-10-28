/**
 * 2026-12-31 例外债务偿还：main.ts 拆出的纯逻辑叶子单测。
 *
 * 覆盖叶片：
 *  A. graphModel.ts——buildStateSpaceGraph 等价节点合并投影、graphNodeId 形状、
 *     columnLabel/decisionRank/graphSortKey、edgePath 几何、graphNodeClass 的
 *     GraphViewFilter 高亮/选中语义（原闭包读 viewState，拆叶后显式入参）。
 *  B. renderBudget.ts——cloneForRender 按预算折叠 trace 树为 summary 节点。
 *  C. reviewCases.ts——findPath 路径查找、buildCaseRows 导出行、readReview 容错。
 *  D. appShell.ts——renderAppShell HTML 骨架含全部控件锚点与 profiles 选项。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { renderAppShell } from "../src/appShell.js";
import {
  buildStateSpaceGraph,
  columnLabel,
  decisionRank,
  edgePath,
  graphNodeClass,
  graphNodeId,
  graphSortKey,
  isEdgeDimmed,
  nodeTypeLabel,
  shortText,
  type GraphNodeDatum,
  type GraphViewFilter,
} from "../src/graphModel.js";
import {
  buildTraceTree,
  flatten,
  profiles,
  type Candidate,
  type Decision,
  type ProductContext,
  type TraceNode,
} from "../src/model.js";
import { cloneForRender } from "../src/renderBudget.js";
import { buildCaseRows, findPath, readReview } from "../src/reviewCases.js";

function ctx(overrides: Partial<ProductContext> = {}): ProductContext {
  return {
    runPhase: "completed",
    queue: "empty",
    compactMemory: "compactable",
    canCompactAgain: true,
    goal: "active",
    selectedTurn: "latest",
    forked: false,
    ...overrides,
  };
}

function makeNode(id: string, kind: TraceNode["kind"], children: TraceNode[] = []): TraceNode {
  return {
    id,
    kind,
    title: `title-${id}`,
    subtitle: `subtitle-${id}`,
    detail: `detail-${id}`,
    context: ctx(),
    children,
  };
}

const candidate: Candidate = {
  id: "sendText",
  kind: "user",
  label: "继续发送文字",
  target: "none",
  surface: "composer",
};

const rejectDecision: Decision = {
  kind: "reject",
  ruleId: "idleCannotFork",
  title: "没有可 fork 轮次",
  reason: "没有完成轮次时 fork 应禁用。",
  assertion: "这条路径必须显示明确反馈，并且不能产生被禁止的副作用。",
};

function datumOf(node: TraceNode, overrides: Partial<GraphNodeDatum> = {}): GraphNodeDatum {
  // 字段拷贝关系与 buildStateSpaceGraph 的 datum 构造逐名一致。
  return {
    id: node.id,
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
    column: 0,
    x: 0,
    y: 0,
    width: 252,
    height: 76,
    ...overrides,
  };
}

const viewAll: GraphViewFilter = { activeRule: "all", activeDecision: "all", selectedId: "" };

// ── A. graphModel ──────────────────────────────────────────────────────────
test("buildStateSpaceGraph：列按 round×5+slot 编码且节点坐标落在列内", () => {
  const root = buildTraceTree(profiles[0].context, 1);
  const graph = buildStateSpaceGraph(root);
  assert.ok(graph.nodes.length > 0);
  assert.deepEqual(
    graph.columns,
    [...graph.columns].sort((a, b) => a - b),
  );
  for (const node of graph.nodes) {
    assert.ok(node.x >= 28);
    assert.ok(node.y >= 114);
    assert.equal(node.height, 76);
  }
  for (const edge of graph.edges) {
    assert.ok(graph.nodes.includes(edge.source));
    assert.ok(graph.nodes.includes(edge.target));
  }
  assert.ok(graph.width > 0 && graph.height > 0);
});

test("buildStateSpaceGraph：相同上下文 key 的 state 节点合并为一个 datum 并累计 members", () => {
  const shared = ctx({ runPhase: "running" });
  const a = { ...makeNode("s1", "state"), context: shared };
  const b = { ...makeNode("s2", "state"), context: shared };
  const root: TraceNode = { ...makeNode("root", "state"), children: [a, b] };
  const graph = buildStateSpaceGraph(root);
  const merged = graph.nodes.find((node) => node.members.length > 1);
  assert.ok(merged, "两个同上下文同轮的 state 应合并");
  assert.equal(merged.members.length, 2);
});

test("graphNodeId：state/candidate/guard/effect/case/summary 各 kind 的 id 形状稳定", () => {
  const state = makeNode("n1", "state");
  assert.equal(graphNodeId(state, undefined, 0), `state:1:completed|empty|compactable|true|active|latest|false`);
  const cand: TraceNode = { ...makeNode("n2", "candidate"), candidate };
  assert.equal(graphNodeId(cand, "parent", 1), "parent:action:sendText");
  const guard: TraceNode = { ...makeNode("n3", "guard"), decision: rejectDecision };
  assert.equal(graphNodeId(guard, "parent", 2), "parent:guard:reject:idleCannotFork");
  const effect: TraceNode = { ...makeNode("n4", "effect"), decision: rejectDecision };
  assert.equal(
    graphNodeId(effect, "parent", 3),
    `parent:effect:reject:idleCannotFork:completed|empty|compactable|true|active|latest|false`,
  );
  const caseNode: TraceNode = { ...makeNode("n5", "case"), caseId: "CASE-00001" };
  assert.equal(graphNodeId(caseNode, "parent", 4), "case:CASE-00001");
  const summary = makeNode("n6", "summary");
  assert.equal(graphNodeId(summary, "parent", 4), "parent:summary:title-n6");
});

test("columnLabel / decisionRank / graphSortKey：列标签与排序键稳定", () => {
  assert.equal(columnLabel(0), "R1 · State");
  assert.equal(columnLabel(4), "Case / Review");
  assert.equal(columnLabel(5), "R2 · State");
  assert.equal(decisionRank("reject"), 1);
  assert.equal(decisionRank("allow"), 4);
  assert.equal(decisionRank("system"), 5);
  const withDecision = datumOf(makeNode("a", "guard"), { decision: rejectDecision });
  assert.equal(graphSortKey(withDecision), "1|guard|idleCannotFork|title-a|subtitle-a");
  const noDecision = datumOf(makeNode("b", "state"));
  assert.equal(graphSortKey(noDecision), "0|state||title-b|subtitle-b");
});

test("edgePath：贝塞尔路径从 source 右缘中点到 target 左缘中点", () => {
  const source = datumOf(makeNode("s", "state"), { x: 10, y: 20, width: 100, height: 40 });
  const target = datumOf(makeNode("t", "state"), { x: 210, y: 60, width: 100, height: 40 });
  assert.equal(edgePath({ id: "s->t", source, target }), "M110,40 C160,40 160,80 210,80");
});

test("graphNodeClass / isEdgeDimmed：GraphViewFilter 高亮、选中与 long-task 语义", () => {
  // member（TraceNode）必须自带 decision：isGraphDimmed 读的是 member.decision。
  const runningNode: TraceNode = {
    ...makeNode("r", "state"),
    context: ctx({ runPhase: "running" }),
    decision: rejectDecision,
  };
  const running = datumOf(runningNode);
  assert.equal(graphNodeClass(running, viewAll), "graph-node state reject long-task");
  assert.equal(
    graphNodeClass(running, { ...viewAll, selectedId: "r" }),
    "graph-node state reject long-task selected",
  );
  // activeRule 不匹配任何 member → dimmed；isEdgeDimmed 需两端同时 dimmed。
  const dimmedView = { ...viewAll, activeRule: "noSuchRule" };
  assert.equal(graphNodeClass(running, dimmedView), "graph-node state reject long-task dimmed");
  const matchedView = { ...viewAll, activeRule: "idleCannotFork" };
  assert.ok(!graphNodeClass(running, matchedView).includes("dimmed"));
  const other = datumOf(makeNode("o", "state"));
  const edge = { id: "r->o", source: running, target: other };
  assert.equal(isEdgeDimmed(edge, dimmedView), true);
  assert.equal(isEdgeDimmed(edge, matchedView), false);
});

test("nodeTypeLabel / shortText：类型标签与截断", () => {
  assert.equal(
    nodeTypeLabel(datumOf({ ...makeNode("s", "state"), context: ctx({ runPhase: "running" }) })),
    "State · long task",
  );
  assert.equal(nodeTypeLabel(datumOf(makeNode("c", "candidate"), { candidate })), "User action");
  assert.equal(nodeTypeLabel(datumOf(makeNode("g", "guard"))), "Guard");
  assert.equal(nodeTypeLabel(datumOf(makeNode("e", "effect"))), "Effect");
  assert.equal(nodeTypeLabel(datumOf(makeNode("k", "case"))), "Case");
  assert.equal(nodeTypeLabel(datumOf(makeNode("m", "summary"))), "Folded");
  assert.equal(shortText("1234567890", 5), "1234...");
  assert.equal(shortText("1234", 5), "1234");
});

// ── B. renderBudget ────────────────────────────────────────────────────────
test("cloneForRender：预算充足时结构逐点等价（id 与 children 全保留）", () => {
  const tree: TraceNode = makeNode("root", "state", [
    makeNode("a", "candidate", [makeNode("g", "guard")]),
    makeNode("b", "candidate"),
  ]);
  const cloned = cloneForRender(tree, { remaining: 100 });
  assert.deepEqual(
    flatten(cloned).map((node) => node.id),
    ["root", "a", "g", "b"],
  );
});

test("cloneForRender：预算耗尽时折叠为 summary 节点并计入隐藏数", () => {
  const tree: TraceNode = makeNode("root", "state", [
    makeNode("a", "candidate"),
    makeNode("b", "candidate"),
    makeNode("c", "candidate"),
  ]);
  const cloned = cloneForRender(tree, { remaining: 2 });
  assert.equal(cloned.children.length, 2);
  assert.equal(cloned.children[0]?.id, "a");
  const summary = cloned.children[1];
  assert.equal(summary?.kind, "summary");
  assert.equal(summary?.id, "root-summary-2");
  assert.equal(summary?.context, cloned.context);
});

// ── C. reviewCases ─────────────────────────────────────────────────────────
test("findPath：命中返回 root→目标路径，未命中返回 [root]", () => {
  const leaf = makeNode("leaf", "case");
  const mid = makeNode("mid", "guard", [leaf]);
  const root = makeNode("root", "state", [mid]);
  assert.deepEqual(
    findPath(root, "leaf").map((node) => node.id),
    ["root", "mid", "leaf"],
  );
  assert.deepEqual(
    findPath(root, "missing").map((node) => node.id),
    ["root"],
  );
});

test("buildCaseRows：只导出 case 节点，status 取 review 表、缺省 unreviewed", () => {
  const caseNode: TraceNode = {
    ...makeNode("c1", "case"),
    caseId: "CASE-00001",
    decision: rejectDecision,
    candidate,
    e2e: "e2e-text",
  };
  const root = makeNode("root", "state", [caseNode, makeNode("s2", "state")]);
  const expectedContext =
    "phase=completed / queue=empty / compact=compactable / canCompactAgain / goal=active / turn=latest / notForked";
  const rows = buildCaseRows(flatten(root), { "CASE-00001": "accepted" }, root);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    id: "CASE-00001",
    status: "accepted",
    title: "subtitle-c1",
    context: expectedContext,
    decision: "reject",
    ruleId: "idleCannotFork",
    action: "继续发送文字",
    e2e: "e2e-text",
    path: ["title-root", "title-c1"],
  });
  const rowsDefault = buildCaseRows(flatten(root), {}, root);
  assert.equal(rowsDefault[0]?.status, "unreviewed");
});

test("readReview：无 localStorage 环境容错返回空表", () => {
  assert.deepEqual(readReview(), {});
});

// ── D. appShell ────────────────────────────────────────────────────────────
test("renderAppShell：骨架含全部控件锚点与每个 profile 选项", () => {
  const html = renderAppShell();
  for (const id of [
    "profileSelect",
    "roundSelect",
    "budgetSelect",
    "decisionSelect",
    "metricNodes",
    "ruleList",
    "tree",
    "nodePopover",
    "exportCases",
    "zoomIn",
    "zoomOut",
    "fitTree",
    "resetTree",
  ]) {
    assert.ok(html.includes(`id="${id}"`), `missing #${id}`);
  }
  for (const profile of profiles) {
    assert.ok(html.includes(`<option value="${profile.id}">${profile.label}</option>`));
  }
});
