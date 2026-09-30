// 机制参照 jcode (MIT) crates/jcode-plan/src/dag/ops.rs（validate_gate_pass 三段检查 /
// mentions_node_id 词边界匹配 / GATE_COVERAGE_ENUMERATION_CAP），自撰实现。
// 产品规则见 specs/workflow-typed-artifacts.md R5-R7、R9。
//
// critic 不能橡皮图章：pass 裁决必须按节点 id 逐一点名审计范围内的 done 节点。
// 分档：light 只强制置信度债务（low 节点未被点名 → 拒绝，路由成后续工作）；
// deep 追加 stale scope 与覆盖债务。全部是纯函数——裁决落事件与重跑通道由
// critic-loop / node-runner 负责，本模块不持状态。

import {
  type WorkflowArtifactConfidence,
  type WorkflowCriticResult,
  type WorkflowDefinition,
  type WorkflowGatePreset,
  type WorkflowGraphNode,
  type WorkflowNodeStatus,
  type WorkflowRunSnapshot,
} from "@acode/contracts";
import { COMPLETED_NODE_STATUSES } from "./scheduler/graph.js";

/**
 * 审计节点数超过该值后，passing critic 不再要求逐个点名全部 done 节点（清单会退化成
 * 流水账），只要求非 high-confidence 节点必须点名（与 jcode GATE_COVERAGE_ENUMERATION_CAP
 * 同一权衡：范围最宽时审计严谨度不允许静默降级）。
 */
export const CRITIC_COVERAGE_ENUMERATION_CAP = 20;

/** deep 档 artifact-or-nothing 的缺省 requeue 封顶：requeue 一次、第二次 fail。 */
export const DEFAULT_MAX_ARTIFACT_REQUEUES = 1;

export interface WorkflowGateSettings {
  maxArtifactRequeues: number;
  preset: WorkflowGatePreset;
}

/** gate 设置的唯一解析入口（R9）：definition 未声明 gatePolicy → light + 缺省封顶。 */
export function resolveWorkflowGateSettings(
  definition: Pick<WorkflowDefinition, "gatePolicy">,
): WorkflowGateSettings {
  const policy = definition.gatePolicy;
  return {
    maxArtifactRequeues: policy?.maxArtifactRequeues ?? DEFAULT_MAX_ARTIFACT_REQUEUES,
    preset: policy?.preset ?? "light",
  };
}

const ID_CHAR_PATTERN = /[A-Za-z0-9\-_.:]/;

/**
 * 自由文本是否按独立 token 点名了节点 id（词边界匹配，防短 id 误命中：裸 contains 会让
 * "a" 命中几乎所有英文句子，橡皮图章就能蒙混过置信度债务）。
 * 边界 = 任意非 id 字符；id 字符 = 字母数字 + `-_.:`。结尾的 `.`/`:` 既是合法 id 字符又是
 * 常见标点，只有后随另一个 id 字符时才视为 id 的延伸——"checked node.a." 句尾算点名，
 * "node.a.b" 是另一个 id。
 */
export function mentionsNodeId(text: string, id: string): boolean {
  if (id.length === 0) return false;
  let searchFrom = 0;
  while (searchFrom <= text.length - id.length) {
    const begin = text.indexOf(id, searchFrom);
    if (begin < 0) return false;
    const end = begin + id.length;
    const beforeOk = begin === 0 || !ID_CHAR_PATTERN.test(text[begin - 1]!);
    const afterChar = end < text.length ? text[end]! : undefined;
    let afterOk: boolean;
    if (afterChar === undefined) {
      afterOk = true;
    } else if (afterChar === "." || afterChar === ":") {
      const next = end + 1 < text.length ? text[end + 1]! : undefined;
      afterOk = next === undefined || !ID_CHAR_PATTERN.test(next);
    } else {
      afterOk = !ID_CHAR_PATTERN.test(afterChar);
    }
    if (beforeOk && afterOk) return true;
    searchFrom = begin + 1;
  }
  return false;
}

export interface CriticAuditNode {
  confidence?: WorkflowArtifactConfidence;
  id: string;
  status: WorkflowNodeStatus;
}

