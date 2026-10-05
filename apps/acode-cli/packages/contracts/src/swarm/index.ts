// K2 对话内 Swarm 任务图（specs/swarm-task-graph.md R1）：contracts 契约层。
//
// 机制参照 jcode (MIT) crates/jcode-plan/src/dag/mod.rs 的 TaskGraph/TaskNode/HandoffArtifact
// 数据模型（status 故意不存 blocked、owner/parent/depends_on/expanded/is_gate/planner 字段族），
// 自撰 TypeScript 实现，未拷贝任何文件。typed artifact 与 gate preset 复用 J2-3 既有契约
// （../workflow/index.js），本文件不定义第二套可信调度语义。
//
// 消费方：core/src/swarm/graph/*（图引擎纯函数，第一段）、后续 swarm runner 与 plan-* 工具
// handlers（R4/R5 第二段）。常量表是协议唯一事实源——改这里即改协议。

import { z } from "zod";
import {
  WorkflowArtifactTypedSchema,
  WorkflowGatePresetSchema,
  WORKFLOW_TYPED_ARTIFACT_ITEM_MAX_LENGTH,
  WORKFLOW_TYPED_ARTIFACT_LIST_MAX_LENGTH,
  WORKFLOW_TYPED_ARTIFACT_TEXT_MAX_LENGTH,
} from "../workflow/index.js";

// ---------------------------------------------------------------------------
// 常量（specs/swarm-task-graph.md「常量」表）
// ---------------------------------------------------------------------------

/** plan 是协调状态不是日志（jcode 同值）：图内节点总数硬上限。 */
export const SWARM_MAX_PLAN_ITEMS = 1024;

/** 单节点依赖数上限（R1 schema 层强制，兼防 dependsOn 写爆 dataflow 装配）。 */
export const SWARM_MAX_NODE_DEPENDS = 100;

/** R3 dataflow：单个上游 artifact 渲染段的截断上限。 */
export const SWARM_ARTIFACT_RENDER_MAX_CHARS = 2_000;

/** R3 dataflow：全部上游 artifact 渲染段的总截断上限。 */
export const SWARM_ARTIFACT_RENDER_TOTAL_MAX_CHARS = 16_000;

/** R4：活跃 worker 并发上限缺省值（config `swarm.maxConcurrentWorkers` 可调 1-16）。 */
export const SWARM_MAX_CONCURRENT_WORKERS = 4;

/**
 * R4：deep 档废除 auto-complete 后，回合结束无有效 typed artifact 的 requeue 封顶缺省
 * （J2-3 workflow/artifact-gate.ts 的 DEFAULT_MAX_ARTIFACT_REQUEUES 同值：requeue 一次、
 * 第二次 fail）。
 */
export const SWARM_DEFAULT_NO_ARTIFACT_REQUEUE_CAP = 1;

// ---------------------------------------------------------------------------
// R1 数据模型
// ---------------------------------------------------------------------------

export const SwarmPlanNodeKindSchema = z.enum([
  "explore",
  "implement",
  "verify",
  "fix",
  "synthesize",
  "critique",
]);
export type SwarmPlanNodeKind = z.infer<typeof SwarmPlanNodeKindSchema>;

// 不存 blocked（jcode 同款声明）：blocked 由调度器从依赖状态推导（schedule.ts），单一事实源。
export const SwarmPlanNodeStatusSchema = z.enum(["queued", "running", "done", "failed"]);
export type SwarmPlanNodeStatus = z.infer<typeof SwarmPlanNodeStatusSchema>;

export const SwarmPlanNodeOriginSchema = z.enum(["seed", "expand", "gap", "gate"]);
export type SwarmPlanNodeOrigin = z.infer<typeof SwarmPlanNodeOriginSchema>;

