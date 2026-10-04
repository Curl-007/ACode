// 机制参照 jcode (MIT)：crates/jcode-plan/src/dag/ops.rs（验证式图变更 seed / expand_node /
// complete_node / inject_from_gate / requeue_failed 的 clone-stage-commit 语义、seed 幂等重放、
// deep 强制 root gate、re-seed 重开审计、expand 的 composite 翻转与 children 边保留、owner
// 清空、planner 记录）与 docs/SWARM_TASK_GRAPH.md（DAG-first、children 边保留 rationale、
// 「re-seed 的 plan 永不可能未被审计就保持 finished」、deep 废除 auto-complete rationale），
// 自撰 TypeScript 实现。产品规则见 specs/swarm-task-graph.md R2；gate 三连检与薄 artifact
// 校验复用本仓 J2-3 既有面（specs/workflow-typed-artifacts.md），不建第二套可信调度语义。
//
// 纯函数、零 IO：输入 plan 只读 → 克隆（structuredClone，plan 是 JSON-safe 快照）→ 在克隆上
// 变更 → validateSwarmGraph → 提交（version+1）或返回具名错误。唯一例外是幂等重放的 no-op
// 分支：直接返回原引用（无变更即无克隆，防工具重试双写）。

import {
  type SwarmGapProposal,
  type SwarmGateVerdict,
  type SwarmGraphError,
  type SwarmPlanNode,
  type SwarmPlanNodeDef,
  type SwarmPlanNodeKind,
  type SwarmPlanNodeStatus,
  type SwarmTaskPlan,
  type WorkflowArtifactTyped,
  type WorkflowGatePreset,
  type WorkflowNodeStatus,
} from "@acode/contracts";
import { evaluateCriticGate, type CriticAuditNode } from "../../workflow/artifact-gate.js";
import { validateDeepNodeArtifact } from "../../workflow/typed-artifact.js";
import { validateSwarmGraph } from "./validate.js";

// ---------------------------------------------------------------------------
// 结果类型
// ---------------------------------------------------------------------------

/** 图变更 op 的统一结果：ok 分支携带新 plan（+ op 特有的附加字段），错误分支携带具名错误。 */
export type SwarmGraphOpResult<Extra extends object = object> =
  | ({ ok: true; plan: SwarmTaskPlan } & Extra)
  | { ok: false; error: SwarmGraphError };

export type SeedPlanResult = SwarmGraphOpResult<{ noOp: boolean }>;
export type InjectGapResult = SwarmGraphOpResult<{ injectedGapIds: string[] }>;
export type CompleteGateResult = SwarmGraphOpResult<{ injectedGapIds: string[] }>;

// ---------------------------------------------------------------------------
// 内部约定
// ---------------------------------------------------------------------------

// 种子/子节点缺省值：与 contracts SwarmPlanNodeDefSchema 的 zod default 同值（两处注释互指；
// 引擎缺省不进 contracts 常量表——那张表是协议常量）。
const DEFAULT_NODE_KIND: SwarmPlanNodeKind = "implement";
const DEFAULT_NODE_PRIORITY = 4;
// gap 节点缺省 kind：gate 裁决产出的补缺口工作是修复性工作。
const GAP_NODE_KIND: SwarmPlanNodeKind = "fix";

// root gate 的确定性 id 与排序。priority 升序派发（数值小先派），root gate 是收尾审计，
// 排在工作节点之后不与它们抢位。
const ROOT_GATE_ID = "root-gate";
const ROOT_GATE_PRIORITY = 9;
const ROOT_GATE_CONTENT =
  "Deep-mode root audit gate: before passing, audit every done non-gate node by its exact id and explicitly address every low-confidence node.";

interface NormalizedNodeDef {
  content: string;
  dependsOn: string[];
  id: string;
  kind: SwarmPlanNodeKind;
  priority: number;
}

type NormalizeDefsResult =
  | { ok: true; defs: NormalizedNodeDef[] }
  | { ok: false; error: SwarmGraphError };

