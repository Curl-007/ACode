// ============================================================
// PlanCompleteGate Tool Handler（K2 对话内 Swarm 任务图，specs/swarm-task-graph.md R5）
// ============================================================
// 【注册待 2b 接线】本文件只导出 ToolEntry 工厂，不自注册（见 plan-shared.ts 头注释）。
//
// gate 节点的唯一执行通道（spec 有意偏移 #2：审计是主对话模型的自省职责，派给子会话
// 等于让学生给自己批卷）。pass 走 evaluateCriticGate 三连检（复用 J2-3，引擎 completeGateNode
// 内部）；被拒的载荷（issues + gapProposals）由本 handler 紧接 injectGap 落图（R2「被拒 →
// 补缺口 → 复审」循环入口）——被拒不是工具错误而是对抗循环的正常路径，返回结构化结果
// （outcome 字段明示），模型据此复审或改提 fail 裁决。
//
// verdict 入参过 contracts SwarmGateVerdictSchema（第一段契约），本文件不另立形状。

import {
  CoreErrorType,
  SwarmGateVerdictSchema,
  WORKFLOW_TYPED_ARTIFACT_ITEM_MAX_LENGTH,
  WORKFLOW_TYPED_ARTIFACT_LIST_MAX_LENGTH,
  WORKFLOW_TYPED_ARTIFACT_TEXT_MAX_LENGTH,
  createCoreError,
  type JsonSchema,
  type SwarmGateVerdict,
} from "@acode/contracts";
import type { ToolEntry, ToolHandler } from "../types.js";
import { completeGateNode, injectGap } from "../../swarm/graph/ops.js";
import type { SwarmPlanStore } from "../../swarm/plan-store.js";
import {
  SWARM_PLAN_TOOL_MODEL_BYTES,
  SWARM_PLAN_TOOL_NAMES,
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

const PLAN_COMPLETE_GATE_DESCRIPTION = [
  "Submit the audit verdict for a plan gate node. This is the ONLY way a gate completes — gates are never dispatched to worker sub-sessions.",
  "A pass verdict is checked by the engine: it must name every done node by exact id and address every low-confidence node, otherwise it is rejected with the offending node list.",
  "A fail verdict (or a rejected pass with gapProposals) injects the gaps as new plan nodes and re-queues the gate for re-audit after they finish. Proposing gaps is a success path — a growing graph is the system working as intended.",
].join("\n");

const PLAN_COMPLETE_GATE_INPUT_JSON_SCHEMA: JsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  additionalProperties: false,
  description: PLAN_COMPLETE_GATE_DESCRIPTION,
  properties: {
    gateId: {
      description:
        "Id of the gate node to complete (e.g. the root gate inserted by deep PlanSeed).",
      maxLength: 200,
      minLength: 1,
      type: "string",
    },
    verdict: {
      additionalProperties: false,
      description:
        "Audit verdict: pass (boolean), reasoning (name each done node id and address low-confidence nodes), acceptanceGaps (strings), gapProposals (objects with content, optional id/kind/priority).",
      properties: {
        // M2（批次B对抗复核）：与 contracts SwarmGateVerdictSchema 同步的 J2-3 上限（常量
        // 复用导出不新造）——超限 verdict 必须在工具入参层拿可读错误，而不是落图后在
        // plan-store 的 safeParse 边界报伪装的不变量破裂。
        acceptanceGaps: {
          items: { maxLength: WORKFLOW_TYPED_ARTIFACT_ITEM_MAX_LENGTH, type: "string" },
          maxItems: WORKFLOW_TYPED_ARTIFACT_LIST_MAX_LENGTH,
          type: "array",
        },
        gapProposals: {
          items: {
            additionalProperties: false,
            properties: {
              content: { maxLength: 20000, minLength: 1, type: "string" },
              id: { maxLength: 200, minLength: 1, type: "string" },
              kind: {
                enum: ["explore", "implement", "verify", "fix", "synthesize", "critique"],
                type: "string",
              },
              priority: { maximum: 9, minimum: 0, type: "integer" },
            },
            required: ["content"],
            type: "object",
          },
          type: "array",
        },
        pass: { type: "boolean" },
        reasoning: { maxLength: WORKFLOW_TYPED_ARTIFACT_TEXT_MAX_LENGTH, type: "string" },
      },
      required: ["pass"],
      type: "object",
    },
  },
  required: ["gateId", "verdict"],
  type: "object",
};

const PLAN_COMPLETE_GATE_OUTPUT_JSON_SCHEMA: JsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  additionalProperties: false,
  properties: {
    gateId: { type: "string" },
    injectedGapIds: { items: { type: "string" }, type: "array" },
    issues: {
      description: "Present when a pass verdict was rejected: what the audit missed, by node id.",
      items: {
        properties: {
          kind: {
            enum: ["stale_gate_scope", "unaddressed_low_confidence", "uncovered_siblings"],
            type: "string",
          },
          nodeIds: { items: { type: "string" }, type: "array" },
        },
        type: "object",
      },
      type: "array",
    },
    outcome: {
      description:
        "passed | rejected (re-audit or submit a fail verdict) | rejected-gap-injected | failed-verdict-gaps-injected",
      enum: ["passed", "rejected", "rejected-gap-injected", "failed-verdict-gaps-injected"],
      type: "string",
    },
    persistWarning: { type: "string" },
    version: { type: "integer" },
  },
  required: ["gateId", "outcome", "version"],
  type: "object",
};