export const SwarmPlanNodeSchema = z.object({
  id: z.string().min(1).max(200),
  content: z.string().min(1).max(20_000),
  kind: SwarmPlanNodeKindSchema,
  status: SwarmPlanNodeStatusSchema,
  // 执行实例 id；expand 后清空（合成节点可被任意 worker 领取，jcode 同款）。
  // owner 只由 runner 分配/清空，模型工具面不写 owner（R6 不变量）。
  owner: z.string().nullable(),
  // 分解来源：seed/gap 根节点为 null；expand 子节点与 deep 自动子 gate 指向 composite 父。
  parent: z.string().nullable(),
  // 既是依赖边也是数据流通道：R3 装配只读直接依赖的 output（children→parent 边因此必须保留）。
  dependsOn: z.array(z.string()).max(SWARM_MAX_NODE_DEPENDS),
  expanded: z.boolean(),
  isGate: z.boolean(),
  // 分解者记录（synthesis 再唤醒时的亲和复用，jcode 同款字段）。
  planner: z.string().nullable(),
  priority: z.number().int().min(0).max(9),
  // 复用 J2-3 typed artifact 契约（含 F-4 全部长度上限；「上限只可放宽不可收紧」继续有效）。
  output: WorkflowArtifactTypedSchema.nullable(),
  origin: SwarmPlanNodeOriginSchema,
  // J2-3 同款累计计数；requeue/reopen 不重置（节点级总预算）。
  artifactRequeues: z.number().int().nonnegative(),
});
export type SwarmPlanNode = z.infer<typeof SwarmPlanNodeSchema>;

export const SwarmTaskPlanSchema = z.object({
  // 编辑计数（jcode VersionedPlan 语义）：每次已提交的图变更 +1，no-op 不递增。
  version: z.number().int(),
  goal: z.string().max(5_000),
  // light/deep 复用 J2-3 preset 语义：deep = 强制 root gate + 严格 artifact 校验 +
  // 废除 auto-complete；light 宽纵。
  mode: WorkflowGatePresetSchema,
  nodes: z.array(SwarmPlanNodeSchema).max(SWARM_MAX_PLAN_ITEMS),
  // deep 废除 auto-complete 的 plan 级计数（单调递增不重置，R6 不变量）。
  noArtifactRequeues: z.number().int().nonnegative(),
  createdAtMs: z.number(),
  updatedAtMs: z.number(),
  // seedPlan 幂等重放的比对指纹（goal+mode+defs 集合的规范形，ops.ts 维护）。optional：
  // 外部构造或历史 plan 无指纹时只是不享受 no-op 判定，不影响其余字段解析。
  seedFingerprint: z.string().optional(),
});
export type SwarmTaskPlan = z.infer<typeof SwarmTaskPlanSchema>;

// ---------------------------------------------------------------------------
// 种子/扩张节点定义（PlanSeed/PlanExpand 工具入参的节点形状，R5 第二段直接复用）
// ---------------------------------------------------------------------------

export const SwarmPlanNodeDefSchema = z.object({
  // trim 归一（J2-3 R11 同款防 deep 死路）：空白 id 让 gate 的词边界 mentionsNodeId 恒
  // false → 任意 coverageTexts 都判 uncovered → critic 确定性死路。
  id: z.string().trim().min(1).max(200),
  content: z.string().min(1).max(20_000),
  kind: SwarmPlanNodeKindSchema.default("implement"),
  dependsOn: z.array(z.string()).max(SWARM_MAX_NODE_DEPENDS).default([]),
  // 缺省 4：与 core 图引擎 normalizeDefs 的缺省同值（引擎侧硬编码，两处注释互指；
  // 这是引擎缺省不是协议常量，故不进上面的常量表）。
  priority: z.number().int().min(0).max(9).default(4),
});
export type SwarmPlanNodeDef = z.input<typeof SwarmPlanNodeDefSchema>;

// ---------------------------------------------------------------------------
// gate 裁决与 gap 提案（completeGateNode / injectGap 入参，R5 第二段复用）
// ---------------------------------------------------------------------------

/**
 * gate 拒绝载荷里的 issue 形状。与 core workflow/artifact-gate.ts 的 CriticGateIssue
 * 结构一致——依赖方向限制（contracts 不能 import core），这里以同形类型承载，
 * core 侧的映射是恒等。
 */
