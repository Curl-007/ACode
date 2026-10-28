// Workflow 会话链接、失败、事件与 run snapshot 契约 —— 持久化聚合形态 + 存储端口。
// 例外偿还（contracts-onboarding-max-file-lines-workflow-index）：自 workflow/index.ts 拆出。
// 原 index.ts 降为 barrel 并对本叶 `export *`，公开导出面逐名不变。
// 依赖单向：本叶 → workflow-core-schema.js（枚举）/ workflow-artifact-schema.js
// （产物与阶段快照）/ workflow-graph-schema.js（图）；无叶子回边。scheduler 叶再依赖本叶。
// ============================================================
// Workflow Protocol（会话链接与 snapshot 段）
// ============================================================

import { z } from "zod";
import {
  WorkflowKindSchema,
  WorkflowNodeStatusSchema,
  WorkflowPhaseIdSchema,
  WorkflowRunStatusSchema,
  WorkflowStrategySchema,
} from "./workflow-core-schema.js";
import type {
  WorkflowDefinition,
  WorkflowKind,
  WorkflowRunStatus,
} from "./workflow-core-schema.js";
import {
  WorkflowActivityKindSchema,
  WorkflowArtifactSchema,
  WorkflowPhaseSnapshotSchema,
} from "./workflow-artifact-schema.js";
import { WorkflowGraphSchema } from "./workflow-graph-schema.js";
import type { WorkflowGraphRecord } from "./workflow-graph-schema.js";

export const WorkflowSessionLinkStatusSchema = z.enum([
  "starting",
  "running",
  "retrying_model",
  "waiting_permission",
  "completed",
  "failed",
  "cancelled",
]);
export type WorkflowSessionLinkStatus = z.infer<typeof WorkflowSessionLinkStatusSchema>;

export const WorkflowFailureKindSchema = z.enum([
  "network",
  "rate_limit",
  "timeout",
  "auth",
  "provider",
  "model_context",
  "configuration",
  "permission",
  "tool",
  "cancelled",
  "unknown",
]);
export type WorkflowFailureKind = z.infer<typeof WorkflowFailureKindSchema>;

export const WorkflowFailureSchema = z.object({
  activityId: z.string().optional(),
  code: z.string().optional(),
  kind: WorkflowFailureKindSchema,
  message: z.string(),
  nodeId: z.string().optional(),
  phase: WorkflowPhaseIdSchema.optional(),
  recoverable: z.boolean(),
  retryable: z.boolean(),
  sessionId: z.string().optional(),
  traceId: z.string().optional(),
  turnId: z.string().optional(),
});
export type WorkflowFailure = z.infer<typeof WorkflowFailureSchema>;

export const WorkflowRecoveryActionSchema = z.object({
  action: z.enum(["retry", "retry_with_current_model", "skip_node", "cancel"]),
  activityId: z.string().optional(),
  destructive: z.boolean().optional(),
  label: z.string(),
  nodeId: z.string().optional(),
  phase: WorkflowPhaseIdSchema.optional(),
});
export type WorkflowRecoveryAction = z.infer<typeof WorkflowRecoveryActionSchema>;

export const WorkflowSessionLinkSchema = z.object({
  activityId: z.string(),
  attempt: z.number().int().positive(),
  completedAt: z.string().optional(),
  kind: WorkflowActivityKindSchema,
  model: z.string().optional(),
  nodeId: z.string().optional(),
  parentSessionId: z.string().optional(),
  phase: WorkflowPhaseIdSchema,
  runId: z.string(),
  sessionId: z.string().optional(),
  startedAt: z.string(),
  status: WorkflowSessionLinkStatusSchema,
  traceId: z.string().optional(),
  turnId: z.string().optional(),
});
export type WorkflowSessionLink = z.infer<typeof WorkflowSessionLinkSchema>;

export const WorkflowActivitySnapshotSchema = z.object({
  activityId: z.string(),
  artifactPath: z.string().optional(),
  completedAt: z.string().optional(),
  error: z.string().optional(),
  inputArtifactPaths: z.array(z.string()).default([]),
  kind: WorkflowActivityKindSchema,
  model: z.string().optional(),
  nodeId: z.string().optional(),
  outputArtifactPaths: z.array(z.string()).default([]),
  parentSessionId: z.string().optional(),
  phase: WorkflowPhaseIdSchema,
  sessionId: z.string().optional(),
  startedAt: z.string(),
  status: WorkflowNodeStatusSchema,
  traceId: z.string().optional(),
  turnId: z.string().optional(),
});
export type WorkflowActivitySnapshot = z.infer<typeof WorkflowActivitySnapshotSchema>;

