// K2 对话内 Swarm 任务图 R4（specs/swarm-task-graph.md）：调度点驱动的图执行 runner。
//
// 机制参照 jcode (MIT) crates/jcode-plan/src/dag/sim.rs 的「模拟器先行」方法论落地形态：
// runner 的执行面是**注入接口**（executeNode 闭包）——本段（2a）以 fake executeNode 钉死
// 调度/失败/no-artifact 序列；2b 在 turn 后调度点（turn.ts，与 memory extraction 同款挂点）
// 用「workflow 子会话执行 + 共享执行原语（node-execution-core.ts）」闭包接线。
//
// 有意偏移（spec「与 jcode 的两处有意偏移」#1）：引擎调度替代模型手动 dispatch——ready
// 节点按确定性序（priority 升序 + id 字典序，schedule.ts 唯一所有者）批量派发，消除
// 「模型忘了 dispatch」卡死源。gate 节点**不进** executeNode（偏移 #2：审计是主对话模型
// 的自省职责，经 PlanCompleteGate 提交，派给子会话等于让学生给自己批卷）。
//
// deep 废除 auto-complete（jcode 关键防线）：worker 回合结束无有效 typed artifact →
// noArtifactRequeues+1（plan 级，单调不重置）+ artifactRequeues+1（节点级，J2-3 同款累计）
// → 封顶内 requeue 换执行实例（新 owner）→ 再犯 fail。light：回合结束即 done（宽纵）。
// 裁决复用共享原语 decideArtifactGateEnforcement（与 expert node-runner 同一份语义）。

import {
  SWARM_DEFAULT_NO_ARTIFACT_REQUEUE_CAP,
  SWARM_MAX_CONCURRENT_WORKERS,
  type Logger,
  type SwarmGraphError,
  type SwarmPlanNode,
  type SwarmTaskPlan,
} from "@acode/contracts";
import { assembleNodeInput } from "./graph/dataflow.js";
import { completeWorkerNode } from "./graph/ops.js";
import { readyNodes } from "./graph/schedule.js";
import { extractTypedArtifact } from "../workflow/typed-artifact.js";
import { decideArtifactGateEnforcement } from "../workflow/scheduler/node-execution-core.js";
import type { SwarmPlanMutation, SwarmPlanMutationOutcome, SwarmPlanStore } from "./plan-store.js";

/** 注入的子会话执行闭包（2b 接 workflow 子会话；本段 fake）。response 即子会话末轮文本。 */
export type SwarmExecuteNode = (request: {
  node: SwarmPlanNode;
  owner: string;
  prompt: string;
}) => Promise<{ response: string }>;

export type SwarmNodeSettlement =
  | { kind: "done"; nodeId: string }
  | { kind: "requeued-no-artifact"; nodeId: string; owner: string; reasons: string[] }
  | { kind: "failed-no-artifact"; nodeId: string; owner: string; reasons: string[] }
  | { kind: "failed-error"; nodeId: string; owner: string; message: string }
  | { kind: "dropped-stale"; nodeId: string; owner: string };

export interface SwarmRunner {
  /**
   * 调度点入口：按确定性序把 ready 的 worker 节点批量派发到活跃上限。已启动的执行在
   * 完成后自行级联派发（释放的槽位让给等位者），不阻塞调用方（turn 间隙挂点不能等
   * 整个 plan 跑完）。gate 节点不派发——它们等主对话的 PlanCompleteGate。
   */
  dispatchReadyNodes(): Promise<void>;
  /** 当前在飞的 worker 执行数（活跃上限的观测面）。 */
  activeWorkerCount(): number;
  /** 等到无在飞执行且无可派发工作（测试/DI 收口面；2b 可选消费）。 */
  settle(): Promise<void>;
}