export interface SwarmGateIssue {
  kind: "stale_gate_scope" | "unaddressed_low_confidence" | "uncovered_siblings";
  nodeIds: string[];
}

/**
 * gate 裁决提出的补缺口工作。id 缺省由引擎生成（`gap-{gateId}-{序号}`，防碰撞递增）；
 * 生成的 gap 节点挂在 gate 的 parent 下作兄弟（jcode inject_from_gate 同款）。
 */
export const SwarmGapProposalSchema = z.object({
  content: z.string().min(1).max(20_000),
  id: z.string().trim().min(1).max(200).optional(),
  kind: SwarmPlanNodeKindSchema.optional(),
  priority: z.number().int().min(0).max(9).optional(),
});
export type SwarmGapProposal = z.input<typeof SwarmGapProposalSchema>;

/**
 * gate 裁决（主对话经 PlanCompleteGate 提交，R5；pass 走三连检、fail 走 gap 注入）。
 *
 * M2（批次B对抗复核）：reasoning/acceptanceGaps 落图经 completeGateNode 的
 * gateVerdictArtifact 进 findings/openQuestions（J2-3 WorkflowArtifactTypedSchema 同源
 * 上限）——无上限的超限 verdict 会在 plan-store 的 SwarmTaskPlanSchema 边界报伪装的
 * 「不变量破裂」内部错误。入参层用同一组常量拒绝（复用导出不新造），错误可读且更早。
 */
export const SwarmGateVerdictSchema = z.object({
  pass: z.boolean(),
  reasoning: z.string().max(WORKFLOW_TYPED_ARTIFACT_TEXT_MAX_LENGTH).default(""),
  acceptanceGaps: z
    .array(z.string().max(WORKFLOW_TYPED_ARTIFACT_ITEM_MAX_LENGTH))
    .max(WORKFLOW_TYPED_ARTIFACT_LIST_MAX_LENGTH)
    .default([]),
  gapProposals: z.array(SwarmGapProposalSchema).default([]),
});
export type SwarmGateVerdict = z.input<typeof SwarmGateVerdictSchema>;

// ---------------------------------------------------------------------------
// SwarmGraphError（R2 闭合枚举判别联合）
// ---------------------------------------------------------------------------

/**
 * 图引擎具名错误：kind 是闭合枚举，每个变体带用户可读 message；额外字段供引擎与工具面
 * 路由（工具错误必须是它的用户可读投影，不裸抛枚举名——R5）。
 *
 * - unknown-node / duplicate-id / blank-id / cycle / limit-exceeded：clone-stage-commit 的
 *   commit 前置校验（validate.ts）产物；
 * - not-owner / invalid-state：op 门槛校验（所有权、状态机）；
 * - thin-artifact：deep worker 完成时薄 artifact（reasons 镜像 validateDeepNodeArtifact）；
 * - gate-scope-stale / gate-rejected：pass 裁决被 evaluateCriticGate 拒绝（stale 更具体，
 *   most-specific first）；两者都携带 issue 列表与 gapProposals 供引擎执行 injectGap。
 */
export type SwarmGraphError =
  | { kind: "unknown-node"; message: string; nodeId: string }
  | { kind: "duplicate-id"; message: string; nodeId: string }
  | { kind: "cycle"; message: string; cyclePath: string[] }
  | { kind: "limit-exceeded"; message: string; limit: number; actual: number }
  | { kind: "not-owner"; message: string; nodeId: string; owner: string | null }
  | { kind: "invalid-state"; message: string; nodeId?: string }
  | { kind: "thin-artifact"; message: string; nodeId: string; reasons: string[] }
  | {
      kind: "gate-rejected";
      message: string;
      nodeId: string;
      issues: SwarmGateIssue[];
      gapProposals: SwarmGapProposal[];
    }
  | {
      kind: "gate-scope-stale";
      message: string;
      nodeId: string;
      issues: SwarmGateIssue[];
      gapProposals: SwarmGapProposal[];
    }
  | { kind: "blank-id"; message: string };

export type SwarmGraphErrorKind = SwarmGraphError["kind"];
