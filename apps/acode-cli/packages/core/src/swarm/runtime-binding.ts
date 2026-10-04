// K2 对话内 Swarm 任务图 2b 接线辅助（specs/swarm-task-graph.md R4/R6）：
// core 侧三件绑定面——持久化 seam 的 duck-typing、runtime-task 投影同步、cancel 的
// 在飞执行 abort 推导。纯函数/纯适配，零 IO（IO 全部经传入的 store/registry 端口）。
//
// 为什么 duck-typing 而不是扩 contracts SessionStorePort：plan-store.ts 头注释已登记
// （契约面冻结，K4 session-search.ts 先例——端口方法不随功能进 contracts）。adapters 的
// SqliteSessionStore 提供 readSwarmPlan/writeSwarmPlan/clearSwarmPlan（repositories/
// swarm-plans.ts，migration 0026），测试替身/未来远程 store 缺席时按「无持久化」降级
// （纯内存 runtime 状态面），不伪装成功。

import type { SessionId, SwarmTaskPlan } from "@acode/contracts";
import type { RuntimeTaskRegistry, RuntimeTaskSnapshot } from "../runtime-task/registry.js";
import type { SwarmPlanPersistence } from "./plan-store.js";
import { buildSwarmPlanStatus } from "./projection.js";

// ---------------------------------------------------------------------------
// 持久化 seam：sessionStore 的结构化 duck-typing（K4 先例形态）
// ---------------------------------------------------------------------------

/** SqliteSessionStore 的 swarm plan 能力面（repositories/swarm-plans.ts 三方法）。 */
interface SwarmPlanCapableSessionStore {
  readSwarmPlan?: (input: { sessionID: SessionId }) => Promise<unknown>;
  writeSwarmPlan?: (input: { sessionID: SessionId; plan: unknown }) => Promise<void>;
  clearSwarmPlan?: (input: { sessionID: SessionId }) => Promise<void>;
}

export function bindSwarmPlanPersistenceFromSessionStore(
  store: unknown,
  input: { sessionID: SessionId },
): SwarmPlanPersistence | undefined {
  if (typeof store !== "object" || store === null) return undefined;
  const candidate = store as SwarmPlanCapableSessionStore;
  // 三方法必须齐备：缺 write 的只读绑定会让「图是事实源、存储是投影」单向失真（内存
  // 提交永远写不穿），比没有持久化更糟——按能力缺席整体降级。
  if (
    typeof candidate.readSwarmPlan !== "function" ||
    typeof candidate.writeSwarmPlan !== "function" ||
    typeof candidate.clearSwarmPlan !== "function"
  ) {
    return undefined;
  }
  const { sessionID } = input;
  return {
    clearPlan: () => candidate.clearSwarmPlan!({ sessionID }),
    readPlan: () => candidate.readSwarmPlan!({ sessionID }),
    writePlan: (plan: SwarmTaskPlan) => candidate.writeSwarmPlan!({ sessionID, plan }),
  };
}

// ---------------------------------------------------------------------------
// runtime-task 投影（R4「对 runtime-task 的投影」）
// ---------------------------------------------------------------------------

/**
 * 把 plan 状态同步进 runtime-task registry（唯一可见面，R4；K3 overnight 的同款投影纪律）。
 *
 * 状态映射：plan 在场 = 条目在场；active→running、completed→completed、stalled→failed
 * （stalled 是「无 running/queued 可推进」的终局，failed 是 registry 语义里最接近的
 * 「需要干预」终态）。plan 清除（clear）→ remove（plan 的生命周期归任务，条目不比图活得久）。
 * 计数与图摘要进 description（UI 渲染面统一读它；专用快照字段留给后续 UI 批次——spec
 * 「未做与取舍」#4，避免预设计 UI 形态）。
 */
export function syncSwarmPlanRuntimeTask(input: {
  plan: SwarmTaskPlan | null;
  registry: RuntimeTaskRegistry;
  taskId: string;
}): void {
  const { plan, registry, taskId } = input;
  if (plan === null) {
    registry.remove(taskId);
    return;
  }
  const status = buildSwarmPlanStatus(plan);
  const description =
    `Swarm plan (${status.mode}, v${status.version}): ${status.goal} — ` +
    `${status.counts.done}/${plan.nodes.length} done, ${status.counts.running} running, ` +
    `${status.counts.queued} queued, ${status.counts.failed} failed, ${status.counts.stalled} stalled.`;
  const taskStatus: RuntimeTaskSnapshot["status"] =
    status.terminalState === "completed"
      ? "completed"
      : status.terminalState === "stalled"
        ? "failed"
        : "running";
  const next = {
    taskId,
    agentId: taskId,
    agentType: "swarm-plan",
    description,
    status: taskStatus,
    // RuntimeTaskType 的 swarm_plan 成员：plan 是会话内引擎态，不是工具派生任务——
    // 停止面走 PlanControl（模型工具），与 legacy Workflow（local_workflow，不可取消）
    // 和 dwf run（local_dynamic_workflow，端口取消）语义都不同（registry.ts 联合的
    // 取消语义分组，overnight 同款先例）。
    type: "swarm_plan" as const,
    taskType: "swarm_plan" as const,
    startedAt: new Date(plan.createdAtMs),
    ...(taskStatus === "running" ? {} : { completedAt: new Date(plan.updatedAtMs) }),
  };
  // update 要求条目已存在；不存在时 register（register 对既有 id 是覆盖写，重臂语义与
  // overnight 相同）。两条路径写同一份形状，投影不会因入口不同而分叉。
  const existing = registry.get(taskId);
  if (existing === undefined) {
    registry.register(next);
    return;
  }
  registry.update(taskId, (current) => ({ ...current, ...next }));
}

// ---------------------------------------------------------------------------
// cancel 的在飞执行 abort 推导（2a 登记的残留：PlanControl cancel 只落图，在飞子会话
// 还在跑——本推导从图变化读出「哪些在飞执行已不被图承认」，接线方据此 abort）
// ---------------------------------------------------------------------------

/**
 * 两次提交之间「从 running 掉出来的节点 id 集合」：cancel-node / cancel-plan（→failed）
 * 或 plan 清除（→null）。requeue 只作用于非 running 节点（invalid-state 门槛），不会
 * 产生伪阳性；runner 换 owner 的 requeue-no-artifact 路径会让节点短暂回 queued——那种
 * 「掉出 running」同样意味着旧执行实例的回合不再被承认（stale run 防护会丢弃其结果），
 * abort 它是正确行为，不是误伤。
 */
export function deriveSwarmAbortedNodeIds(
  previous: SwarmTaskPlan | null,
  plan: SwarmTaskPlan | null,
): string[] {
  if (previous === null) return [];
  const aborted: string[] = [];
  const nextStatus = new Map((plan?.nodes ?? []).map((node) => [node.id, node.status]));
  for (const node of previous.nodes) {
    if (node.status !== "running") continue;
    if (nextStatus.get(node.id) === "running") continue;
    aborted.push(node.id);
  }
  return aborted;
}
