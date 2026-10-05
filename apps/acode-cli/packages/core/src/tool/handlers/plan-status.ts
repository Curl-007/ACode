// ============================================================
// PlanStatus Tool Handler（K2 对话内 Swarm 任务图，specs/swarm-task-graph.md R5）
// ============================================================
// 【注册待 2b 接线】本文件只导出 ToolEntry 工厂，不自注册（见 plan-shared.ts 头注释）。
//
// PlanStatus：plan 的只读图投影（节点状态 / ready / stalled / 上游 artifact 摘要）。
// 五工具中唯一同时注册给主对话与 workflow 子会话的工具（R5 注册门：worker 只见
// PlanStatus，图变更工具仅主对话——防 worker 自改图）；只读、并发安全、零副作用。
// 投影推导单一来源在 swarm/projection.ts（2b 的 runtime-task 快照共用，防两副面孔漂移）。

import { type JsonSchema } from "@acode/contracts";
import type { ToolEntry, ToolHandler } from "../types.js";
import type { SwarmPlanStore } from "../../swarm/plan-store.js";
import { buildSwarmPlanStatus } from "../../swarm/projection.js";
import {
  SWARM_PLAN_TOOL_MODEL_BYTES,
  SWARM_PLAN_TOOL_NAMES,
  readToolInputObject,
  swarmToolCancellation,
  swarmToolResultBudget,
  swarmToolTimeout,
  swarmToolTracePolicy,
} from "./plan-shared.js";

const PLAN_STATUS_DESCRIPTION = [
  "Read the current swarm plan projection: per-node status (queued/running/done/failed), ready nodes, stalled nodes (blocked by failures), upstream artifact summaries, gate queue, and terminal state.",
  "Nodes do not store 'blocked' — stalled is derived from dependency failures. Ready gates await a PlanCompleteGate verdict from the main conversation.",
].join("\n");

const PLAN_STATUS_INPUT_JSON_SCHEMA: JsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  additionalProperties: false,
  description: PLAN_STATUS_DESCRIPTION,
  properties: {},
  type: "object",
};

const NODE_VIEW_JSON_SCHEMA: JsonSchema = {
  additionalProperties: false,
  properties: {
    artifactRequeues: { type: "integer" },
    dependsOn: { items: { type: "string" }, type: "array" },
    expanded: { type: "boolean" },
    id: { type: "string" },
    isGate: { type: "boolean" },
    kind: { type: "string" },
    origin: { type: "string" },
    owner: { type: ["string", "null"] },
    priority: { type: "integer" },
    status: { enum: ["queued", "running", "done", "failed"], type: "string" },
    upstreamArtifacts: {
      items: {
        properties: {
          confidence: { enum: ["low", "medium", "high"], type: "string" },
          id: { type: "string" },
          summary: { type: "string" },
        },
        type: "object",
      },
      type: "array",
    },
  },
  required: ["id", "kind", "status", "origin", "priority", "isGate", "dependsOn"],
  type: "object",
};

const PLAN_STATUS_OUTPUT_JSON_SCHEMA: JsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  additionalProperties: false,
  properties: {
    plan: {
      additionalProperties: false,
      properties: {
        counts: {
          properties: {
            done: { type: "integer" },
            failed: { type: "integer" },
            gates: { type: "integer" },
            queued: { type: "integer" },
            running: { type: "integer" },
            stalled: { type: "integer" },
          },
          type: "object",
        },
        goal: { type: "string" },
        mode: { enum: ["light", "deep"], type: "string" },
        noArtifactRequeues: { type: "integer" },
        nodes: { items: NODE_VIEW_JSON_SCHEMA, type: "array" },
        readyGateIds: { items: { type: "string" }, type: "array" },
        readyWorkerIds: { items: { type: "string" }, type: "array" },
        stalledNodeIds: { items: { type: "string" }, type: "array" },
        terminalState: { enum: ["completed", "stalled", "active"], type: "string" },
        version: { type: "integer" },
      },
      required: ["version", "goal", "mode", "terminalState", "counts", "nodes"],
      type: "object",
    },
  },
  required: ["plan"],
  type: "object",
};

export function createPlanStatusToolEntry(deps: { store: SwarmPlanStore }): ToolEntry {
  const handler: ToolHandler = async (input, context) => {
    const toolName = SWARM_PLAN_TOOL_NAMES.status;
    readToolInputObject(input, toolName, context.toolCallId);
    const plan = deps.store.getPlan();
    // 无 plan 不是错误：空读是合法状态（尚未 seed / 已取消），返回 null 投影让模型
    // （尤其拿到只读面的 worker）知道没有可协调的图。
    return { plan: plan === null ? null : buildSwarmPlanStatus(plan) };
  };

  return {
    capability: "Read the current swarm plan projection without modifying state",
    handler,
    inputSchema: PLAN_STATUS_INPUT_JSON_SCHEMA,
    metadata: {
      name: SWARM_PLAN_TOOL_NAMES.status,
      description: PLAN_STATUS_DESCRIPTION,
      // 只读面（todo.read 同档）：并发安全、零副作用、免审批——worker 子会话可见性
      // （R5）也依赖这里不写任何状态。
      concurrentSafe: true,
      destructive: false,
      maxOutputBytes: SWARM_PLAN_TOOL_MODEL_BYTES,
      needsApproval: false,
      readOnly: true,
      riskLevel: "low",
      sideEffectScope: "none",
      timeoutMs: 30_000,
    },
    outputSchema: PLAN_STATUS_OUTPUT_JSON_SCHEMA,
    permission: {
      alwaysAllowPatternSources: ["toolName"],
      denyPriority: "beforeAsk",
      needsApproval: false,
      patternSources: ["toolName"],
      permission: "swarm.plan.read",
      reason: "PlanStatus only reads the session-local task plan projection",
      riskLevel: "low",
      sideEffectScope: "none",
    },
    resultBudget: swarmToolResultBudget(),
    timeout: swarmToolTimeout(),
    cancellation: swarmToolCancellation(
      "PlanStatus was cancelled before the plan projection was returned",
    ),
    trace: swarmToolTracePolicy(),
  };
}
