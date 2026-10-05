// ============================================================
// Plan 工具族共享基建（K2 对话内 Swarm 任务图，specs/swarm-task-graph.md R5）
// ============================================================
// 【注册待 2b 接线】本目录 plan-*.ts 只导出 ToolEntry 工厂，不自注册：2b 在
// runtime-tools.ts 的注册门（runtime 级 swarmPlanPort 在场，与 workflowPort 同款装配
// 模式）统一接入 handlers/index.ts——整合方统一接，本段（2a）不碰注册面。
//
// 为什么工厂闭包 store 而不是走 ToolExecutionContext 新端口字段：context 端口字段住在
// tool/types.ts + contracts（本段两者都不在写面），工厂形态（submit-result.ts 先例）让
// 工具行为现在就可测，2b 接线时把 store/runner 绑进工厂即可。
//
// inputSchema 说明：契约面本段冻结（第一段未含 SwarmPlanTool*Schema，contracts 不能改），
// core 也不直接依赖 zod（无法在 core 组合新 zod object）。因此 provider 可见 JsonSchema
// 手写于此，运行时校验复用 contracts 既有 zod schema（SwarmPlanNodeDefSchema /
// SwarmGateVerdictSchema——调用其 safeParse 不需要 import zod）+ 薄层手工包装校验；
// 2b 若把五工具入参 lift 进 contracts（spec 接口章的 SwarmPlanTool*Schema），两侧应合并
// 回 toToolJsonSchema 单源。

import {
  CoreErrorType,
  SwarmPlanNodeDefSchema,
  createCoreError,
  type JsonSchema,
  type SwarmGraphError,
  type SwarmPlanNodeDef,
  type SwarmTaskPlan,
} from "@acode/contracts";
import type { SwarmPlanStore } from "../../swarm/plan-store.js";

/** 与 todo 工具族同档的模型面上限（plan 投影是摘要，正常远小于此）。 */
export const SWARM_PLAN_TOOL_MODEL_BYTES = 100_000;

export const SWARM_PLAN_TOOL_NAMES = {
  completeGate: "PlanCompleteGate",
  control: "PlanControl",
  expand: "PlanExpand",
  seed: "PlanSeed",
  status: "PlanStatus",
} as const;

/**
 * SwarmGraphError → 用户可读工具错误（R5「工具错误即 SwarmGraphError 的用户可读投影，
 * 不裸抛枚举名」）。第一段契约把 message 设计为用户可读文案（含节点 id 与原因），这里
 * 原样作为错误消息；kind 只进诊断 context，不进消息。
 */
export function throwSwarmGraphError(
  error: SwarmGraphError,
  toolName: string,
  toolCallId: string,
): never {
  throw createCoreError(CoreErrorType.InvalidInput, error.message, {
    context: {
      swarmGraphErrorKind: error.kind,
      toolCallId,
      toolName,
    },
    recoverable: true,
  });
}

/** 图不在场（未 seed / 已取消）：给出下一步动作而不是裸状态报错。 */
export function requireSwarmPlan(
  store: SwarmPlanStore,
  toolName: string,
  toolCallId: string,
): SwarmTaskPlan {
  const plan = store.getPlan();
  if (plan !== null) return plan;
  throw createCoreError(
    CoreErrorType.InvalidInput,
    "No swarm plan exists in this task yet; call PlanSeed with a goal and node definitions first.",
    {
      context: { toolCallId, toolName },
      recoverable: true,
    },
  );
}

/** 顶层入参归一：非对象（含 JSON 字符串已在前置归一失败的场景）→ 可修复错误。 */
export function readToolInputObject(
  input: unknown,
  toolName: string,
  toolCallId: string,
): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw createCoreError(CoreErrorType.InvalidInput, `${toolName} input must be a JSON object.`, {
      context: { toolCallId, toolName },
      recoverable: true,
    });
  }
  return input as Record<string, unknown>;
}

/**
 * 节点定义数组校验：逐项过 contracts SwarmPlanNodeDefSchema（trim id、补缺省 kind/
 * dependsOn/priority、长度上限都在 schema 层）。失败取第一条 issue 的可读文案——模型
 * 只需要修一个节点定义，整包 ZodError 会把 20 个节点的错误排成噪声。
 */
