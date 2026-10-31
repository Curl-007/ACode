// Workflow 图契约 —— 节点/边/集合、planner 输出、seed、critic 结果与图变更记录。
// 例外偿还（contracts-onboarding-max-file-lines-workflow-index）：自 workflow/index.ts 拆出。
// 原 index.ts 降为 barrel 并对本叶 `export *`，公开导出面逐名不变。
// 依赖单向：本叶 → workflow-core-schema.js（phase id / 节点状态枚举）；无叶子回边。
// ============================================================
// Workflow Protocol（图段）
// ============================================================

import { z } from "zod";
import {
  WorkflowGraphCollectionStatusSchema,
  WorkflowNodeStatusSchema,
  WorkflowPhaseIdSchema,
  WorkflowStrategySchema,
} from "./workflow-core-schema.js";

export const WorkflowGraphNodeSchema = z.object({
  collectionId: z.string().optional(),
  id: z.string(),
  attempts: z.number().int().nonnegative().optional(),
  // J2-3（specs/workflow-typed-artifacts.md R4）：deep 档 artifact-or-nothing 的 requeue 累计
  // 计数。与 attempts（执行错误重试）分账；reopen 不重置（节点级总预算）。
  artifactRequeues: z.number().int().nonnegative().optional(),
  dependsOn: z.array(z.string()).default([]),
  description: z.string().optional(),
  error: z.string().optional(),
  kind: z.enum(["phase", "task"]).default("phase"),
  phase: WorkflowPhaseIdSchema.optional(),
  prompt: z.string().optional(),
  reopenAttempts: z.number().int().nonnegative().optional(),
  status: WorkflowNodeStatusSchema,
  title: z.string(),
});
export type WorkflowGraphNode = z.infer<typeof WorkflowGraphNodeSchema>;

export const WorkflowGraphEdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
});
export type WorkflowGraphEdge = z.infer<typeof WorkflowGraphEdgeSchema>;

export const WorkflowGraphCollectionSchema = z.object({
  analyzedNodeIds: z.array(z.string()).optional(),
  collectionId: z.string(),
  errorCount: z.number().int().nonnegative().optional(),
  exhausted: z.boolean().optional(),
  explorable: z.boolean().optional(),
  frontierTarget: z.number().int().positive().optional(),
  goal: z.string().optional(),
  lastCompletionAt: z.string().optional(),
  lastGraphChangeAt: z.string().optional(),
  metric: z.string().optional(),
  nodeIds: z.array(z.string()).optional(),
  phase: WorkflowPhaseIdSchema.optional(),
  plannerRuns: z.number().int().nonnegative().optional(),
  status: WorkflowGraphCollectionStatusSchema.optional(),
  title: z.string().optional(),
});
export type WorkflowGraphCollection = z.infer<typeof WorkflowGraphCollectionSchema>;

export const WorkflowGraphSchema = z.object({
  collections: z.array(WorkflowGraphCollectionSchema).optional(),
  edges: z.array(WorkflowGraphEdgeSchema),
  nodes: z.array(WorkflowGraphNodeSchema),
});
export type WorkflowGraph = z.infer<typeof WorkflowGraphSchema>;

export const WorkflowGraphPlannerNodeSchema = z.object({
  collectionId: z.string().optional(),
  dependsOn: z.array(z.string()).default([]),
  description: z.string().optional(),
  // 对抗复核 F-1（specs/workflow-typed-artifacts.md R11）：planner 输出节点 id 必须 trim 后
  // 非空。此前 `z.string()` 让 `""`/`"  "` 直接进图，deep 档 critic gate 的 mentionsNodeId
  // 对空 id 恒 false → 任意 coverageTexts 都判 uncovered_siblings → critic 确定性死路。
  // `.trim()` 归一使 " abc " 与 "abc" 同一身份（与 seed 路径 stringValue 同口径）；本 schema
  // 只用于 planner LLM 输出解析（消费面核查见 spec R11），持久化节点走
  // WorkflowGraphNodeSchema（id 仍为 z.string()），历史数据不受影响。
  id: z.string().trim().min(1),
  kind: z.enum(["phase", "task"]).default("task"),
  phase: WorkflowPhaseIdSchema.optional(),
  prompt: z.string().optional(),
  title: z.string(),
});
export type WorkflowGraphPlannerNode = z.infer<typeof WorkflowGraphPlannerNodeSchema>;

