// ============================================================
// PlanSeed Tool Handler（K2 对话内 Swarm 任务图，specs/swarm-task-graph.md R5）
// ============================================================
// 【注册待 2b 接线】本文件只导出 ToolEntry 工厂，不自注册（见 plan-shared.ts 头注释）。
//
// PlanSeed：goal + 节点定义 + mode 建图/重播。幂等重放（同 goal+mode+defs 集合 no-op）
// 与 deep 强制 root gate 都在图引擎 seedPlan（R2）——工具面只做入参校验与错误投影，
// 不拥有第二份图语义。主对话工具（worker 子会话不见图变更工具，R5 注册门）。
//
// 工厂闭包 store（submit-result.ts 先例）：2b 接线时把 runtime 级 swarmPlanPort 装配的
// store 绑进工厂；同进程多 runtime 各持各的绑定，不经模块级共享状态。

import {
  CoreErrorType,
  WorkflowGatePresetSchema,
  createCoreError,
  type JsonSchema,
  type ToolPermissionSpec,
} from "@acode/contracts";
import type { ToolEntry, ToolHandler } from "../types.js";
import { seedPlan } from "../../swarm/graph/ops.js";
import type { SwarmPlanStore } from "../../swarm/plan-store.js";
import {
  SWARM_NODE_DEF_JSON_SCHEMA,
  SWARM_PLAN_TOOL_MODEL_BYTES,
  SWARM_PLAN_TOOL_NAMES,
  parseSwarmNodeDefs,
  readRequiredString,
  readToolInputObject,
  swarmToolCancellation,
  swarmToolResultBudget,
  swarmToolTimeout,
  swarmToolTracePolicy,
  throwSwarmGraphError,
} from "./plan-shared.js";
import { SWARM_GATE_CONTRACT_LANGUAGE, SWARM_PLAN_VS_TODO_LANGUAGE } from "../../swarm/prompts.js";

const PLAN_SEED_GOAL_MAX_CHARS = 5_000;

const PLAN_SEED_DESCRIPTION = [
  "Create or re-seed the engine-owned task plan (DAG) for this task. The engine dispatches ready worker nodes as sub-sessions between turns; artifacts flow along dependency edges.",
  "",
  SWARM_PLAN_VS_TODO_LANGUAGE,
  "",
  SWARM_GATE_CONTRACT_LANGUAGE,
].join("\n");

const PLAN_SEED_INPUT_JSON_SCHEMA: JsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  additionalProperties: false,
  description: PLAN_SEED_DESCRIPTION,
  properties: {
    goal: {
      description: "The task goal this plan coordinates (max 5000 chars).",
      maxLength: PLAN_SEED_GOAL_MAX_CHARS,
      minLength: 1,
      type: "string",
    },
    mode: {
      description:
        'Gate preset. "deep" (default): a root audit gate is enforced, worker nodes must end with a typed artifact block, and nothing auto-completes. "light": lenient — turns end done, gates optional.',
      enum: ["light", "deep"],
      type: "string",
    },
    nodes: {
      description:
        "Initial node definitions. ids must be unique and non-blank; dependsOn may reference each other. Re-seeding with the same definitions is a no-op; new ids are appended and (deep) the root gate re-opens.",
      items: SWARM_NODE_DEF_JSON_SCHEMA,
      minItems: 1,
      type: "array",
    },
  },
  required: ["goal", "nodes"],
  type: "object",
};

const PLAN_SEED_OUTPUT_JSON_SCHEMA: JsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  additionalProperties: false,
  properties: {
    mode: { enum: ["light", "deep"], type: "string" },
    noOp: { type: "boolean" },
    nodeCount: { type: "integer" },
    persistWarning: { type: "string" },
    rootGateId: { type: "string" },
    version: { type: "integer" },
  },
  required: ["mode", "noOp", "nodeCount", "version"],
  type: "object",
};

export function createPlanSeedToolEntry(deps: { store: SwarmPlanStore }): ToolEntry {
  const handler: ToolHandler = async (input, context) => {
    const toolName = SWARM_PLAN_TOOL_NAMES.seed;
    const body = readToolInputObject(input, toolName, context.toolCallId);
    const goal = readRequiredString(
      body,
      "goal",
      toolName,
      context.toolCallId,
      PLAN_SEED_GOAL_MAX_CHARS,
    );
    const defs = parseSwarmNodeDefs(body.nodes, "nodes", toolName, context.toolCallId);

    // mode 缺省 deep：不声明档位时取更严一侧——deep 的防线（root gate + typed artifact +
    // 废除 auto-complete）保护的是「模型自评完成」这条最容易被乐观偏差击穿的路径。
    let mode: "light" | "deep" = "deep";
    if (body.mode !== undefined) {
      const parsedMode = WorkflowGatePresetSchema.safeParse(body.mode);
      if (!parsedMode.success) {
        throw createCoreError(
          CoreErrorType.InvalidInput,
          `${toolName}: "mode" must be "light" or "deep".`,
          { context: { toolCallId: context.toolCallId, toolName }, recoverable: true },
        );
      }
      mode = parsedMode.data;
    }

    const outcome = await deps.store.mutate((current) => seedPlan(current, goal, defs, mode));
    if (!outcome.ok) throwSwarmGraphError(outcome.error, toolName, context.toolCallId);

    const rootGate = outcome.plan.nodes.find((node) => node.isGate && node.parent === null);
    return {
      mode: outcome.plan.mode,
      noOp: outcome.noOp,
      nodeCount: outcome.plan.nodes.length,
      // 存储写穿失败不回滚内存（plan-store 注释）：如实披露，模型可重试同 defs（幂等）。
      ...(outcome.writeError !== undefined
        ? {
            persistWarning: `plan updated in memory but persistence failed: ${outcome.writeError.message}`,
          }
        : {}),
      ...(rootGate !== undefined ? { rootGateId: rootGate.id } : {}),
      version: outcome.plan.version,
    };
  };

  return {
    capability: "Create or re-seed the engine-owned swarm task plan (DAG) for this task",
    handler,
    inputSchema: PLAN_SEED_INPUT_JSON_SCHEMA,
    metadata: {
      name: SWARM_PLAN_TOOL_NAMES.seed,
      description: PLAN_SEED_DESCRIPTION,
      // 状态写面（session 域协调状态），参照 todo.write 的低风险档：不触工作区/网络，
      // 图变更全部经引擎 ops 校验（clone-stage-commit），错误可修复。
      concurrentSafe: false,
      destructive: false,
      maxOutputBytes: SWARM_PLAN_TOOL_MODEL_BYTES,
      needsApproval: false,
      readOnly: false,
      riskLevel: "low",
      sideEffectScope: "session",
      timeoutMs: 30_000,
    },
    outputSchema: PLAN_SEED_OUTPUT_JSON_SCHEMA,
    permission: swarmPlanWritePermission(
      "swarm.plan.seed",
      "PlanSeed only shapes the session-local task plan graph via validated engine ops",
    ),
    resultBudget: swarmToolResultBudget(),
    timeout: swarmToolTimeout(),
    cancellation: swarmToolCancellation("PlanSeed was cancelled before the plan was seeded"),
    trace: swarmToolTracePolicy(),
  };
}

/** 图变更工具的统一权限档（R5：状态写面、低风险、不需审批——todo.write 同档先例）。 */
export function swarmPlanWritePermission(permission: string, reason: string): ToolPermissionSpec {
  return {
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
    needsApproval: false,
    patternSources: ["toolName"],
    permission,
    reason,
    riskLevel: "low",
    sideEffectScope: "session",
  };
}
