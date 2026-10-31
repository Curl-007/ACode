// 2026-12-31 例外债务偿还：自 ../model.ts 按职责拆出——trace 构建与统计层
//（节点编号计数、上下文标签/key、候选枚举、trace 树构建、统计与扁平化、
// 节点构造 helper、E2E 断言文案）。模型唯一可变状态 nextNodeId/nextCaseId
// 随本叶持有，buildTraceTree 入口仍先 resetIds()，确定性编号语义不变。
// 逐字迁移，零行为改动。

import { evaluate, isSystemCandidateApplicable } from "./evaluate.js";
import { systemCandidates, userCandidates } from "./profiles.js";
import type {
  Candidate,
  Decision,
  ProductContext,
  TraceNode,
  TraceStats,
} from "./types.js";

let nextNodeId = 0;
let nextCaseId = 0;

export function resetIds(): void {
  nextNodeId = 0;
  nextCaseId = 0;
}

export function contextLabel(context: ProductContext): string {
  return [
    `phase=${context.runPhase}`,
    `queue=${context.queue}`,
    `compact=${context.compactMemory}`,
    context.canCompactAgain ? "canCompactAgain" : "cannotCompactAgain",
    `goal=${context.goal}`,
    `turn=${context.selectedTurn}`,
    context.forked ? "forked" : "notForked",
  ].join(" / ");
}

export function contextKey(context: ProductContext): string {
  return [
    context.runPhase,
    context.queue,
    context.compactMemory,
    String(context.canCompactAgain),
    context.goal,
    context.selectedTurn,
    String(context.forked),
  ].join("|");
}

export function enumerateCandidates(context: ProductContext): Candidate[] {
  const events = systemCandidates.filter((candidate) =>
    isSystemCandidateApplicable(context, candidate),
  );
  return [...userCandidates, ...events];
}

export function buildTraceTree(context: ProductContext, maxRounds: number): TraceNode {
  resetIds();
  return buildStateNode(context, 1, maxRounds, new Map());
}

export function collectStats(root: TraceNode): TraceStats {
  const stats = {
    nodes: 0,
    cases: 0,
    rejects: 0,
    undefined: 0,
    enqueued: 0,
    allowed: 0,
    choices: 0,
    system: 0,
  };

  visit(root, (node) => {
    stats.nodes += 1;
    if (node.kind === "case") {
      stats.cases += 1;
    }
    if (node.decision?.kind === "reject") {
      stats.rejects += 1;
    }
    if (node.decision?.kind === "undefined") {
      stats.undefined += 1;
    }
    if (node.decision?.kind === "enqueue") {
      stats.enqueued += 1;
    }
    if (node.decision?.kind === "allow") {
      stats.allowed += 1;
    }
    if (node.decision?.kind === "choice") {
      stats.choices += 1;
    }
    if (node.decision?.kind === "system") {
      stats.system += 1;
    }
  });

  return stats;
}

export function flatten(root: TraceNode): TraceNode[] {
  const nodes: TraceNode[] = [];
  visit(root, (node) => nodes.push(node));
  return nodes;
}

export function decisionLabel(decision: Decision): string {
  if (decision.kind === "reject") {
    return `reject · ${decision.title}`;
  }
  if (decision.kind === "enqueue") {
    return `enqueue · ${decision.title}`;
  }
  if (decision.kind === "allow") {
    return `allow · ${decision.title}`;
  }
  if (decision.kind === "choice") {
    return `choice · ${decision.title}`;
  }
  if (decision.kind === "system") {
    return `system · ${decision.title}`;
  }
  return `undefined · ${decision.title}`;
}

function visit(node: TraceNode, fn: (node: TraceNode) => void): void {
  fn(node);
  for (const child of node.children) {
    visit(child, fn);
  }
}

function buildStateNode(
  context: ProductContext,
  round: number,
  maxRounds: number,
  seen: Map<string, number>,
): TraceNode {
  const node = makeNode({
    kind: "state",
    title: `S${round}: ${context.runPhase}`,
    subtitle: contextLabel(context),
    detail: "可见产品上下文。下一层会对所有候选动作做笛卡尔积枚举，再用产品 guard 剪枝。",
    context,
    children: [],
  });

  if (round > maxRounds) {
    return makeCaseNode(
      node,
      "到达轮次上限",
      "这条 trace 已到达当前枚举深度，需要人工 review 是否继续展开。",
    );
  }

  const loopKey = `${round}:${contextKey(context)}`;
  const visited = seen.get(loopKey) ?? 0;
  if (visited > 1) {
    return makeCaseNode(node, "重复上下文", "模型再次到达相同上下文；这里应判断是否合并为等价类。");
  }
  const nextSeen = new Map(seen);
  nextSeen.set(loopKey, visited + 1);

  node.children.push(
    ...enumerateCandidates(context).map((candidate) =>
      buildCandidateNode(context, candidate, round, maxRounds, nextSeen),
    ),
  );
  return node;
}

