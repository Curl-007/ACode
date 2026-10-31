// 2026-12-31 例外债务偿还：自 main.ts 按职责拆出——画布渲染预算层
//（cloneForRender 按预算折叠 trace 树 + summaryNode/countNodes 聚合节点构造）。
// 逐字迁移，零行为改动；numberFormat 为叶内私有实例，与 main.ts 同 locale。
// 本叶不依赖 d3/DOM，可直接单测。

import type { TraceNode } from "./model.js";

export interface RenderBudget {
  remaining: number;
}

const numberFormat = new Intl.NumberFormat("zh-CN");

export function cloneForRender(node: TraceNode, budget: RenderBudget): TraceNode {
  if (budget.remaining <= 0) {
    return summaryNode(node, 1);
  }
  budget.remaining -= 1;
  const children: TraceNode[] = [];
  let hidden = 0;

  for (const child of node.children) {
    if (budget.remaining <= 0) {
      hidden += countNodes(child);
      continue;
    }
    children.push(cloneForRender(child, budget));
  }

  if (hidden > 0) {
    children.push(summaryNode(node, hidden));
  }

  return { ...node, children };
}

function summaryNode(parent: TraceNode, hidden: number): TraceNode {
  return {
    id: `${parent.id}-summary-${hidden}`,
    kind: "summary",
    title: `聚合 ${numberFormat.format(hidden)} 个节点`,
    subtitle: "超过当前渲染预算",
    detail: "完整语义仍然参与统计和 JSON 导出，只是画布里折叠显示。",
    context: parent.context,
    children: [],
  };
}

function countNodes(node: TraceNode): number {
  let count = 1;
  for (const child of node.children) {
    count += countNodes(child);
  }
  return count;
}