export function createPlanCompleteGateToolEntry(deps: { store: SwarmPlanStore }): ToolEntry {
  const handler: ToolHandler = async (input, context) => {
    const toolName = SWARM_PLAN_TOOL_NAMES.completeGate;
    const body = readToolInputObject(input, toolName, context.toolCallId);
    const gateId = readRequiredString(body, "gateId", toolName, context.toolCallId, 200);
    const plan = requireSwarmPlan(deps.store, toolName, context.toolCallId);

    // gate 必须是 ready/可裁决态才有审计意义——提前给可读错误（completeGateNode 也挡
    // 非 gate/终态，但「上游还没跑完就批卷」值得一条更早的引导文案）。
    const gate = plan.nodes.find((node) => node.id === gateId);
    if (gate === undefined) {
      throwSwarmGraphError(
        {
          kind: "unknown-node",
          message: `PlanCompleteGate: unknown gate "${gateId}".`,
          nodeId: gateId,
        },
        toolName,
        context.toolCallId,
      );
    }

    const parsedVerdict = SwarmGateVerdictSchema.safeParse(body.verdict);
    if (!parsedVerdict.success) {
      const issue = parsedVerdict.error.issues[0];
      throw createCoreError(
        CoreErrorType.InvalidInput,
        `${toolName}: "verdict" is invalid — ${issue?.path.join(".") || "$"}: ${issue?.message ?? "unrecognized shape"}.`,
        { context: { toolCallId: context.toolCallId, toolName }, recoverable: true },
      );
    }
    const verdict: SwarmGateVerdict = parsedVerdict.data;

    const outcome = await deps.store.mutate((current) =>
      current === null
        ? {
            error: {
              kind: "invalid-state" as const,
              message: "No swarm plan exists in this task yet; call PlanSeed first.",
            },
            ok: false as const,
          }
        : completeGateNode(current, gateId, verdict),
    );

    // 非 gate 类错误（unknown-node / invalid-state / not-owner）是调用面错误 → 投影抛出。
    // gate-rejected / gate-scope-stale 走下面对抗循环，不是工具失败。
    if (!outcome.ok) {
      if (outcome.error.kind !== "gate-rejected" && outcome.error.kind !== "gate-scope-stale") {
        throwSwarmGraphError(outcome.error, toolName, context.toolCallId);
      }
      const rejection = outcome.error;
      // R2：被拒 pass 的 gapProposals 由引擎落图（injectGap）——gate 重置 queued 依赖
      // gap、parent 依赖 gap；无 proposals 时把拒绝原样返回（模型改提 fail 裁决或复审）。
      if (rejection.gapProposals.length === 0) {
        const { version } = deps.store.getPlan() ?? plan;
        return {
          gateId,
          issues: rejection.issues,
          outcome: "rejected",
          version,
        };
      }
      const injected = await deps.store.mutate((current) =>
        current === null
          ? {
              error: {
                kind: "invalid-state" as const,
                message: "No swarm plan exists in this task yet; call PlanSeed first.",
              },
              ok: false as const,
            }
          : injectGap(current, gateId, rejection.gapProposals),
      );
      if (!injected.ok) throwSwarmGraphError(injected.error, toolName, context.toolCallId);
      return {
        gateId,
        injectedGapIds: injected.injectedGapIds,
        issues: rejection.issues,
        outcome: "rejected-gap-injected",
        ...(injected.writeError !== undefined
          ? {
              persistWarning: `plan updated in memory but persistence failed: ${injected.writeError.message}`,
            }
          : {}),
        version: injected.plan.version,
      };
    }

    return {
      gateId,
      // fail 裁决：completeGateNode 已注入 gap（gate 重置 queued 等复审）；pass：done。
      ...(outcome.injectedGapIds.length > 0 ? { injectedGapIds: outcome.injectedGapIds } : {}),
      ...(outcome.injectedGapIds.length > 0
        ? { outcome: "failed-verdict-gaps-injected" as const }
        : { outcome: "passed" as const }),
      ...(outcome.writeError !== undefined
        ? {
            persistWarning: `plan updated in memory but persistence failed: ${outcome.writeError.message}`,
          }
        : {}),
      version: outcome.plan.version,
    };
  };

  return {
    capability: "Submit the audit verdict for a swarm plan gate node (gates complete only here)",
    handler,
    inputSchema: PLAN_COMPLETE_GATE_INPUT_JSON_SCHEMA,
    metadata: {
      name: SWARM_PLAN_TOOL_NAMES.completeGate,
      description: PLAN_COMPLETE_GATE_DESCRIPTION,
      concurrentSafe: false,
      destructive: false,
      maxOutputBytes: SWARM_PLAN_TOOL_MODEL_BYTES,
      needsApproval: false,
      readOnly: false,
      riskLevel: "low",
      sideEffectScope: "session",
      timeoutMs: 30_000,
    },
    outputSchema: PLAN_COMPLETE_GATE_OUTPUT_JSON_SCHEMA,
    permission: swarmPlanWritePermission(
      "swarm.plan.completeGate",
      "PlanCompleteGate records the main conversation's audit verdict on session-local plan state",
    ),
    resultBudget: swarmToolResultBudget(),
    timeout: swarmToolTimeout(),
    cancellation: swarmToolCancellation(
      "PlanCompleteGate was cancelled before the verdict was recorded",
    ),
    trace: swarmToolTracePolicy(),
  };
}