function buildCandidateNode(
  context: ProductContext,
  candidate: Candidate,
  round: number,
  maxRounds: number,
  seen: Map<string, number>,
): TraceNode {
  const decision = evaluate(context, candidate);
  const candidateNode = makeNode({
    kind: "candidate",
    title: candidate.label,
    subtitle: `${candidate.kind} / ${candidate.surface}`,
    detail: `候选组合：${contextLabel(context)} × ${candidate.label}`,
    context,
    candidate,
    children: [],
  });
  const guardNode = makeNode({
    kind: "guard",
    title: decisionLabel(decision),
    subtitle: decision.ruleId,
    detail: decision.reason,
    context,
    candidate,
    decision,
    children: [],
  });
  const effectNode = makeNode({
    kind: "effect",
    title: effectTitle(decision),
    subtitle: decision.assertion,
    detail: decision.next
      ? contextLabel(decision.next)
      : "无下一状态：路径在这里被剪枝或等待产品定义。",
    context: decision.next ?? context,
    candidate,
    decision,
    children: [],
  });

  // choice 不展开下一状态：clear/keep 两个 disposition 都终到 completedCanSend 路径。
  if (
    decision.next &&
    decision.kind !== "reject" &&
    decision.kind !== "undefined" &&
    decision.kind !== "choice"
  ) {
    effectNode.children.push(buildStateNode(decision.next, round + 1, maxRounds, seen));
  } else {
    effectNode.children.push(
      makeCaseNode(effectNode, decision.title, decision.assertion, candidate, decision),
    );
  }

  guardNode.children.push(effectNode);
  candidateNode.children.push(guardNode);
  return candidateNode;
}

function makeCaseNode(
  base: TraceNode,
  title: string,
  detail: string,
  candidate?: Candidate,
  decision?: Decision,
): TraceNode {
  nextCaseId += 1;
  const caseId = `CASE-${String(nextCaseId).padStart(5, "0")}`;
  return makeNode({
    kind: "case",
    title: caseId,
    subtitle: title,
    detail,
    context: base.context,
    candidate,
    decision,
    caseId,
    e2e: buildE2eAssertion(base.context, candidate, decision),
    children: [],
  });
}

function makeNode(input: Omit<TraceNode, "id">): TraceNode {
  nextNodeId += 1;
  return {
    ...input,
    id: `n-${nextNodeId}`,
  };
}

function effectTitle(decision: Decision): string {
  if (decision.kind === "reject") {
    return "剪枝：显示明确拒绝";
  }
  if (decision.kind === "enqueue") {
    return "副作用：进入消息队列";
  }
  if (decision.kind === "allow") {
    return "副作用：动作生效";
  }
  if (decision.kind === "system") {
    return "系统事件：推进阶段";
  }
  if (decision.kind === "choice") {
    return "阻塞：等待用户裁决 queue disposition";
  }
  return "未定义：需要产品 review";
}

function buildE2eAssertion(
  context: ProductContext,
  candidate?: Candidate,
  decision?: Decision,
): string {
  if (!candidate || !decision) {
    return "记录当前 trace，并判断是否需要继续展开。";
  }
  if (decision.kind === "reject") {
    return `Given ${contextLabel(context)}, when ${candidate.label}, then show "${decision.title}" and no forbidden side effect occurs.`;
  }
  if (decision.kind === "enqueue") {
    return `Given ${contextLabel(context)}, when ${candidate.label}, then queue state becomes ${decision.next?.queue ?? "unknown"}.`;
  }
  if (decision.kind === "allow") {
    return `Given ${contextLabel(context)}, when ${candidate.label}, then transition to ${decision.next ? contextLabel(decision.next) : "next context"}.`;
  }
  if (decision.kind === "system") {
    return `Given ${contextLabel(context)}, when system emits ${candidate.label}, then reconcile to ${decision.next ? contextLabel(decision.next) : "next context"}.`;
  }
  return `Given ${contextLabel(context)}, when ${candidate.label}, product expectation is undefined and must be reviewed.`;
}