export interface SwarmRunnerOptions {
  executeNode: SwarmExecuteNode;
  /** 活跃上限：1-16（spec R4「config 可调 1-16」），缺省 SWARM_MAX_CONCURRENT_WORKERS。 */
  maxConcurrentWorkers?: number;
  /** deep 无 artifact 的 requeue 封顶，缺省 SWARM_DEFAULT_NO_ARTIFACT_REQUEUE_CAP。 */
  noArtifactRequeueCap?: number;
  nowMs?: () => number;
  /** 执行实例 id 工厂：缺省单调序号（requeue 换执行 = 换 id；确定性可测）。 */
  ownerIdFactory?: () => string;
  /** 派发观测（测试钉派发序与 dataflow 装配产物）。 */
  onDispatch?: (event: { node: SwarmPlanNode; owner: string; prompt: string }) => void;
  /** 结算观测（测试钉 deep 全链路事件序列，对齐 J2-3 的事件序列钉法）。 */
  onNodeSettled?: (settlement: SwarmNodeSettlement) => void;
  /** 派发链自愈告警面（L1）；缺省静默（测试可注入替身）。 */
  logger?: Logger;
  store: SwarmPlanStore;
}

const MAX_TUNABLE_CONCURRENT_WORKERS = 16;

export function createSwarmRunner(options: SwarmRunnerOptions): SwarmRunner {
  const maxConcurrent = clamp(
    options.maxConcurrentWorkers ?? SWARM_MAX_CONCURRENT_WORKERS,
    1,
    MAX_TUNABLE_CONCURRENT_WORKERS,
  );
  const noArtifactRequeueCap =
    options.noArtifactRequeueCap ?? SWARM_DEFAULT_NO_ARTIFACT_REQUEUE_CAP;
  const now = options.nowMs ?? Date.now;
  const nextOwnerId = options.ownerIdFactory ?? (() => `swarm-exec-${++ownerSerial}`);
  let ownerSerial = 0;

  const inFlight = new Map<string, Promise<void>>();
  // 派发 pass 串行链：pass 内部「检查槽位 → claim → inFlight.set」之间有 await 让点，
  // 串行化保证同一时刻只有一个添加者，杜绝两个 pass 各自按旧计数认领导致超上限。
  let passChain: Promise<void> = Promise.resolve();

  const dispatchPass = (): Promise<void> => {
    // L1（批次B对抗复核）：pass 链补拒绝自愈——runPass 抛错时旧链永久 rejected，后续
    // dispatchPass 的 .then 会跳过 runPass 且继承拒绝，调度面从此静默瘫痪（级联派发与
    // settle 全部失效）。对齐 plan-store enqueue 的第二参数模式：吞错让链复位 resolved，
    // warn 留诊断面；错误无需重试——下一个调度点/级联派发就是自然重试点。
    passChain = passChain.then(runPass, (error: unknown) => {
      options.logger?.warn("Swarm runner dispatch pass failed; pass chain self-healed", {
        error: error instanceof Error ? error.message : String(error),
        event: "swarm.runner.pass_failed",
        module: "core.swarm",
      });
    });
    return passChain;
  };

  const runPass = async (): Promise<void> => {
    for (;;) {
      if (inFlight.size >= maxConcurrent) return;
      const plan = options.store.getPlan();
      if (plan === null) return;
      // gate 不派发（主对话经 PlanCompleteGate 执行）；在飞节点不入选（status 应已
      // running，双保险——claim 竞态由 claim mutation 的状态门槛兜住）。
      const next = readyNodes(plan).find((node) => !node.isGate && !inFlight.has(node.id));
      if (next === undefined) return;
      const owner = nextOwnerId();
      // 显式注解防联合推断漂移：staleError 分支会让 TS 把 TExtra 推成错误分支形状。
      const claimMutation: SwarmPlanMutation<{ owner: string }> = (current) =>
        claimWorkerNode(current, next.id, owner, now());
      const claim = await options.store.mutate(claimMutation);
      if (!claim.ok) continue; // 状态已被并发改变（cancel/requeue 抢先）——重读图再选
      const claimedPlan = claim.plan;
      const node = claimedPlan.nodes.find((candidate) => candidate.id === next.id);
      if (node === undefined) continue;
      // R3 dataflow 装配：content + Done 上游 artifact 渲染段 +（deep worker）typed 契约段。
      const prompt = assembleNodeInput(claimedPlan, node.id);
      options.onDispatch?.({ node, owner, prompt });
      inFlight.set(node.id, runExecution(node, owner, prompt));
    }
  };

  const runExecution = async (
    node: SwarmPlanNode,
    owner: string,
    prompt: string,
  ): Promise<void> => {
    try {
      const { response } = await options.executeNode({ node, owner, prompt });
      await settleExecution(node.id, owner, response);
    } catch (error) {
      // 子会话崩溃：节点 fail（失败不传播——依赖它的节点由 schedule.ts 推导 stalled）。
      const message = error instanceof Error ? error.message : String(error);
      const outcome = await options.store.mutate((current) =>
        terminateWorkerNode(current, node.id, owner, "failed", now()),
      );
      options.onNodeSettled?.(
        outcome.ok
          ? { kind: "failed-error", message, nodeId: node.id, owner }
          : { kind: "dropped-stale", nodeId: node.id, owner },
      );
    } finally {
      inFlight.delete(node.id);
      // 级联：释放的槽位让给等位者（第 5 个在有人完成时启动），无需等下一个调度点。
      await dispatchPass();
    }
  };

  const settleExecution = async (
    nodeId: string,
    owner: string,
    response: string,
  ): Promise<void> => {
    const plan = options.store.getPlan();
    if (plan === null) return; // plan 已清除（cancel-plan）：丢弃
    const node = plan.nodes.find((candidate) => candidate.id === nodeId);
    // stale run 防护（AGENTS「保留 owner/lease 与 stale run 防护」）：owner 已换/节点已
    // 被工具面改态的迟到结果不得落图。
    if (node === undefined || node.status !== "running" || node.owner !== owner) {
      options.onNodeSettled?.({ kind: "dropped-stale", nodeId, owner });
      return;
    }
    const { rejection, typed } = decideArtifactGateEnforcement({
      enforce: plan.mode === "deep",
      extraction: extractTypedArtifact(response),
      maxArtifactRequeues: noArtifactRequeueCap,
      priorArtifactRequeues: node.artifactRequeues,
    });
    if (rejection === null) {
      // deep 合法 artifact 或 light 任意产出（null 也接受——回合结束即 done）。
      const completeMutation: SwarmPlanMutation = (current) =>
        current === null
          ? staleError()
          : completeWorkerNode(current, nodeId, typed ?? null, { actor: owner, nowMs: now() });
      const completed = await options.store.mutate(completeMutation);
      if (completed.ok) {
        options.onNodeSettled?.({ kind: "done", nodeId });
        return;
      }
      // 防御纵深：原语裁决通过但 op 复检仍拒（理论不可达——同一份 validateDeepNodeArtifact）
      // → 按 no-artifact 处理；其余（invalid-state/not-owner）是 stale，丢弃。
      if (completed.error.kind !== "thin-artifact") {
        options.onNodeSettled?.({ kind: "dropped-stale", nodeId, owner });
        return;
      }
      await applyNoArtifactOutcome(nodeId, owner, {
        artifactRequeues: (node.artifactRequeues ?? 0) + 1,
        reasons: completed.error.reasons,
        willRequeue: (node.artifactRequeues ?? 0) + 1 <= noArtifactRequeueCap,
      });
      return;
    }
    await applyNoArtifactOutcome(nodeId, owner, rejection);
  };

  const applyNoArtifactOutcome = async (
    nodeId: string,
    owner: string,
    rejection: {
      artifactRequeues: number;
      reasons: string[];
      willRequeue: boolean;
    },
  ): Promise<void> => {
    const outcome = await options.store.mutate(
      (current: SwarmTaskPlan | null): SwarmPlanMutationOutcome => {
        if (current === null) return staleError();
        const staged = structuredClone(current);
        const node = staged.nodes.find((candidate) => candidate.id === nodeId);
        // M1（批次B对抗复核）：闭包内补 owner 校验——settle 面外层的快照检查与本次 mutate
        // 之间有排队窗口，cancel+retry 已把节点交给新 owner 时，仅查 status 会让迟到的
        // no-artifact 结算覆写新 owner 的 claim（claimWorkerNode/terminateWorkerNode 都有
        // owner 门槛，此处补齐同款 stale 防御）。
        if (node === undefined || node.status !== "running" || node.owner !== owner) {
          return staleError();
        }
        // 两个计数器：plan 级 noArtifactRequeues 单调递增不重置（R6 不变量）；节点级
        // artifactRequeues 是 J2-3 同款总预算（requeue 不清零，决定封顶）。
        staged.noArtifactRequeues += 1;
        node.artifactRequeues = rejection.artifactRequeues;
        node.owner = null;
        node.status = rejection.willRequeue ? "queued" : "failed";
        staged.updatedAtMs = now();
        staged.version += 1;
        return { ok: true, plan: staged };
      },
    );
    options.onNodeSettled?.(
      outcome.ok
        ? rejection.willRequeue
          ? { kind: "requeued-no-artifact", nodeId, owner, reasons: rejection.reasons }
          : { kind: "failed-no-artifact", nodeId, owner, reasons: rejection.reasons }
        : { kind: "dropped-stale", nodeId, owner },
    );
  };

  return {
    activeWorkerCount: () => inFlight.size,
    dispatchReadyNodes: () => dispatchPass(),
    settle: async () => {
      for (;;) {
        const pending = [...inFlight.values()];
        if (pending.length === 0) {
          await dispatchPass(); // 完成回调与 pass 之间的空档补扫
          if (inFlight.size === 0) return;
          continue;
        }
        await Promise.all(pending);
      }
    },
  };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * runner 侧执行状态转移（R6：owner 只由 runner 分配/清空；结构变更走 R2 ops，这里是
 * 执行簿记的写面）。claim：queued→running + owner。非 queued（被 cancel/requeue 抢先）
 * 拒绝——返回错误让派发循环重读图，防止双认领。
 */
function claimWorkerNode(
  plan: SwarmTaskPlan | null,
  nodeId: string,
  owner: string,
  nowMs: number,
): { ok: true; owner: string; plan: SwarmTaskPlan } | { ok: false; error: SwarmGraphError } {
  if (plan === null) return staleError();
  const staged = structuredClone(plan);
  const node = staged.nodes.find((candidate) => candidate.id === nodeId);
  if (node === undefined || node.status !== "queued" || node.isGate) return staleError();
  node.status = "running";
  node.owner = owner;
  staged.updatedAtMs = nowMs;
  staged.version += 1;
  return { ok: true, owner, plan: staged };
}

/** 终态转移：failed（owner 清空）。done 落图走 completeWorkerNode op（含校验与 version）。 */
function terminateWorkerNode(
  plan: SwarmTaskPlan | null,
  nodeId: string,
  owner: string,
  status: "failed",
  nowMs: number,
): { ok: true; plan: SwarmTaskPlan } | { ok: false; error: SwarmGraphError } {
  if (plan === null) return staleError();
  const staged = structuredClone(plan);
  const node = staged.nodes.find((candidate) => candidate.id === nodeId);
  if (node === undefined || node.status !== "running" || node.owner !== owner) return staleError();
  node.status = status;
  node.owner = null;
  staged.updatedAtMs = nowMs;
  staged.version += 1;
  return { ok: true, plan: staged };
}

function staleError(): { ok: false; error: { kind: "invalid-state"; message: string } } {
  return {
    error: {
      kind: "invalid-state",
      message: "swarm runner transition skipped: node is no longer claimable in its current state",
    },
    ok: false,
  };
}
