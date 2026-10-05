// K2（specs/swarm-task-graph.md 接口章 + R4）从 node-runner 抽取的共享执行原语：
// 「子会话执行 + response→typed 提取 + artifact-or-nothing requeue 决策」。
//
// 为什么抽这里：expert workflow 的 node-runner 与 swarm runner 都需要同一套语义——
// 经 runner 跑一次子会话、从 response 尾部围栏块提取 typed artifact、deep 档缺失/薄
// artifact 时按「requeue 一次、再犯 fail」裁决（J2-3 specs/workflow-typed-artifacts.md
// R2-R4）。抽成纯原语后两侧消费同一实现，防止两份拷贝漂移（漂移的后果是不对称的
// requeue 封顶语义——同一份 artifact 在 expert 与 swarm 里得到不同的裁决）。
//
// 红线：expert 行为零回归。原语只是 node-runner 既有逻辑的**结构移动**——决策函数
// decideArtifactGateEnforcement 逐字节保留原 reason 映射与计数封顶表达式；expert 调用点
// 的事件序列、snapshot 写序、错误文案全部不变（workflow-typed-artifacts 全场景重跑钉住）。

import type { WorkflowArtifactTyped } from "@acode/contracts";
import {
  extractTypedArtifact,
  TYPED_ARTIFACT_FENCE,
  type ExtractTypedArtifactResult,
  validateDeepNodeArtifact,
} from "../typed-artifact.js";
import type {
  WorkflowGraphSchedulerActivityInput,
  WorkflowGraphSchedulerActivityResult,
} from "./types.js";

/**
 * artifact-or-nothing 的封顶裁决（纯决策，无 IO、无状态写入）：
 * - `reasons`：拒绝原因（J2-3 reason 映射的唯一实现——valid 走 validateDeepNodeArtifact、
 *   invalid 透传提取 reasons、absent 合成围栏块提示文案）；
 * - `artifactRequeues`：prior+1（本次违规后的节点级累计）；
 * - `willRequeue`：`artifactRequeues <= maxArtifactRequeues`（requeue 一次、封顶 fail）；
 * - `errorMessage`：expert node_failed 事件的原文案，保持逐字节一致（零回归红线）。
 *
 * 状态机中立：不产出 pending/failed——workflow 状态机（pending/failed）与 swarm 状态机
 * （queued 换执行/failed）各自从 willRequeue 映射，原语不预设第二套语义。
 */
export interface ArtifactGateRejection {
  artifactRequeues: number;
  errorMessage: string;
  reasons: string[];
  willRequeue: boolean;
}

/**
 * deep 档 artifact-or-nothing 裁决（node-runner 既有决策的纯函数形态）。
 *
 * `enforce=false`（light 档、phase 容器节点等）恒返回 rejection=null——typed 段仍然提取
 * （可选数据，交了就挂），但不强制。调用方负责 enforce 的判定（expert：
 * `gate?.preset === "deep" && isArtifactGateWorkerNode(node)`；swarm：`plan.mode === "deep"`
 * 且派发的是 worker 节点——gate 节点不进子会话）。
 */
export function decideArtifactGateEnforcement(input: {
  enforce: boolean;
  extraction: ExtractTypedArtifactResult;
  maxArtifactRequeues: number;
  priorArtifactRequeues: number;
}): { rejection: ArtifactGateRejection | null; typed: WorkflowArtifactTyped | undefined } {
  const typed = input.extraction.kind === "valid" ? input.extraction.typed : undefined;
  if (!input.enforce) return { rejection: null, typed };

  const rejectionReasons =
    input.extraction.kind === "valid"
      ? validateDeepNodeArtifact(input.extraction.typed)
      : input.extraction.kind === "invalid"
        ? input.extraction.reasons
        : [`turn ended without a valid \`\`\`${TYPED_ARTIFACT_FENCE} typed artifact block`];
  if (rejectionReasons.length === 0) return { rejection: null, typed };

  const artifactRequeues = input.priorArtifactRequeues + 1;
  return {
    rejection: {
      artifactRequeues,
      errorMessage: `Typed artifact rejected: ${rejectionReasons.join("; ")}`,
      reasons: rejectionReasons,
      willRequeue: artifactRequeues <= input.maxArtifactRequeues,
    },
    typed,
  };
}

/**
 * 子会话执行 + 提取 + 裁决原语（spec 接口章 `executeNodeSubsession` 形态）。
 *
 * expert node-runner 与 swarm runner（2b 接线的 executeNode 闭包）的共同消费面：跑一次
 * 子会话，返回原始结果（sessionId/traceId/turnId/model 供调用方挂 activity/事件）+
 * typed 提取结果 + deep 封顶裁决。snapshot/eventLog 写入留在调用方——expert 的
 * workflow snapshot 簿记与 swarm 的 completeWorkerNode 落图是各自的状态所有者，原语
 * 不拥有第二个写入路径。
 *
 * 泛型 TNode：子会话 runner 绑定（bootstrap workflow-facade）不读 node 字段，swarm 的
 * SwarmPlanNode 可以同形通过；expert 传 WorkflowGraphNode（缺省类型参数，调用点零改动）。
 */
export async function executeNodeSubsession<
  TNode = WorkflowGraphSchedulerActivityInput["node"],
>(input: {
  enforcement: {
    enforce: boolean;
    maxArtifactRequeues: number;
    priorArtifactRequeues: number;
  };
  request: Omit<WorkflowGraphSchedulerActivityInput, "node"> & { node: TNode };
  runner: {
    run(
      request: Omit<WorkflowGraphSchedulerActivityInput, "node"> & { node: TNode },
    ): Promise<WorkflowGraphSchedulerActivityResult>;
  };
}): Promise<{
  rejection: ArtifactGateRejection | null;
  result: WorkflowGraphSchedulerActivityResult;
  typed: WorkflowArtifactTyped | undefined;
}> {
  const result = await input.runner.run(input.request);
  const extraction = extractTypedArtifact(result.response);
  const { rejection, typed } = decideArtifactGateEnforcement({
    enforce: input.enforcement.enforce,
    extraction,
    maxArtifactRequeues: input.enforcement.maxArtifactRequeues,
    priorArtifactRequeues: input.enforcement.priorArtifactRequeues,
  });
  return { rejection, result, typed };
}