export const WorkflowEventTypeSchema = z.enum([
  "run_started",
  "run_completed",
  "run_failed",
  "workflow_paused",
  "workflow_retry_started",
  "workflow_session_linked",
  "run_cancelled",
  "phase_started",
  "phase_completed",
  "phase_failed",
  "artifact_written",
  "graph_updated",
  "node_started",
  "node_completed",
  "node_failed",
  "frontier_changed",
  "executor_paused",
  "executor_completed",
  "planner_started",
  "planner_completed",
  "planner_failed",
  "graph_expanded",
  "collection_exhausted",
  "critic_started",
  "critic_passed",
  "critic_failed",
  "node_reopened",
  "critic_iteration_limit_reached",
]);
export type WorkflowEventType = z.infer<typeof WorkflowEventTypeSchema>;

export const WorkflowEventSchema = z.object({
  kind: WorkflowKindSchema,
  message: z.string().optional(),
  nodeId: z.string().optional(),
  payload: z.record(z.unknown()).optional(),
  phase: WorkflowPhaseIdSchema.optional(),
  runId: z.string(),
  timestamp: z.string(),
  type: WorkflowEventTypeSchema,
});
export type WorkflowEvent = z.infer<typeof WorkflowEventSchema>;

export const WorkflowRunSnapshotSchema = z.object({
  activities: z.array(WorkflowActivitySnapshotSchema).default([]),
  artifacts: z.array(WorkflowArtifactSchema),
  completedAt: z.string().optional(),
  createdAt: z.string(),
  currentPhase: WorkflowPhaseIdSchema.optional(),
  cwd: z.string(),
  definitionId: z.string().min(1).optional(),
  definitionVersion: z.string().min(1).optional(),
  graph: WorkflowGraphSchema,
  kind: WorkflowKindSchema,
  phaseOrder: z.array(WorkflowPhaseIdSchema),
  phases: z.array(WorkflowPhaseSnapshotSchema),
  failure: WorkflowFailureSchema.optional(),
  pauseReason: z.string().optional(),
  reportPath: z.string().optional(),
  recoveryActions: z.array(WorkflowRecoveryActionSchema).default([]),
  runId: z.string(),
  schemaVersion: z.literal(1),
  sessionId: z.string().optional(),
  sessionLinks: z.array(WorkflowSessionLinkSchema).default([]),
  startedAt: z.string().optional(),
  status: WorkflowRunStatusSchema,
  strategy: WorkflowStrategySchema,
  task: z.string(),
  traceId: z.string().optional(),
  updatedAt: z.string(),
});
export type WorkflowRunSnapshot = z.infer<typeof WorkflowRunSnapshotSchema>;

export const ExpertWorkflowRunSnapshotSchema = WorkflowRunSnapshotSchema;
export type ExpertWorkflowRunSnapshot = WorkflowRunSnapshot;

export interface WorkflowRunListItem {
  completedAt?: string;
  createdAt: string;
  cwd: string;
  kind: WorkflowKind;
  runId: string;
  status: WorkflowRunStatus;
  task: string;
  updatedAt: string;
}

export interface WorkflowStorePort {
  appendEvent(event: WorkflowEvent, options?: { signal?: AbortSignal }): Promise<void>;
  appendGraphRecord(
    runId: string,
    record: WorkflowGraphRecord,
    options?: { signal?: AbortSignal },
  ): Promise<void>;
  listRuns(
    options?: { cwd?: string; kind?: WorkflowKind; limit?: number },
    signalOptions?: { signal?: AbortSignal },
  ): Promise<WorkflowRunListItem[]>;
  readEvents(runId: string, options?: { signal?: AbortSignal }): Promise<WorkflowEvent[]>;
  readLatestRun(
    options?: { cwd?: string; kind?: WorkflowKind },
    signalOptions?: { signal?: AbortSignal },
  ): Promise<WorkflowRunSnapshot | null>;
  readRun(runId: string, options?: { signal?: AbortSignal }): Promise<WorkflowRunSnapshot | null>;
  writeArtifact(
    runId: string,
    relativePath: string,
    content: string,
    options?: { signal?: AbortSignal },
  ): Promise<{ path: string; relativePath: string }>;
  writeReport(
    runId: string,
    content: string,
    options?: { signal?: AbortSignal },
  ): Promise<{ path: string; relativePath: string }>;
  writeSnapshot(snapshot: WorkflowRunSnapshot, options?: { signal?: AbortSignal }): Promise<void>;
}

export interface WorkflowDefinitionStorePort {
  listDefinitions(options?: { signal?: AbortSignal }): Promise<WorkflowDefinition[]>;
  readDefinition(
    definitionId: string,
    options?: { signal?: AbortSignal },
  ): Promise<WorkflowDefinition | null>;
}
