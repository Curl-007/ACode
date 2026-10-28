// Workflow artifact 与阶段快照契约 —— typed artifact 档位、产物、阶段快照、活动种类。
// 例外偿还（contracts-onboarding-max-file-lines-workflow-index）：自 workflow/index.ts 拆出。
// 原 index.ts 降为 barrel 并对本叶 `export *`，公开导出面逐名不变。
// 依赖单向：本叶 → workflow-core-schema.js（WorkflowPhaseId / WorkflowNodeStatus）；无叶子回边。
// ============================================================
// Workflow Protocol（typed artifact 与阶段快照段）
// ============================================================

import { z } from "zod";
import { WorkflowNodeStatusSchema, WorkflowPhaseIdSchema } from "./workflow-core-schema.js";

// J2-3（specs/workflow-typed-artifacts.md R1）：节点级类型化交接 artifact 的置信度档位。
// low 不是惩罚：它把节点路由成后续工作（critic gate 的置信度债务规则）。
export const WorkflowArtifactConfidenceSchema = z.enum(["low", "medium", "high"]);
export type WorkflowArtifactConfidence = z.infer<typeof WorkflowArtifactConfidenceSchema>;

// 对抗复核 F-4（specs/workflow-typed-artifacts.md R1）：typed 段长度上限。typed 段随 run
// snapshot 持久化，上限防病态模型输出把 snapshot 写爆。依据：单字符串 ≤100_000 字符（约 2.5
// 万 token，覆盖一切合理结论文本）；数组 ≤200 项；数组条目 ≤10_000 字符（file:line / 路径 /
// commit 引用实际远短于此）。超限 → 整块 invalid（deep 走 artifact-or-nothing，light 忽略）。
// 上限只可放宽不可收紧：snapshot 读取路径复用本 schema，收紧会让历史 snapshot 解析失败。
export const WORKFLOW_TYPED_ARTIFACT_TEXT_MAX_LENGTH = 100_000;
export const WORKFLOW_TYPED_ARTIFACT_LIST_MAX_LENGTH = 200;
export const WORKFLOW_TYPED_ARTIFACT_ITEM_MAX_LENGTH = 10_000;

// 机制参照 jcode (MIT) crates/jcode-plan/src/dag/mod.rs 的 HandoffArtifact，自撰实现。
// schema 层宽容（全字段可缺省、未知键剥离）；「deep 必填 findings/whatINotChecked/confidence」
// 是引擎校验规则（core/src/workflow/typed-artifact.ts），不进 schema——light 档允许部分 typed 段。
export const WorkflowArtifactTypedSchema = z.object({
  confidence: WorkflowArtifactConfidenceSchema.optional(),
  // 引用而非断言：约定 file:line / commit ref / path，格式不强校验（jcode 同为自由文本数组）。
  evidence: z
    .array(z.string().max(WORKFLOW_TYPED_ARTIFACT_ITEM_MAX_LENGTH))
    .max(WORKFLOW_TYPED_ARTIFACT_LIST_MAX_LENGTH)
    .default([]),
  findings: z.string().max(WORKFLOW_TYPED_ARTIFACT_TEXT_MAX_LENGTH).default(""),
  openQuestions: z
    .array(z.string().max(WORKFLOW_TYPED_ARTIFACT_ITEM_MAX_LENGTH))
    .max(WORKFLOW_TYPED_ARTIFACT_LIST_MAX_LENGTH)
    .default([]),
  validation: z.string().max(WORKFLOW_TYPED_ARTIFACT_TEXT_MAX_LENGTH).optional(),
  whatINotChecked: z
    .array(z.string().max(WORKFLOW_TYPED_ARTIFACT_ITEM_MAX_LENGTH))
    .max(WORKFLOW_TYPED_ARTIFACT_LIST_MAX_LENGTH)
    .default([]),
});
export type WorkflowArtifactTyped = z.infer<typeof WorkflowArtifactTypedSchema>;

export const WorkflowArtifactSchema = z.object({
  contentType: z.string(),
  createdAt: z.string(),
  label: z.string(),
  path: z.string(),
  phase: WorkflowPhaseIdSchema.optional(),
  // J2-3：可选 typed 段。既有路径式产物字段全部保留，历史 artifacts（无 typed）解析不变。
  typed: WorkflowArtifactTypedSchema.optional(),
});
export type WorkflowArtifact = z.infer<typeof WorkflowArtifactSchema>;

export const WorkflowPhaseSnapshotSchema = z.object({
  artifactPath: z.string().optional(),
  activityId: z.string().optional(),
  completedAt: z.string().optional(),
  error: z.string().optional(),
  phase: WorkflowPhaseIdSchema,
  sessionId: z.string().optional(),
  startedAt: z.string().optional(),
  status: WorkflowNodeStatusSchema,
  traceId: z.string().optional(),
  turnId: z.string().optional(),
});
export type WorkflowPhaseSnapshot = z.infer<typeof WorkflowPhaseSnapshotSchema>;

export const WorkflowActivityKindSchema = z.enum([
  "agent_session",
  "planner_agent",
  "subplanner_agent",
  "actor_agent",
  "critic_agent",
]);
export type WorkflowActivityKind = z.infer<typeof WorkflowActivityKindSchema>;