/**
 * gate 语义下的「worker 节点」唯一判定（评审 J2 修复）。
 *
 * typed artifact 强制（R4 artifact-or-nothing）与 critic 审计范围（R5）都只针对
 * scheduled graph 的 **task** 节点；phase 节点是阶段容器/引擎簿记，spec 边界明文：
 * 「phase 级 agent 产物不强制 typed 段：artifact-or-nothing 只约束 scheduled graph 的
 * worker 节点（jcode deep 亦只对 worker 强制）」。
 *
 * 为什么必须显式排除：scheduled 阶段没有 task 节点时（例如 arch_decompose 那一轮没产出
 * 可解析的图，seedGraphFromPhaseArtifact 原样返回），executableNodeIdsForPhase 会回退
 * 派发 phase 容器节点（expert/ids.ts:15），而它的提示词走 buildScheduledNodePrompt 的
 * phase 早退分支 → buildPhasePrompt，deep 契约段只在 `behavior === "critic"` 时追加
 * （expert/prompts.ts:41-44,80-82），requeue 反馈段（deepNodePromptLines）也只在 task
 * 分支——对这种节点强制等于「不告知规则却判违规」，必然 requeue 一次再 fail，
 * 整个 run 停在 `scheduler paused`。light 档不强制，所以既有 run 不受影响。
 */
export function isArtifactGateWorkerNode(node: Pick<WorkflowGraphNode, "kind">): boolean {
  return node.kind === "task";
}

/**
 * critic 审计范围：本 run 全部 task 节点（phase 节点是阶段容器/引擎簿记，不是工作单元，
 * 且 critic 自己的 phase 节点在裁决时尚未 done，故排除）。confidence 经
 * 「节点 → 最新 completed activity 的 artifactPath → snapshot.artifacts[path].typed」解析。
 */
export function collectCriticAuditScope(snapshot: WorkflowRunSnapshot): CriticAuditNode[] {
  const confidenceByNodeId = collectNodeConfidence(snapshot);
  return snapshot.graph.nodes
    .filter((node) => isArtifactGateWorkerNode(node))
    .map((node) => ({
      ...(confidenceByNodeId.has(node.id)
        ? { confidence: confidenceByNodeId.get(node.id) }
        : {}),
      id: node.id,
      status: node.status,
    }));
}

/** critic 结论的机械化投影：能用来点名的文本 = reasoning + acceptanceGaps + reopenProposals。 */
export function collectCriticCoverageTexts(critic: WorkflowCriticResult): string[] {
  return [
    critic.reasoning,
    ...critic.acceptanceGaps,
    ...critic.reopenProposals.map((proposal) => `${proposal.nodeId}: ${proposal.reason}`),
  ];
}

export type CriticGateIssueKind =
  | "stale_gate_scope"
  | "unaddressed_low_confidence"
  | "uncovered_siblings";

export interface CriticGateIssue {
  kind: CriticGateIssueKind;
  nodeIds: string[];
}

/**
 * 对 critic 的 pass 裁决执行分档 gate 规则（R6），返回 issue 列表（空 = 放行）。
 * most-specific first（与 jcode validate_gate_pass 同序）：stale → 置信度债务 → 覆盖债务。
 * 置信度债务两档都强制（light 的唯一轻量规则）；stale/覆盖债务仅 deep。
 */
