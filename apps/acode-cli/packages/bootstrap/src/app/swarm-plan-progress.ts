// 编排方案 Phase 2 / P2a（specs/swarm-observability-projection.md R2/R7）：plan → 有界
// 投影载荷的 mapper。词表与界的**编译期闸**在本文件的 typed 赋值（core 状态视图 →
// contracts payload；shared 不反向依赖 contracts，运行期闸是 shared reducer 的
// safeParse）。发射面（swarm-plan-runtime 的 onChange/hydrate）与冷回放读取口
// （readPlanProgress → v4-bridge 合成事件）都只经这一份，两个消费者不会各自漂移。

import type { SwarmPlanProgressPayload, SwarmTaskPlan } from "@acode/contracts";
import { buildSwarmPlanStatus } from "@acode/core";
import { SWARM_PLAN_LIMITS } from "@acode/shared/acode-protocol-v4";

/** plan → 有界投影载荷（spec R7：nodes 截断 + truncated 置位，content 只带 preview）。 */
export function buildSwarmPlanProgressPayload(plan: SwarmTaskPlan): SwarmPlanProgressPayload {
  const status = buildSwarmPlanStatus(plan);
  const truncated = status.nodes.length > SWARM_PLAN_LIMITS.maxNodes;
  const views = status.nodes.slice(0, SWARM_PLAN_LIMITS.maxNodes);
  // 状态视图不背 20k 全文（projection.ts 的摘要纪律）：preview 从 plan 节点原文截取。
  const contentById = new Map(plan.nodes.map((node) => [node.id, node.content]));
  return {
    counts: status.counts,
    createdAtMs: plan.createdAtMs,
    goal: status.goal.slice(0, SWARM_PLAN_LIMITS.maxGoalLength),
    mode: status.mode,
    noArtifactRequeues: status.noArtifactRequeues,
    nodes: views.map((node) => {
      const content = contentById.get(node.id);
      const contentPreview =
        content === undefined ? undefined : content.slice(0, SWARM_PLAN_LIMITS.maxNodeContentPreviewLength);
      return {
        artifactRequeues: node.artifactRequeues,
        dependsOn: node.dependsOn.slice(0, SWARM_PLAN_LIMITS.maxNodeDepends),
        expanded: node.expanded,
        id: node.id,
        isGate: node.isGate,
        kind: node.kind,
        origin: node.origin,
        owner: node.owner,
        priority: node.priority,
        status: node.status,
        ...(contentPreview ? { contentPreview } : {}),
      };
    }),
    readyGateIds: status.readyGateIds.slice(0, SWARM_PLAN_LIMITS.maxIdListEntries),
    readyWorkerIds: status.readyWorkerIds.slice(0, SWARM_PLAN_LIMITS.maxIdListEntries),
    stalledNodeIds: status.stalledNodeIds.slice(0, SWARM_PLAN_LIMITS.maxIdListEntries),
    terminalState: status.terminalState,
    ...(truncated ? { truncated: true } : {}),
    updatedAtMs: plan.updatedAtMs,
    version: status.version,
  };
}
