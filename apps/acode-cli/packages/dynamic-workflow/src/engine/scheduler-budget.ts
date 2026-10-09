import { BUDGET_CAPS } from "../facade/budget-caps.js";
import type { ActorRef, Caps, InstanceRef, NodeRecord } from "./types.js";
import { WorkflowError } from "./types.js";
import type { Deferred, SchedulerHost } from "./scheduler-types.js";

/** 预算拒绝尚未准入；缺席 actorSeq，沿用既有 JSON error 字段而无需迁移。 */
export function isAskAdmissionRefusal(node: NodeRecord): boolean {
  return (
    node.kind === "ask" &&
    node.actorSeq === undefined &&
    node.status === "failed" &&
    node.error?.code === "AgentBudgetExceeded"
  );
}

/** 先存拒绝与首生结算顺序，后让脚本 catch；否则恢复会悄悄换掉控制流。 */
export function recordAskAdmissionRefusal(
  host: SchedulerHost,
  instance: InstanceRef,
  actor: ActorRef,
  hash: string,
  deferred: Deferred<unknown>,
  error: WorkflowError,
): void {
  host.driver.journal.putNode({
    runId: host.runId,
    ...instance,
    kind: "ask",
    inputHash: hash,
    actorSiteId: actor.siteId,
    actorOrdinal: actor.ordinal,
    status: "failed",
    error: error.toJSON(),
  });
  host.record({ type: "node-settled", instance, outcome: "failed", error: error.toJSON() });
  deferred.reject(error);
}

/**
 * 两道预算保险丝的**生效上界**（specs/workflow-budget-fuses.md R1/R6）。每次判定现读
 * caps（与 maxConcurrency 的派发闸同一条纪律：上界可以在 run 存活期间变）。
 * 显式 caps 成员只允许更严——生效值取它与 `BUDGET_CAPS` 常量的较小者，宽松方向的显式值
 * 被常量压回（「只能收紧」，与 managed-policy-floor 的地板哲学一致）；非有限值按缺席
 * （脏值必须死在判定之前，与 engine.ts 对 inheritedTokens 的归一同一条纪律）；
 * 下限钳到 1：0/负数会让任何 ask 都无法准入，只可能是配置错误而不是意图。
 */
function effectiveAskBudget(caps: Caps): { maxTotal: number; maxPending: number } {
  return {
    maxTotal: stricterCap(caps.maxAsksPerRun, BUDGET_CAPS.maxAsksPerRun),
    maxPending: stricterCap(caps.maxPendingAsks, BUDGET_CAPS.maxPendingAsks),
  };
}

function stricterCap(explicit: number | undefined, constant: number): number {
  if (explicit === undefined || !Number.isFinite(explicit)) return constant;
  return Math.max(1, Math.min(Math.floor(explicit), constant));
}

/**
 * `AgentBudgetExceeded` 的结构化拒绝（R2/R3 共用一个码，`details.limit` 区分是哪道闸——
 * 恢复动作相同：收窄扇出、少派发）。message 自撰、含三个数，读面不必解析文本就有上下文；
 * 流程判断一律走 code 与 details，绝不匹配这里的字符串。
 */
function agentBudgetExceeded(
  limit: "total" | "pending",
  cap: number,
  actual: number,
): WorkflowError {
  const message =
    limit === "total"
      ? `Subagent budget exhausted: this run has already admitted ${actual} ask nodes ` +
        `(cap ${cap}), so no more can be admitted. Nothing was silently dropped — this ask was ` +
        `rejected. Catch this error to wind down (report() the finished part survives), or ` +
        `dispatch fewer subagents.`
      : `Subagent fan-out backlog cap reached: ${actual} ask nodes are still unsettled ` +
        `(cap ${cap}). Nothing was silently dropped — this ask was rejected, not queued. ` +
        `Narrow the fan-out: await some in-flight asks (or split the Promise.all into waves) ` +
        `before admitting more.`;
  return new WorkflowError("AgentBudgetExceeded", message, { details: { limit, cap, actual } });
}

/**
 * fresh ask 准入的预算闸门序列（R2 → 导入缓存 → R3 → live），次序与记账规则集中一处：
 *
 * - **R2 总量闸在行创建之前**：这次准入即将新建一行 ask（导入命中与 live 都落真行），
 *   已准入行数到达上界即节点级拒绝——拒绝落库但不派发、不记账。
 *   pending 数受缓存速度影响，拒绝必须作为分支事实保存，不能在 replay 重新计算。
 * - **导入命中同样记账**：tryImportedSettle 命中会落一行真 dwf_node（importedAskRecord），
 *   计数跟上，「计数 = journal 已准入 ask 行数」才恒等（恢复法与维护法是同一个数）。
 * - **R3 积压闸只管 live 路**：导入命中不入 liveNodes；resume 的记录再派发不经本函数
 *   （那不是创建新节点，拒掉它会破坏 replay 保真——journal 行已承诺过派发）。
 * - **记账与行创建同一同步步骤**：被任一闸拒绝的 ask 都不计数，行与计数不漂移。
 */
export function runBudgetGatedAdmission(
  host: SchedulerHost,
  liveNodeCount: number,
  refuse: (error: WorkflowError) => void,
  tryImportedSettle: () => boolean,
  goLive: () => void,
): void {
  const { maxTotal, maxPending } = effectiveAskBudget(host.caps);
  const total = host.askTotalCount();
  if (total >= maxTotal) {
    refuse(agentBudgetExceeded("total", maxTotal, total));
    return;
  }
  if (tryImportedSettle()) {
    host.countAskAdmitted();
    return;
  }
  if (liveNodeCount >= maxPending) {
    refuse(agentBudgetExceeded("pending", maxPending, liveNodeCount));
    return;
  }
  host.countAskAdmitted();
  goLive();
}