export const WorkflowGraphPlannerResultSchema = z.object({
  collectionNodeIds: z.array(z.string()).optional(),
  edges: z.array(WorkflowGraphEdgeSchema).default([]),
  exhausted: z.boolean().optional(),
  nodes: z.array(WorkflowGraphPlannerNodeSchema).default([]),
  reasoning: z.string().optional(),
});
export type WorkflowGraphPlannerResult = z.infer<typeof WorkflowGraphPlannerResultSchema>;

export const WorkflowGraphSeedCollectionSchema = z.object({
  collectionId: z.string(),
  explorable: z.boolean().optional(),
  frontierTarget: z.number().int().positive().optional(),
  goal: z.string().optional(),
  metric: z.string().optional(),
  nodeIds: z.array(z.string()).default([]),
  phase: WorkflowPhaseIdSchema.optional(),
  title: z.string().optional(),
});
export type WorkflowGraphSeedCollection = z.infer<typeof WorkflowGraphSeedCollectionSchema>;

export const WorkflowGraphSeedSchema = z.object({
  collections: z.array(WorkflowGraphSeedCollectionSchema).default([]),
  edges: z.array(WorkflowGraphEdgeSchema).default([]),
  nodes: z.array(WorkflowGraphPlannerNodeSchema).default([]),
  reasoning: z.string().optional(),
});
export type WorkflowGraphSeed = z.infer<typeof WorkflowGraphSeedSchema>;

export const WorkflowNodePromptUpdateSchema = z
  .object({
    description: z.string().min(1).optional(),
    id: z.string().min(1),
    prompt: z.string().min(1).optional(),
    title: z.string().min(1).optional(),
  })
  .refine(
    (update) =>
      update.description !== undefined || update.prompt !== undefined || update.title !== undefined,
    {
      message: "Workflow node prompt update must include prompt, description, or title",
    },
  );
export type WorkflowNodePromptUpdate = z.infer<typeof WorkflowNodePromptUpdateSchema>;

export const WorkflowNodePromptUpdateSetSchema = z.object({
  nodes: z.array(WorkflowNodePromptUpdateSchema).default([]),
  reasoning: z.string().optional(),
});
export type WorkflowNodePromptUpdateSet = z.infer<typeof WorkflowNodePromptUpdateSetSchema>;

export const WorkflowCriticSeveritySchema = z.enum(["critical", "major", "minor"]);
export type WorkflowCriticSeverity = z.infer<typeof WorkflowCriticSeveritySchema>;

export const WorkflowCriticReopenProposalSchema = z.object({
  nodeId: z.string().min(1),
  reason: z.string().min(1),
  severity: WorkflowCriticSeveritySchema.optional(),
});
export type WorkflowCriticReopenProposal = z.infer<typeof WorkflowCriticReopenProposalSchema>;

export const WorkflowCriticResultSchema = z.object({
  acceptanceGaps: z.array(z.string()).default([]),
  reasoning: z.string().default(""),
  reopenProposals: z.array(WorkflowCriticReopenProposalSchema).default([]),
  verdict: z.enum(["pass", "fail"]),
});
export type WorkflowCriticResult = z.infer<typeof WorkflowCriticResultSchema>;

export const WorkflowGraphRecordSchema = z.discriminatedUnion("recordType", [
  z.object({
    recordType: z.literal("meta"),
    createdAt: z.string(),
    definitionId: z.string().min(1).optional(),
    definitionVersion: z.string().min(1).optional(),
    phaseOrder: z.array(WorkflowPhaseIdSchema),
    runId: z.string(),
    schemaVersion: z.literal(1),
    strategy: WorkflowStrategySchema,
  }),
  z.object({
    recordType: z.literal("node"),
    node: WorkflowGraphNodeSchema,
    runId: z.string(),
    timestamp: z.string(),
  }),
  z.object({
    recordType: z.literal("edge"),
    edge: WorkflowGraphEdgeSchema,
    runId: z.string(),
    timestamp: z.string(),
  }),
  z.object({
    recordType: z.literal("collection"),
    collection: WorkflowGraphCollectionSchema,
    runId: z.string(),
    timestamp: z.string(),
  }),
  z.object({
    collectionId: z.string().optional(),
    edgeIds: z.array(z.string()).optional(),
    recordType: z.literal("op"),
    nodeId: z.string().optional(),
    nodeIds: z.array(z.string()).optional(),
    phase: WorkflowPhaseIdSchema.optional(),
    payload: z.record(z.unknown()).optional(),
    runId: z.string(),
    status: WorkflowNodeStatusSchema.optional(),
    timestamp: z.string(),
    type: z.string(),
  }),
]);
export type WorkflowGraphRecord = z.infer<typeof WorkflowGraphRecordSchema>;
