// ============================================================
// PlanExpand Tool Handler（K2 对话内 Swarm 任务图，specs/swarm-task-graph.md R5）
// ============================================================
// 【注册待 2b 接线】本文件只导出 ToolEntry 工厂，不自注册（见 plan-shared.ts 头注释）。
//
// PlanExpand：把一个节点分解成 children（父节点翻 composite join）。composite 化、
// children 数据边保留、deep 自动子 gate、owner 清空、planner 记录都在图引擎 expandNode
// （R2）。actor 用当次调用的 sessionId（主对话会话）——expand 的所有权门槛是
// owner-or-unclaimed：主对话 actor 永远不是 worker 执行实例 id，走 unclaimed 通道，
// planner 记录把分解者归到主会话（synthesis 再唤醒的亲和线索）。

import { type JsonSchema } from "@acode/contracts";
import type { ToolEntry, ToolHandler } from "../types.js";
import { expandNode } from "../../swarm/graph/ops.js";
import type { SwarmPlanStore } from "../../swarm/plan-store.js";
import {
  SWARM_NODE_DEF_JSON_SCHEMA,
  SWARM_PLAN_TOOL_MODEL_BYTES,
  SWARM_PLAN_TOOL_NAMES,
  parseSwarmNodeDefs,
  readRequiredString,
  readToolInputObject,
  requireSwarmPlan,
  swarmToolCancellation,
  swarmToolResultBudget,
  swarmToolTimeout,
  swarmToolTracePolicy,
  throwSwarmGraphError,
} from "./plan-shared.js";
import { swarmPlanWritePermission } from "./plan-seed.js";
import { SWARM_GATE_CONTRACT_LANGUAGE, SWARM_PLAN_VS_TODO_LANGUAGE } from "../../swarm/prompts.js";

const PLAN_EXPAND_DESCRIPTION = [
  "Decompose a plan node into children: the node becomes a composite join that waits for its children (and, in deep mode, an auto-inserted child audit gate) before a worker synthesizes it.",
  "",
  SWARM_PLAN_VS_TODO_LANGUAGE,
  "",
  SWARM_GATE_CONTRACT_LANGUAGE,
].join("\n");

const PLAN_EXPAND_INPUT_JSON_SCHEMA: JsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  additionalProperties: false,
  description: PLAN_EXPAND_DESCRIPTION,
  properties: {
    children: {
      description: "Child node definitions (same shape as PlanSeed nodes); must be non-empty.",
      items: SWARM_NODE_DEF_JSON_SCHEMA,
      minItems: 1,
      type: "array",
    },
    nodeId: {
      description: "Id of the queued/running, unexpanded worker node to decompose.",
      maxLength: 200,
      minLength: 1,
      type: "string",
    },
  },
  required: ["nodeId", "children"],
  type: "object",
};

const PLAN_EXPAND_OUTPUT_JSON_SCHEMA: JsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  additionalProperties: false,
  properties: {
    childGateId: {
      description: "Deep mode auto-inserts an audit gate over the children.",
      type: "string",
    },
    childIds: { items: { type: "string" }, type: "array" },
    nodeId: { type: "string" },
    persistWarning: { type: "string" },
    version: { type: "integer" },
  },
  required: ["nodeId", "childIds", "version"],
  type: "object",
};

export function createPlanExpandToolEntry(deps: { store: SwarmPlanStore }): ToolEntry {
  const handler: ToolHandler = async (input, context) => {
    const toolName = SWARM_PLAN_TOOL_NAMES.expand;
    const body = readToolInputObject(input, toolName, context.toolCallId);
    const nodeId = readRequiredString(body, "nodeId", toolName, context.toolCallId, 200);
    const children = parseSwarmNodeDefs(body.children, "children", toolName, context.toolCallId);
    requireSwarmPlan(deps.store, toolName, context.toolCallId);

    const outcome = await deps.store.mutate((current) =>
      // actor = 主对话 sessionId：expandNode 的 owner-or-unclaimed 门槛（R2）在主对话
      // 侧恒走 unclaimed（owner 只会是执行实例 id），planner 记录归主会话。
      current === null
        ? {
            error: {
              kind: "invalid-state" as const,
              message: "No swarm plan exists in this task yet; call PlanSeed first.",
            },
            ok: false as const,
          }
        : expandNode(current, nodeId, children, context.sessionId),
    );
    if (!outcome.ok) throwSwarmGraphError(outcome.error, toolName, context.toolCallId);

    const childGate = outcome.plan.nodes.find((node) => node.isGate && node.parent === nodeId);
    return {
      childIds: children.map((child) => child.id),
      ...(childGate !== undefined ? { childGateId: childGate.id } : {}),
      nodeId,
      ...(outcome.writeError !== undefined
        ? {
            persistWarning: `plan updated in memory but persistence failed: ${outcome.writeError.message}`,
          }
        : {}),
      version: outcome.plan.version,
    };
  };

  return {
    capability: "Decompose a swarm plan node into child nodes (composite join)",
    handler,
    inputSchema: PLAN_EXPAND_INPUT_JSON_SCHEMA,
    metadata: {
      name: SWARM_PLAN_TOOL_NAMES.expand,
      description: PLAN_EXPAND_DESCRIPTION,
      concurrentSafe: false,
      destructive: false,
      maxOutputBytes: SWARM_PLAN_TOOL_MODEL_BYTES,
      needsApproval: false,
      readOnly: false,
      riskLevel: "low",
      sideEffectScope: "session",
      timeoutMs: 30_000,
    },
    outputSchema: PLAN_EXPAND_OUTPUT_JSON_SCHEMA,
    permission: swarmPlanWritePermission(
      "swarm.plan.expand",
      "PlanExpand only reshapes the session-local task plan graph via validated engine ops",
    ),
    resultBudget: swarmToolResultBudget(),
    timeout: swarmToolTimeout(),
    cancellation: swarmToolCancellation("PlanExpand was cancelled before the node was expanded"),
    trace: swarmToolTracePolicy(),
  };
}