function fail(error: SwarmGraphError): { error: SwarmGraphError; ok: false } {
  return { ok: false, error };
}

function resolveNow(options: { nowMs?: number } | undefined): number {
  return options?.nowMs ?? Date.now();
}

function findNode(plan: SwarmTaskPlan, nodeId: string): SwarmPlanNode | undefined {
  return plan.nodes.find((node) => node.id === nodeId);
}

/** staging 中的节点查找：调用方刚在克隆上操作过，消失即内部不变量破裂（fail-loud）。 */
function mustFindNode(plan: SwarmTaskPlan, nodeId: string): SwarmPlanNode {
  const node = findNode(plan, nodeId);
  if (node === undefined) {
    throw new Error(`swarm graph invariant broken: node "${nodeId}" disappeared during staging`);
  }
  return node;
}

/** commit 阶段：结构校验通过后 version+1 提交；失败丢弃克隆（输入 plan 不被写穿）。 */
function commit(staged: SwarmTaskPlan): SwarmGraphOpResult {
  const error = validateSwarmGraph(staged.nodes);
  if (error !== null) return { ok: false, error };
  staged.version += 1;
  return { ok: true, plan: staged };
}

function newNode(init: {
  content: string;
  dependsOn: string[];
  id: string;
  isGate: boolean;
  kind: SwarmPlanNodeKind;
  origin: SwarmPlanNode["origin"];
  parent: string | null;
  priority: number;
}): SwarmPlanNode {
  return {
    ...init,
    artifactRequeues: 0,
    expanded: false,
    output: null,
    owner: null,
    planner: null,
    status: "queued",
  };
}

/** 追加依赖边（去重、保序：追加在既有依赖之后——expand 的「保留原 dependsOn」语义）。 */
function appendDependencies(node: SwarmPlanNode, ids: readonly string[]): void {
  const existing = new Set(node.dependsOn);
  for (const id of ids) {
    if (existing.has(id)) continue;
    node.dependsOn.push(id);
    existing.add(id);
  }
}

