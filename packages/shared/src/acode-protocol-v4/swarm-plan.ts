import { z } from "zod";

// 编排方案 Phase 2 / P2a（apps/acode-cli/specs/swarm-observability-projection.md R1/R3/R7）：
// swarm plan 的专用 v4 状态键族。刻意**不翻译进 dwf 词表**（方案 §7②）：swarm 的 gate
// 对抗审计与 gap 注入 re-critique 循环在 workflowRuns 无一等对应物，硬塞会失真。
//
// 与 dwf 的结构差异（spec R2）：swarm 的权威态是 plan 行本身、提交由 plan-store 单点
// 串行化、频率是「模型改图 + 节点状态迁移」量级——所以一条事件携带**有界状态视图全量**，
// 归约 = 代际 + 版本去重后的整体替换（丢帧自愈，冷回放只需一条合成事件），不做节点级
// delta（尺寸账见 spec「未做与取舍」#2；reducer/diff 分层已留升级位）。

/** wire 上限（spec R7 单点）：原始事实在 plan 行，投影键只背有界视图。 */
export const SWARM_PLAN_LIMITS = {
  maxGoalLength: 5_000,
  maxIdLength: 200,
  maxIdListEntries: 512,
  maxNodeContentPreviewLength: 160,
  maxNodeDepends: 100,
  maxNodes: 512,
  maxOwnerLength: 200,
} as const;

const swarmPlanNodeIdSchema = z.string().min(1).max(SWARM_PLAN_LIMITS.maxIdLength);

export const swarmPlanNodeViewSchema = z.object({
  id: swarmPlanNodeIdSchema,
  // 词表与 contracts SwarmPlanNodeKindSchema/StatusSchema/OriginSchema 同形——编译期闸
  // 在 bootstrap 的载荷 mapper（core 视图 → contracts payload 的 typed 赋值），运行期闸
  // 是 reducer 的 safeParse；shared 不反向依赖 contracts（依赖方向纪律）。
  kind: z.enum(["explore", "implement", "verify", "fix", "synthesize", "critique"]),
  status: z.enum(["queued", "running", "done", "failed"]),
  isGate: z.boolean(),
  origin: z.enum(["seed", "expand", "gap", "gate"]),
  owner: z.string().max(SWARM_PLAN_LIMITS.maxOwnerLength).nullable(),
  priority: z.number().int().min(0).max(9),
  dependsOn: z.array(swarmPlanNodeIdSchema).max(SWARM_PLAN_LIMITS.maxNodeDepends),
  expanded: z.boolean(),
  artifactRequeues: z.number().int().nonnegative(),
  /** 节点 content 只带 preview（≤160 字符）：全文走 PlanStatus 工具面，投影键不背 20k。 */
  contentPreview: z.string().max(SWARM_PLAN_LIMITS.maxNodeContentPreviewLength).optional(),
});
export type SwarmPlanNodeView = z.infer<typeof swarmPlanNodeViewSchema>;

export const swarmPlanStateSchema = z.object({
  /** 代际键：清除后重 seed = 新代际；版本去重只在同代际内做（spec R3）。 */
  createdAtMs: z.number().int().nonnegative(),
  goal: z.string().max(SWARM_PLAN_LIMITS.maxGoalLength),
  mode: z.enum(["light", "deep"]),
  version: z.number().int().nonnegative(),
  noArtifactRequeues: z.number().int().nonnegative(),
  terminalState: z.enum(["completed", "stalled", "active"]),
  counts: z.object({
    done: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    gates: z.number().int().nonnegative(),
    queued: z.number().int().nonnegative(),
    running: z.number().int().nonnegative(),
    stalled: z.number().int().nonnegative(),
  }),
  readyGateIds: z.array(swarmPlanNodeIdSchema).max(SWARM_PLAN_LIMITS.maxIdListEntries),
  readyWorkerIds: z.array(swarmPlanNodeIdSchema).max(SWARM_PLAN_LIMITS.maxIdListEntries),
  stalledNodeIds: z.array(swarmPlanNodeIdSchema).max(SWARM_PLAN_LIMITS.maxIdListEntries),
  nodes: z.array(swarmPlanNodeViewSchema).max(SWARM_PLAN_LIMITS.maxNodes),
  /** nodes 触到上限被截断后置位（原始事实仍在 plan 行；workflowRuns.truncated 同款语义）。 */
  truncated: z.boolean().optional(),
  updatedAtMs: z.number().int().nonnegative(),
});
export type SwarmPlanState = z.infer<typeof swarmPlanStateSchema>;

/**
 * 归约入参信封：字段刻意 unknown——事件载荷跨端口边界到达（contracts 的
 * SwarmPlanProgressPayload 经 product-projection 结构化赋值为本信封），形状校验在
 * reducer 内 safeParse 一次收口，坏载荷不产 delta 也不炸投影。
 */
export interface SwarmPlanProgressEnvelope {
  cleared?: unknown;
  counts?: unknown;
  createdAtMs?: unknown;
  goal?: unknown;
  mode?: unknown;
  noArtifactRequeues?: unknown;
  nodes?: unknown;
  readyGateIds?: unknown;
  readyWorkerIds?: unknown;
  stalledNodeIds?: unknown;
  terminalState?: unknown;
  truncated?: unknown;
  updatedAtMs?: unknown;
  version?: unknown;
}

/**
 * 归约（spec R3）：桌面投影、冷回放、P2b 的 TUI/GUI 共用这一份实现（两处各写一份
 * 就是两个时钟，workflow-runs-reducer 文件头同款纪律）。
 *
 * 返回值三态：
 * - `undefined` = 语义无变化（无效载荷 / 同代际 version ≤ prior 的乱序重复重放）——
 *   不产 delta、revision 不抬；
 * - `null` = plan 已清除（快照键置 null，面板消失）；
 * - 其余 = 整体替换后的新状态。
 */
export function reduceSwarmPlanState(
  prior: SwarmPlanState | null | undefined,
  envelope: SwarmPlanProgressEnvelope,
): SwarmPlanState | null | undefined {
  // 清除是代际终局：不校验其余字段（清除载荷本来就只有 cleared + 代际信息）。
  if (envelope.cleared === true) return null;
  const parsed = swarmPlanStateSchema.safeParse(envelope);
  if (!parsed.success) return undefined;
  const next = parsed.data;
  // 同代际版本去重：冷回放合成事件与内存事件重叠、迟到帧乱序到达都在这里被吸收。
  if (prior && prior.createdAtMs === next.createdAtMs && next.version <= prior.version) {
    return undefined;
  }
  return next;
}
