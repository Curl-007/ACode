// ============================================================
// PlanControl Tool Handler（K2 对话内 Swarm 任务图，specs/swarm-task-graph.md R5）
// ============================================================
// 【注册待 2b 接线】本文件只导出 ToolEntry 工厂，不自注册（见 plan-shared.ts 头注释）。
//
// PlanControl：retry / cancel-node / cancel-plan 三个执行控制动作。
// - retry → 图引擎 requeueNode（R2 op：清 owner、queued；done 拒绝；artifactRequeues
//   不清零）——失败恢复路径，「没有它 failed deep gate 会永久卡死 composite」。
// - cancel-node / cancel-plan → swarm/control.ts 的终态转移（owner 清空；在飞执行的
//   迟到结果被 runner 的 stale run 防护丢弃；done 保留——取消不抹已完成事实）。
// 主对话工具（worker 子会话不见，R5 注册门）。

import { CoreErrorType, createCoreError, type JsonSchema } from "@acode/contracts";
import type { ToolEntry, ToolHandler } from "../types.js";
import { requeueNode } from "../../swarm/graph/ops.js";
import { cancelSwarmNode, cancelSwarmPlan } from "../../swarm/control.js";
import type { SwarmPlanStore } from "../../swarm/plan-store.js";
import {
  SWARM_PLAN_TOOL_MODEL_BYTES,
  SWARM_PLAN_TOOL_NAMES,
  readToolInputObject,
  requireSwarmPlan,
  swarmToolCancellation,
  swarmToolResultBudget,
  swarmToolTimeout,
  swarmToolTracePolicy,
  throwSwarmGraphError,
} from "./plan-shared.js";
import { swarmPlanWritePermission } from "./plan-seed.js";

const PLAN_CONTROL_ACTIONS = ["retry", "cancel-node", "cancel-plan"] as const;
type PlanControlAction = (typeof PLAN_CONTROL_ACTIONS)[number];

const PLAN_CONTROL_DESCRIPTION = [
  "Control actions for the swarm plan:",
  "- retry: requeue a failed (or stuck) node so the engine dispatches it again with a fresh worker (artifactRequeues budget is not reset).",
  "- cancel-node: mark a queued/running node failed; its in-flight execution result is discarded.",
  "- cancel-plan: mark every not-done node failed (done nodes keep their facts); re-plan afterwards with PlanSeed.",
].join("\n");

const PLAN_CONTROL_INPUT_JSON_SCHEMA: JsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  additionalProperties: false,
  description: PLAN_CONTROL_DESCRIPTION,
  properties: {
    action: {
      description: "Control action to perform.",
      enum: [...PLAN_CONTROL_ACTIONS],
      type: "string",
    },
    nodeId: {
      description: "Target node id — required for retry and cancel-node, ignored for cancel-plan.",
      maxLength: 200,
      minLength: 1,
      type: "string",
    },
  },
  required: ["action"],
  type: "object",
};

const PLAN_CONTROL_OUTPUT_JSON_SCHEMA: JsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  additionalProperties: false,
  properties: {
    action: { enum: [...PLAN_CONTROL_ACTIONS], type: "string" },
    cancelledNodeIds: { items: { type: "string" }, type: "array" },
    noOp: { type: "boolean" },
    nodeId: { type: "string" },
    persistWarning: { type: "string" },
    version: { type: "integer" },
  },
  required: ["action", "version"],
  type: "object",
};

function parseAction(
  body: Record<string, unknown>,
  toolName: string,
  toolCallId: string,
): PlanControlAction {
  if (
    typeof body.action !== "string" ||
    !PLAN_CONTROL_ACTIONS.includes(body.action as PlanControlAction)
  ) {
    throw createCoreError(
      CoreErrorType.InvalidInput,
      `${toolName}: "action" must be one of ${PLAN_CONTROL_ACTIONS.map((a) => `"${a}"`).join(", ")}.`,
      { context: { toolCallId, toolName }, recoverable: true },
    );
  }
  return body.action as PlanControlAction;
}

function requireNodeId(
  body: Record<string, unknown>,
  action: PlanControlAction,
  toolName: string,
  toolCallId: string,
): string {
  const nodeId = body.nodeId;
  if (typeof nodeId !== "string" || nodeId.trim().length === 0) {
    throw createCoreError(
      CoreErrorType.InvalidInput,
      `${toolName}: "nodeId" is required for action "${action}".`,
      { context: { toolCallId, toolName }, recoverable: true },
    );
  }
  return nodeId;
}

export function createPlanControlToolEntry(deps: { store: SwarmPlanStore }): ToolEntry {
  const handler: ToolHandler = async (input, context) => {
    const toolName = SWARM_PLAN_TOOL_NAMES.control;
    const body = readToolInputObject(input, toolName, context.toolCallId);
    const action = parseAction(body, toolName, context.toolCallId);
    requireSwarmPlan(deps.store, toolName, context.toolCallId);

    if (action === "cancel-plan") {
      const versionBefore = requireSwarmPlan(deps.store, toolName, context.toolCallId).version;
      const outcome = await deps.store.mutate((current) => cancelSwarmPlan(current, Date.now()));
      if (!outcome.ok) throwSwarmGraphError(outcome.error, toolName, context.toolCallId);
      return {
        action,
        cancelledNodeIds: outcome.plan.nodes
          .filter((node) => node.status === "failed")
          .map((node) => node.id),
        // 幂等 no-op（无可取消项）不递增 version（control.ts 返回原引用）。
        noOp: outcome.plan.version === versionBefore,
        ...(outcome.writeError !== undefined
          ? {
              persistWarning: `plan updated in memory but persistence failed: ${outcome.writeError.message}`,
            }
          : {}),
        version: outcome.plan.version,
      };
    }

    const nodeId = requireNodeId(body, action, toolName, context.toolCallId);
    const versionBefore = requireSwarmPlan(deps.store, toolName, context.toolCallId).version;
    const outcome = await deps.store.mutate((current) => {
      if (current === null) {
        return {
          error: {
            kind: "invalid-state" as const,
            message: "No swarm plan exists in this task yet; call PlanSeed first.",
          },
          ok: false as const,
        };
      }
      return action === "retry"
        ? requeueNode(current, nodeId)
        : cancelSwarmNode(current, nodeId, Date.now());
    });
    if (!outcome.ok) throwSwarmGraphError(outcome.error, toolName, context.toolCallId);

    return {
      action,
      noOp: outcome.plan.version === versionBefore,
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
    capability: "Retry or cancel swarm plan nodes (execution control)",
    handler,
    inputSchema: PLAN_CONTROL_INPUT_JSON_SCHEMA,
    metadata: {
      name: SWARM_PLAN_TOOL_NAMES.control,
      description: PLAN_CONTROL_DESCRIPTION,
      concurrentSafe: false,
      destructive: false,
      maxOutputBytes: SWARM_PLAN_TOOL_MODEL_BYTES,
      needsApproval: false,
      readOnly: false,
      riskLevel: "low",
      sideEffectScope: "session",
      timeoutMs: 30_000,
    },
    outputSchema: PLAN_CONTROL_OUTPUT_JSON_SCHEMA,
    permission: swarmPlanWritePermission(
      "swarm.plan.control",
      "PlanControl only retries or cancels session-local plan nodes via validated engine transitions",
    ),
    resultBudget: swarmToolResultBudget(),
    timeout: swarmToolTimeout(),
    cancellation: swarmToolCancellation(
      "PlanControl was cancelled before the control action was applied",
    ),
    trace: swarmToolTracePolicy(),
  };
}