export function evaluateCriticGate(input: {
  coverageTexts: readonly string[];
  preset: WorkflowGatePreset;
  scope: readonly CriticAuditNode[];
}): CriticGateIssue[] {
  const deep = input.preset === "deep";
  const done = input.scope.filter((node) => COMPLETED_NODE_STATUSES.has(node.status));
  const addressed = (id: string): boolean =>
    input.coverageTexts.some((text) => mentionsNodeId(text, id));
  const issues: CriticGateIssue[] = [];

  if (deep) {
    const stale = input.scope
      .filter((node) => !COMPLETED_NODE_STATUSES.has(node.status))
      .map((node) => node.id);
    if (stale.length > 0) {
      issues.push({ kind: "stale_gate_scope", nodeIds: stale });
    }
  }

  const lowConfidence = done
    .filter((node) => node.confidence === "low" && !addressed(node.id))
    .map((node) => node.id);
  if (lowConfidence.length > 0) {
    issues.push({ kind: "unaddressed_low_confidence", nodeIds: lowConfidence });
  }

  if (deep) {
    const enumerable =
      done.length <= CRITIC_COVERAGE_ENUMERATION_CAP
        ? done
        : done.filter((node) => node.confidence !== "high");
    const uncovered = enumerable.filter((node) => !addressed(node.id)).map((node) => node.id);
    if (uncovered.length > 0) {
      issues.push({ kind: "uncovered_siblings", nodeIds: uncovered });
    }
  }

  return issues;
}

const ISSUE_LABELS: Record<CriticGateIssueKind, string> = {
  stale_gate_scope: "audit scope has nodes that are not done",
  unaddressed_low_confidence: "low-confidence nodes not addressed by id",
  uncovered_siblings: "done nodes not addressed by id",
};

export function describeCriticGateIssues(issues: readonly CriticGateIssue[]): string {
  return issues
    .map((issue) => `${ISSUE_LABELS[issue.kind]}: ${issue.nodeIds.join(", ")}`)
    .join("; ");
}

/**
 * 覆盖/stale 债务的补充要求（R7）：注入下一轮 critic 提示词尾部，点名缺失清单。
 * 这是引擎侧的「拒绝并要求补充」通道——expert workflow 子会话没有
 * respond-to-coordinator/submit_result 端口，修复语义与 submit-result reject→violations
 * 同构：拒绝理由存活到模型可见的下一轮输入。
 */
export function buildCriticSupplementRequest(issues: readonly CriticGateIssue[]): string {
  return [
    "The workflow engine rejected your previous pass verdict: the audit did not cover every done node.",
    ...issues.map((issue) => `- ${ISSUE_LABELS[issue.kind]}: ${issue.nodeIds.join(", ")}`),
    "Re-audit and name each node id above explicitly in your reasoning (one verdict per node). A pass verdict that skips any of them will be rejected again.",
  ].join("\n");
}

/** deep 档 critic 提示词追加段（R8）：点名契约 + 当前 done 节点清单。light 档不追加。 */
export function deepCriticPromptLines(snapshot: WorkflowRunSnapshot): string[] {
  const done = collectCriticAuditScope(snapshot).filter((node) =>
    COMPLETED_NODE_STATUSES.has(node.status),
  );
  return [
    "",
    "Critic gate contract (deep):",
    "Your verdict JSON must address every done node below by its exact node id in reasoning (one line per node). A pass verdict that does not name all of them is rejected by the engine.",
    done.length > 0
      ? done
          .map(
            (node) =>
              `- ${node.id} [${node.status}${node.confidence ? ` confidence=${node.confidence}` : ""}]`,
          )
          .join("\n")
      : "- (no done task nodes)",
    "Nodes that self-reported confidence=low must be explicitly addressed (propose a reopen or state why they are acceptable); the engine rejects a pass that skips them.",
  ];
}

function collectNodeConfidence(
  snapshot: WorkflowRunSnapshot,
): Map<string, WorkflowArtifactConfidence> {
  const artifactByPath = new Map(snapshot.artifacts.map((artifact) => [artifact.path, artifact]));
  const latestPathByNodeId = new Map<string, string>();
  for (const activity of snapshot.activities) {
    if (activity.status !== "completed" || !activity.nodeId || !activity.artifactPath) continue;
    // activities 按时序追加（upsertActivity 尾插），后出现的 completed 覆盖先前尝试。
    latestPathByNodeId.set(activity.nodeId, activity.artifactPath);
  }
  const confidenceByNodeId = new Map<string, WorkflowArtifactConfidence>();
  for (const [nodeId, path] of latestPathByNodeId) {
    const confidence = artifactByPath.get(path)?.typed?.confidence;
    if (confidence) confidenceByNodeId.set(nodeId, confidence);
  }
  return confidenceByNodeId;
}