export function parseSwarmNodeDefs(
  value: unknown,
  field: string,
  toolName: string,
  toolCallId: string,
): SwarmPlanNodeDef[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw createCoreError(
      CoreErrorType.InvalidInput,
      `${toolName}: "${field}" must be a non-empty array of node definitions.`,
      { context: { toolCallId, toolName }, recoverable: true },
    );
  }
  const defs: SwarmPlanNodeDef[] = [];
  for (let index = 0; index < value.length; index += 1) {
    // 空白 id 先于 zod min-length 报引擎口径文案（ops.ts normalizeDefs 同款话术）——
    // 「String must contain at least 1 character(s)」没有传达防 deep 死路的理由。
    const candidate = value[index] as { id?: unknown } | null;
    if (typeof candidate?.id === "string" && candidate.id.trim().length === 0) {
      throw createCoreError(
        CoreErrorType.InvalidInput,
        `${toolName}: ${field}[${index}] is invalid — node id must contain non-whitespace characters (gate audits address nodes by exact id; a blank id can never be audited).`,
        { context: { toolCallId, toolName }, recoverable: true },
      );
    }
    const parsed = SwarmPlanNodeDefSchema.safeParse(value[index]);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw createCoreError(
        CoreErrorType.InvalidInput,
        `${toolName}: ${field}[${index}] is invalid — ${issue?.path.join(".") || "$"}: ${issue?.message ?? "unrecognized shape"}.`,
        { context: { toolCallId, toolName }, recoverable: true },
      );
    }
    defs.push(parsed.data);
  }
  return defs;
}

/** 必填字符串字段读取（trim 非空）。 */
export function readRequiredString(
  source: Record<string, unknown>,
  field: string,
  toolName: string,
  toolCallId: string,
  maxLength: number,
): string {
  const raw = source[field];
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw createCoreError(
      CoreErrorType.InvalidInput,
      `${toolName}: "${field}" must be a non-empty string.`,
      { context: { toolCallId, toolName }, recoverable: true },
    );
  }
  if (raw.length > maxLength) {
    throw createCoreError(
      CoreErrorType.InvalidInput,
      `${toolName}: "${field}" exceeds ${maxLength} characters (got ${raw.length}).`,
      { context: { toolCallId, toolName }, recoverable: true },
    );
  }
  return raw;
}

// ---------------------------------------------------------------------------
// provider 可见 JsonSchema（手写单源；与运行时校验的一致性由测试钉住）
// ---------------------------------------------------------------------------

/** 节点定义的 provider 可见形状（与 SwarmPlanNodeDefSchema 同集：id/content/kind/
 * dependsOn/priority，缺省值在 schema description 里告知）。seed 与 expand 共用。 */
export const SWARM_NODE_DEF_JSON_SCHEMA: JsonSchema = {
  additionalProperties: false,
  description:
    "Node definition: stable short id (name it in gate audits), what to do (content), kind (explore|implement|verify|fix|synthesize|critique, default implement), dependsOn (ids of nodes whose artifacts you need, default []), priority 0-9 (lower dispatches first, default 4).",
  properties: {
    content: { maxLength: 20000, minLength: 1, type: "string" },
    dependsOn: { items: { maxLength: 200, type: "string" }, maxItems: 100, type: "array" },
    id: { maxLength: 200, minLength: 1, type: "string" },
    kind: {
      description: "Node kind; defaults to implement.",
      enum: ["explore", "implement", "verify", "fix", "synthesize", "critique"],
      type: "string",
    },
    priority: {
      description: "Lower dispatches first; defaults to 4.",
      maximum: 9,
      minimum: 0,
      type: "integer",
    },
  },
  required: ["id", "content"],
  type: "object",
};

export function swarmToolResultBudget() {
  return {
    maxInlineBytes: SWARM_PLAN_TOOL_MODEL_BYTES,
    maxModelBytes: SWARM_PLAN_TOOL_MODEL_BYTES,
    preview: {
      direction: "head" as const,
      maxBytes: SWARM_PLAN_TOOL_MODEL_BYTES,
    },
    strategy: "truncate" as const,
  };
}

export function swarmToolTimeout(defaultMs = 30_000) {
  return {
    allowCallOverride: false,
    defaultMs,
    maxMs: defaultMs,
  };
}

/** 图变更在 mutate 内原子完成（store 串行队列）；取消点只在等待前后，无外部副作用要清。 */
export function swarmToolCancellation(userVisibleMessage: string) {
  return {
    cleanup: "none" as const,
    supported: true as const,
    userVisibleMessage,
  };
}

export function swarmToolTracePolicy() {
  return {
    propagateToAdapters: false,
    recordInput: "summary" as const,
    recordOutput: "summary" as const,
    required: true as const,
  };
}
