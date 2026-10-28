// 2026-12-31 例外债务偿还：自 main.ts 按职责拆出——review 持久化与 case 导出层
//（ReviewStatus/statusOptions/reviewKey、localStorage 回读 readReview、
// trace 路径查找 findPath、导出 JSON 行构建 buildCaseRows）。
// exportCases 的 DOM/Blob 下载部分仍留 main.ts；本叶除 readReview 的
// localStorage 读取外均为纯函数，可直接单测。逐字迁移，零行为改动。

import { contextLabel } from "./model.js";
import type { DecisionKind, TraceNode } from "./model.js";

export type ReviewStatus = "accepted" | "undefined" | "invalid" | "ignored" | "bug";

export const reviewKey = "acode.conversation-state-space.review.v1";
export const statusOptions: ReviewStatus[] = ["accepted", "undefined", "invalid", "ignored", "bug"];

// exportCases 的 cases 行类型：字段与原对象字面量逐名一致。
export interface CaseExportRow {
  id: string | undefined;
  status: string;
  title: string;
  context: string;
  decision: DecisionKind | undefined;
  ruleId: string | undefined;
  action: string | undefined;
  e2e: string | undefined;
  path: string[];
}

export function findPath(root: TraceNode, id: string): TraceNode[] {
  const path: TraceNode[] = [];
  const found = walk(root);
  return found ? path : [root];

  function walk(node: TraceNode): boolean {
    path.push(node);
    if (node.id === id) {
      return true;
    }
    for (const child of node.children) {
      if (walk(child)) {
        return true;
      }
    }
    path.pop();
    return false;
  }
}

export function readReview(): Record<string, ReviewStatus> {
  try {
    return JSON.parse(localStorage.getItem(reviewKey) || "{}") as Record<string, ReviewStatus>;
  } catch {
    return {};
  }
}

export function buildCaseRows(
  nodes: TraceNode[],
  review: Record<string, ReviewStatus>,
  root: TraceNode,
): CaseExportRow[] {
  return nodes
    .filter((node) => node.kind === "case")
    .map((node) => ({
      id: node.caseId,
      status: node.caseId ? (review[node.caseId] ?? "unreviewed") : "unreviewed",
      title: node.subtitle,
      context: contextLabel(node.context),
      decision: node.decision?.kind,
      ruleId: node.decision?.ruleId,
      action: node.candidate?.label,
      e2e: node.e2e,
      path: findPath(root, node.id).map((item) => item.title),
    }));
}