/** 在 taken 集合内找确定性唯一 id：base、base-2、base-3……（自动 gate/gap 生成用）。 */
function uniqueNodeId(taken: ReadonlySet<string>, base: string): string {
  if (!taken.has(base)) return base;
  let suffix = 2;
  while (taken.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

/** 工具入参的节点定义归一：trim id、补缺省、范围门槛。结构引用类校验留给 commit 阶段。 */
function normalizeDefs(defs: readonly SwarmPlanNodeDef[]): NormalizeDefsResult {
  const normalized: NormalizedNodeDef[] = [];
  for (const def of defs) {
    const id = def.id.trim();
    if (id.length === 0) {
      return fail({ kind: "blank-id", message: "node id must contain non-whitespace characters" });
    }
    if (def.content.trim().length === 0) {
      return fail({
        kind: "invalid-state",
        message: `node "${id}" content must be non-empty`,
        nodeId: id,
      });
    }
    const priority = def.priority ?? DEFAULT_NODE_PRIORITY;
    if (!Number.isInteger(priority) || priority < 0 || priority > 9) {
      return fail({
        kind: "invalid-state",
        message: `node "${id}" priority must be an integer between 0 and 9`,
        nodeId: id,
      });
    }
    normalized.push({
      content: def.content,
      dependsOn: def.dependsOn ?? [],
      id,
      kind: def.kind ?? DEFAULT_NODE_KIND,
      priority,
    });
  }
  return { ok: true, defs: normalized };
}

// ---------------------------------------------------------------------------
// seedPlan
// ---------------------------------------------------------------------------

/**
 * 幂等重放指纹：goal + mode + defs 集合的规范形（defs 按 id 排序、dependsOn 排序——集合
 * 语义，顺序差不构成新种子）。mode 计入指纹：档位切换不是重放（deep↔light 的 re-seed
 * 必须走合并路径接管/交回 root gate 管理）。防工具重试双写（jcode seed 同款）。
 */
function seedFingerprint(
  goal: string,
  defs: readonly NormalizedNodeDef[],
  mode: WorkflowGatePreset,
): string {
  const canonical = defs
    .map((def) => ({
      content: def.content,
      dependsOn: [...def.dependsOn].sort(),
      id: def.id,
      kind: def.kind,
      priority: def.priority,
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return JSON.stringify({ defs: canonical, goal, mode });
}

/**
 * deep 强制 root gate：kind=critique 的合成节点，依赖全部无 parent 的工作节点。
 * 否则扁平 seed 全部原子执行完会零 gate 收场，deep 静默退化为 light（jcode 同款 rationale）。
 * re-seed 时已 terminal（done/failed）的 root gate 重置 queued 并把新 root 纳入依赖——
 * 「re-seed 的 plan 永不可能未被审计就保持 finished」。
 *
 * root gate 的识别：isGate 且 parent===null（expand 自动插入的子 gate 都有 parent）。
 */
function ensureRootGate(plan: SwarmTaskPlan): void {
  const rootGate = plan.nodes.find((node) => node.isGate && node.parent === null);
  const rootNodeIds = plan.nodes
    .filter((node) => !node.isGate && node.parent === null)
    .map((node) => node.id);
  if (rootGate === undefined) {
    const taken = new Set(plan.nodes.map((node) => node.id));
    plan.nodes.push(
      newNode({
        content: ROOT_GATE_CONTENT,
        dependsOn: [...rootNodeIds],
        id: uniqueNodeId(taken, ROOT_GATE_ID),
        isGate: true,
        kind: "critique",
        origin: "gate",
        parent: null,
        priority: ROOT_GATE_PRIORITY,
      }),
    );
    return;
  }
  appendDependencies(rootGate, rootNodeIds);
  if (rootGate.status === "done" || rootGate.status === "failed") {
    // 新工作重开审计：terminal gate 复位。output 只属于 done 态，一并清空——stalled/active
    // 推导只看 status，但 PlanStatus 的 artifact 摘要不得读到过期裁决。
    rootGate.status = "queued";
    rootGate.owner = null;
    rootGate.output = null;
  }
}

/**
 * 种子/重播。plan 为 null 是首次建图；相同 goal+mode+defs 集合的重放 no-op（返回原引用）；
 * 不同 defs 的 re-seed 走合并——新 id 追加为 seed 根节点，已存在 id 的定义不重写已有节点
 * （重放不重写已完成工作，plan 是协调状态不是声明文本），deep 重开 root gate 审计。
 *
 * defs 的 dependsOn 可引用彼此，也可（re-seed 时）引用图中已有节点——统一由 commit 阶段的
 * 引用/环/上限校验裁决。
 */
export function seedPlan(
  plan: SwarmTaskPlan | null,
  goal: string,
  defs: readonly SwarmPlanNodeDef[],
  mode: WorkflowGatePreset,
  options?: { nowMs?: number },
): SeedPlanResult {
  const normalized = normalizeDefs(defs);
  if (!normalized.ok) return normalized;

  // 同一次 defs 内部的重复 id 是错误而不是「后者忽略」：合并循环里已知 id 会被跳过
  //（re-seed 对已有节点的重放语义），若不在此显式拒绝，内部重复会被静默去重——
  // 模型少写一个工作节点却拿到成功回执。
  const seenIds = new Set<string>();
  for (const def of normalized.defs) {
    if (seenIds.has(def.id)) {
      return fail({
        kind: "duplicate-id",
        message: `duplicate node id "${def.id}" in seed definitions`,
        nodeId: def.id,
      });
    }
    seenIds.add(def.id);
  }

  const fingerprint = seedFingerprint(goal, normalized.defs, mode);

  let staged: SwarmTaskPlan;
  if (plan === null) {
    staged = {
      createdAtMs: resolveNow(options),
      goal,
      mode,
      noArtifactRequeues: 0,
      nodes: [],
      seedFingerprint: fingerprint,
      updatedAtMs: resolveNow(options),
      version: 0,
    };
  } else if (plan.seedFingerprint === fingerprint) {
    // 幂等重放：同 goal+mode+相同 defs 集合 no-op，防工具重试双写。
    return { noOp: true, ok: true, plan };
  } else {
    staged = structuredClone(plan);
    // re-seed 更新目标与档位；goal/mode 变更与新 defs 一起构成新的种子指纹。
    staged.goal = goal;
    staged.mode = mode;
    staged.seedFingerprint = fingerprint;
  }

  const knownIds = new Set(staged.nodes.map((node) => node.id));
  for (const def of normalized.defs) {
    if (knownIds.has(def.id)) continue;
    staged.nodes.push(
      newNode({
        content: def.content,
        dependsOn: [...def.dependsOn],
        id: def.id,
        isGate: false,
        kind: def.kind,
        origin: "seed",
        parent: null,
        priority: def.priority,
      }),
    );
    knownIds.add(def.id);
  }

  if (mode === "deep") {
    ensureRootGate(staged);
  }

  staged.updatedAtMs = resolveNow(options);
  const result = commit(staged);
  return result.ok ? { ...result, noOp: false } : result;
}

// ---------------------------------------------------------------------------
// expandNode
// ---------------------------------------------------------------------------

/**
 * 分解：把一个节点翻成 composite join。
 *
 * 门槛：目标存在、非 gate（gate 不分解自己——补缺口走 gap 注入，把 gate 变 composite 会让
 * 审计依赖自己的裁决产物）、未 expanded、status ∈ {queued, running}、actor 是 owner 或节点
 * 无主（owner-or-unclaimed）。
 *
 * 语义：children 以 origin=expand 挂 parent 下；父节点 queued + expanded=true + 保留原
 * dependsOn + 追加 children 与（deep）自动子 gate 边 + planner 记录后 owner 清空（合成节点
 * 可被任意 worker 领取）；children→parent 直接数据边保留（jcode 同款：dataflow 水合只读
 * 直接依赖，去掉会让 synthesis 收不到子 artifact——即使 gate 已依赖全部 children）。
 * deep 在 children 与 parent 间自动插 gate。
 */
export function expandNode(
  plan: SwarmTaskPlan,
  nodeId: string,
  children: readonly SwarmPlanNodeDef[],
  actor: string,
  options?: { nowMs?: number },
): SwarmGraphOpResult {
  const node = findNode(plan, nodeId);
  if (node === undefined) {
    return fail({
      kind: "unknown-node",
      message: `expandNode: unknown node "${nodeId}"`,
      nodeId,
    });
  }
  if (node.isGate) {
    return fail({
      kind: "invalid-state",
      message: `gate node "${nodeId}" cannot be expanded; inject gap work instead`,
      nodeId,
    });
  }
  if (node.expanded) {
    return fail({
      kind: "invalid-state",
      message: `node "${nodeId}" is already expanded`,
      nodeId,
    });
  }
  if (node.status !== "queued" && node.status !== "running") {
    return fail({
      kind: "invalid-state",
      message: `node "${nodeId}" cannot be expanded from status "${node.status}"`,
      nodeId,
    });
  }
  if (node.owner !== null && node.owner !== actor) {
    return fail({
      kind: "not-owner",
      message: `node "${nodeId}" is owned by "${node.owner}"; only the owner or an unclaimed node can be expanded`,
      nodeId,
      owner: node.owner,
    });
  }
  if (children.length === 0) {
    return fail({
      kind: "invalid-state",
      message: "expandNode requires at least one child node",
      nodeId,
    });
  }

  const normalized = normalizeDefs(children);
  if (!normalized.ok) return normalized;

  const staged = structuredClone(plan);
  const parent = mustFindNode(staged, nodeId);
  const takenIds = new Set(staged.nodes.map((existing) => existing.id));
  const childIds: string[] = [];

  for (const def of normalized.defs) {
    staged.nodes.push(
      newNode({
        content: def.content,
        dependsOn: [...def.dependsOn],
        id: def.id,
        isGate: false,
        kind: def.kind,
        origin: "expand",
        parent: nodeId,
        priority: def.priority,
      }),
    );
    takenIds.add(def.id);
    childIds.push(def.id);
  }

  let gateId: string | undefined;
  if (staged.mode === "deep") {
    // deep 自动子 gate：composite 完成前必须过子层审计。gate 挂同一 parent 下（与 children
    // 同层），依赖全部 children；id 在「已有节点 + 新 children」内确定性唯一。
    gateId = uniqueNodeId(takenIds, `${nodeId}-gate`);
    staged.nodes.push(
      newNode({
        content: `Audit gate for children of "${nodeId}": verify each child artifact by its exact id before the parent synthesis completes.`,
        dependsOn: [...childIds],
        id: gateId,
        isGate: true,
        kind: "critique",
        origin: "gate",
        parent: nodeId,
        priority: parent.priority,
      }),
    );
    takenIds.add(gateId);
  }

  // 父节点翻 composite：重开为 queued（output 只属于 done 态），planner 记录后 owner 清空。
  parent.status = "queued";
  parent.expanded = true;
  parent.planner = actor;
  parent.owner = null;
  parent.output = null;
  appendDependencies(parent, childIds);
  if (gateId !== undefined) appendDependencies(parent, [gateId]);

  staged.updatedAtMs = resolveNow(options);
  return commit(staged);
}

// ---------------------------------------------------------------------------
// completeWorkerNode
// ---------------------------------------------------------------------------

/**
 * worker 节点完成（引擎侧调用——非模型工具面；R4 runner 在子会话返回后调这里落图）。
 *
 * deep 走薄 artifact 校验（复用 J2-3 validateDeepNodeArtifact）：findings 非空 +
 * whatINotChecked 非空 + confidence 可解析，否则 thin-artifact 错误交上层 requeue/fail；
 * light 任意产出接受（含 null——宽纵，回合结束即 done）。成功后 done + output 落图 +
 * owner 清空（owner 只由 runner 分配/清空）。
 */
export function completeWorkerNode(
  plan: SwarmTaskPlan,
  nodeId: string,
  typed: WorkflowArtifactTyped | null,
  options?: { actor?: string; nowMs?: number },
): SwarmGraphOpResult {
  const node = findNode(plan, nodeId);
  if (node === undefined) {
    return fail({
      kind: "unknown-node",
      message: `completeWorkerNode: unknown node "${nodeId}"`,
      nodeId,
    });
  }
  if (node.isGate) {
    return fail({
      kind: "invalid-state",
      message: `gate node "${nodeId}" completes via completeGateNode`,
      nodeId,
    });
  }
  if (node.status !== "running") {
    return fail({
      kind: "invalid-state",
      message: `worker node "${nodeId}" is not running (status "${node.status}")`,
      nodeId,
    });
  }
  if (
    options?.actor !== undefined &&
    node.owner !== null &&
    node.owner !== options.actor
  ) {
    return fail({
      kind: "not-owner",
      message: `node "${nodeId}" is owned by "${node.owner}"`,
      nodeId,
      owner: node.owner,
    });
  }

  if (plan.mode === "deep") {
    // deep 的 done 路径必须经过 typed artifact 契约：只有在不存在绕过它的 done 路径时，
    // 该契约才是真的（jcode deep 废除 auto-complete 的引擎侧对应物）。
    const reasons =
      typed === null
        ? ["deep-mode worker nodes require a typed artifact"]
        : validateDeepNodeArtifact(typed);
    if (reasons.length > 0) {
      return fail({
        kind: "thin-artifact",
        message: `node "${nodeId}" produced a thin artifact: ${reasons.join("; ")}`,
        nodeId,
        reasons,
      });
    }
  }

  const staged = structuredClone(plan);
  const stagedNode = mustFindNode(staged, nodeId);
  stagedNode.status = "done";
  stagedNode.output = typed;
  stagedNode.owner = null;
  staged.updatedAtMs = resolveNow(options);
  return commit(staged);
}

// ---------------------------------------------------------------------------
// completeGateNode
// ---------------------------------------------------------------------------

// swarm status → workflow status 映射：让 evaluateCriticGate 的 done 判定复用
// COMPLETED_NODE_STATUSES 语义（workflow/scheduler/graph.ts 是该集合的唯一所有者；swarm
// 枚举没有 cancelled/skipped，映射后仅 done 落在集合内）。两种状态机的语义桥，不改
// workflow 侧任何代码。
const SWARM_STATUS_TO_WORKFLOW: Record<SwarmPlanNodeStatus, WorkflowNodeStatus> = {
  done: "completed",
  failed: "failed",
  queued: "pending",
  running: "active",
};

/** gate 裁决落 typed output：findings=reasoning、openQuestions=acceptanceGaps。 */
function gateVerdictArtifact(verdict: {
  acceptanceGaps: string[];
  reasoning: string;
}): WorkflowArtifactTyped {
  return {
    confidence: undefined,
    evidence: [],
    findings: verdict.reasoning || "gate passed",
    openQuestions: [...verdict.acceptanceGaps],
    validation: undefined,
    whatINotChecked: [],
  };
}

/**
 * gate 节点完成（裁决由主对话模型经 PlanCompleteGate 提交，R5；gate 节点唯一执行通道——
 * 派给子会话等于让学生给自己批卷）。
 *
 * - pass：走 evaluateCriticGate（复用 J2-3），审计范围 = plan 内全部非 gate 节点。被拒的
 *   错误载荷带 issue 列表与 gapProposals，由引擎执行 injectGap（被拒 → 补缺口 → 复审的
 *   循环入口）；stale_gate_scope 映射为更具体的 gate-scope-stale（most-specific first，
 *   与 evaluateCriticGate 的 issue 顺序同口径）。通过 → done + 裁决落 output。
 * - fail：产 gap 注入（jcode inject_from_gate）——优先显式 gapProposals，缺省从
 *   acceptanceGaps 文本逐条合成；两者皆空的 fail 是死路（不路由任何后续工作），拒绝。
 */
export function completeGateNode(
  plan: SwarmTaskPlan,
  gateId: string,
  verdict: SwarmGateVerdict,
  options?: { nowMs?: number },
): CompleteGateResult {
  const gate = findNode(plan, gateId);
  if (gate === undefined) {
    return fail({
      kind: "unknown-node",
      message: `completeGateNode: unknown node "${gateId}"`,
      nodeId: gateId,
    });
  }
  if (!gate.isGate) {
    return fail({
      kind: "invalid-state",
      message: `node "${gateId}" is not a gate; worker nodes complete via the runner`,
      nodeId: gateId,
    });
  }
  if (gate.status !== "queued" && gate.status !== "running") {
    return fail({
      kind: "invalid-state",
      message: `gate node "${gateId}" cannot be completed from status "${gate.status}"`,
      nodeId: gateId,
    });
  }

  const reasoning = verdict.reasoning ?? "";
  const acceptanceGaps = verdict.acceptanceGaps ?? [];
  const gapProposals = verdict.gapProposals ?? [];

  if (verdict.pass) {
    // 审计范围 = plan 内全部非 gate 节点（gate 自身与其他 gate 不进范围）。done 判定经
    // status 映射复用 COMPLETED_NODE_STATUSES 语义；confidence 直取节点 output。
    const scope: CriticAuditNode[] = plan.nodes
      .filter((node) => !node.isGate)
      .map((node) => ({
        confidence: node.output?.confidence,
        id: node.id,
        status: SWARM_STATUS_TO_WORKFLOW[node.status],
      }));
    const issues = evaluateCriticGate({
      coverageTexts: [reasoning, ...acceptanceGaps],
      preset: plan.mode,
      scope,
    });
    if (issues.length > 0) {
      const stale = issues.some((issue) => issue.kind === "stale_gate_scope");
      return fail({
        gapProposals: [...gapProposals],
        issues,
        kind: stale ? "gate-scope-stale" : "gate-rejected",
        message: `gate "${gateId}" pass verdict rejected: ${issues
          .map((issue) => `${issue.kind}: ${issue.nodeIds.join(", ")}`)
          .join("; ")}`,
        nodeId: gateId,
      });
    }

    const staged = structuredClone(plan);
    const stagedGate = mustFindNode(staged, gateId);
    stagedGate.status = "done";
    stagedGate.owner = null;
    // gate 不是 worker，不过 validateDeepNodeArtifact（deep 的薄 artifact 契约只约束
    // worker 节点；gate 的裁决义务由三连检承担）。
    stagedGate.output = gateVerdictArtifact({ acceptanceGaps, reasoning });
    staged.updatedAtMs = resolveNow(options);
    const result = commit(staged);
    return result.ok ? { ...result, injectedGapIds: [] } : result;
  }

  const gaps: SwarmGapProposal[] =
    gapProposals.length > 0 ? gapProposals : acceptanceGaps.map((content) => ({ content }));
  if (gaps.length === 0) {
    return fail({
      kind: "invalid-state",
      message: `gate "${gateId}" fail verdict must propose gap work (gapProposals or acceptanceGaps)`,
      nodeId: gateId,
    });
  }

  const staged = structuredClone(plan);
  const stagedGate = mustFindNode(staged, gateId);
  const injected = injectGapInto(staged, stagedGate, gaps);
  if (!injected.ok) return injected;
  staged.updatedAtMs = resolveNow(options);
  const result = commit(staged);
  return result.ok ? { ...result, injectedGapIds: injected.gapIds } : result;
}

// ---------------------------------------------------------------------------
// injectGap（与 completeGateNode 的 fail 路径共用核心）
// ---------------------------------------------------------------------------

/**
 * gap 注入核心（改传入的 staged 克隆，调用方负责 clone 与 commit）：gap 节点挂 gate 的
 * parent 下作兄弟、origin=gap；gate 重置 queued 并依赖 gap（re-critique 循环）；parent 直接
 * 依赖 gap（dataflow 同理——水合只读直接依赖）。parent 已 done 时只补依赖边不重置 parent：
 * 重开已完成合成走 re-seed/expand，gap 注入不隐式重跑已完成工作。
 */
function injectGapInto(
  staged: SwarmTaskPlan,
  gate: SwarmPlanNode,
  gaps: readonly SwarmGapProposal[],
): { gapIds: string[]; ok: true } | { error: SwarmGraphError; ok: false } {
  const takenIds = new Set(staged.nodes.map((node) => node.id));
  const gapIds: string[] = [];
  const gapNodes: SwarmPlanNode[] = [];

  for (let index = 0; index < gaps.length; index += 1) {
    const gap = gaps[index]!;
    if (typeof gap.content !== "string" || gap.content.trim().length === 0) {
      return fail({
        kind: "invalid-state",
        message: `gap proposal ${index + 1} content must be non-empty`,
        nodeId: gate.id,
      });
    }
    if (
      gap.priority !== undefined &&
      (!Number.isInteger(gap.priority) || gap.priority < 0 || gap.priority > 9)
    ) {
      return fail({
        kind: "invalid-state",
        message: `gap proposal ${index + 1} priority must be an integer between 0 and 9`,
        nodeId: gate.id,
      });
    }
    let id: string;
    if (gap.id !== undefined) {
      id = gap.id.trim();
      if (id.length === 0) {
        return fail({
          kind: "blank-id",
          message: "gap node id must contain non-whitespace characters",
        });
      }
    } else {
      // 缺省 id 确定性生成：gap-{gateId}-{序号}，被占用则序号递增。
      let serial = index + 1;
      while (takenIds.has(`gap-${gate.id}-${serial}`)) serial += 1;
      id = `gap-${gate.id}-${serial}`;
    }
    if (takenIds.has(id)) {
      return fail({
        kind: "duplicate-id",
        message: `gap node id "${id}" already exists in the plan`,
        nodeId: id,
      });
    }
    takenIds.add(id);
    gapIds.push(id);
    gapNodes.push(
      newNode({
        content: gap.content,
        dependsOn: [],
        id,
        isGate: false,
        kind: gap.kind ?? GAP_NODE_KIND,
        origin: "gap",
        parent: gate.parent,
        priority: gap.priority ?? DEFAULT_NODE_PRIORITY,
      }),
    );
  }

  staged.nodes.push(...gapNodes);

  gate.status = "queued";
  gate.owner = null;
  gate.output = null;
  appendDependencies(gate, gapIds);

  if (gate.parent !== null) {
    const parent = staged.nodes.find((node) => node.id === gate.parent);
    if (parent !== undefined) appendDependencies(parent, gapIds);
  }

  return { gapIds, ok: true };
}

/**
 * gap 注入 op：被拒 pass 的错误载荷（issues + gapProposals）由引擎送到这里落图；也可由
 * fail 裁决路径经 completeGateNode 内部复用同一核心。gap 挂 gate 的 parent 下作兄弟、
 * gate 重置 queued 并依赖 gap、parent 直接依赖 gap。
 */
export function injectGap(
  plan: SwarmTaskPlan,
  gateId: string,
  gaps: readonly SwarmGapProposal[],
  options?: { nowMs?: number },
): InjectGapResult {
  const gate = findNode(plan, gateId);
  if (gate === undefined) {
    return fail({
      kind: "unknown-node",
      message: `injectGap: unknown node "${gateId}"`,
      nodeId: gateId,
    });
  }
  if (!gate.isGate) {
    return fail({
      kind: "invalid-state",
      message: `node "${gateId}" is not a gate; gaps attach to gates`,
      nodeId: gateId,
    });
  }
  if (gaps.length === 0) {
    return fail({
      kind: "invalid-state",
      message: "injectGap requires at least one gap proposal",
      nodeId: gateId,
    });
  }

  const staged = structuredClone(plan);
  const stagedGate = mustFindNode(staged, gateId);
  const injected = injectGapInto(staged, stagedGate, gaps);
  if (!injected.ok) return injected;
  staged.updatedAtMs = resolveNow(options);
  const result = commit(staged);
  return result.ok ? { ...result, injectedGapIds: injected.gapIds } : result;
}

// ---------------------------------------------------------------------------
// requeueNode
// ---------------------------------------------------------------------------

/**
 * 重排（失败恢复路径）：清 owner、status→queued。没有它 failed 的 deep gate 会永久卡死
 * composite（jcode requeue_failed rationale）。artifactRequeues 不清零——节点级总预算
 * （J2-3 同款，reopen 不重置）。done 节点拒绝：重开已完成工作的通道是 expand/injectGap，
 * 静默 requeue 会让「done 需 typed artifact 或 gate 审计」的可信级失去意义。
 */
export function requeueNode(
  plan: SwarmTaskPlan,
  nodeId: string,
  options?: { nowMs?: number },
): SwarmGraphOpResult {
  const node = findNode(plan, nodeId);
  if (node === undefined) {
    return fail({
      kind: "unknown-node",
      message: `requeueNode: unknown node "${nodeId}"`,
      nodeId,
    });
  }
  if (node.status === "done") {
    return fail({
      kind: "invalid-state",
      message: `done node "${nodeId}" cannot be requeued; route follow-up work via expand or gap injection`,
      nodeId,
    });
  }

  const staged = structuredClone(plan);
  const stagedNode = mustFindNode(staged, nodeId);
  stagedNode.status = "queued";
  stagedNode.owner = null;
  stagedNode.output = null;
  staged.updatedAtMs = resolveNow(options);
  return commit(staged);
}
