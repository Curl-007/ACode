/**
 * scheduler.ts 顶到 oxlint max-lines 上限（400 行），把调度器的内部类型（Deferred /
 * AskNode / Actor）与引擎注入的依赖面 SchedulerHost 拆到本文件；公开面仍从 scheduler.ts 导出
 * （SchedulerHost 在那里原地再导出，engine.ts 的导入路径不变）。
 *
 * 单独成文件的理由不只是行数：scheduler-submit.ts 里的自由函数也要拿到 AskNode / SchedulerHost，
 * 从这里导入，两侧都不必反向 import 调度器本体。
 */

import { BUDGET_CAPS } from "../facade/budget-caps.js";
import { INSTRUCTIONS_HEAD_MAX_CHARS, refToString, WorkflowError } from "./types.js";
import type { ImportedActorState } from "./imported-cache.js";
import type {
  ActorId,
  ActorRef,
  AskSpec,
  AskStats,
  Caps,
  InstanceRef,
  PersonaSpec,
  RunEvent,
  SessionRef,
  ValidateFn,
  WorkflowDriver,
} from "./types.js";

/** 一个可外部结算的 promise。 */
export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

export function defer<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 引擎注入给调度器的依赖面。 */
export interface SchedulerHost {
  readonly runId: string;
  /**
   * 本 run 的并发上界。**每次派发前现读**，不是构造时抄下的一份：`setMaxConcurrency` 会整份
   * 换掉引擎持有的 caps，
   * 而调度器的派发判据必须看见新值。引擎侧因此以 getter 实现这个属性。
   */
  readonly caps: Caps;
  readonly driver: WorkflowDriver;
  readonly validate: ValidateFn;
  /** 分配某站点的下一个执行序号（与 world-read/actor 共用一套计数器）。 */
  nextOrdinal(siteId: string): number;
  /**
   * 受 replay 结算次序约束地释放一次命中。
   * 非 resume、或次序表里没有这个实例时立即执行 `release`。
   */
  holdForReplay(instance: InstanceRef, release: () => void): void;
  /** 事件既落 journal 又扇出（Boundary C）。 */
  record(event: RunEvent): void;
  isRunSettled(): boolean;
  /** run 已结算时用于 reject 的错误。 */
  runError(): WorkflowError;
  /** run 级失败。 */
  failRun(error: WorkflowError): void;
  /**
   * 导入缓存是否已关闭（amend-resume）。关门由引擎自己做
   * （driver 上报 askMutating、或 live 的 world-run），调度器只读这个位——一个 ask 转 live 本身
   * **不**关门：它还什么都没改。
   */
  importCacheClosed(): boolean;
  /** 该记录行在崩溃前是否 live 跑过（resume 时引擎从事件恢复；非 resume 恒 false）。 */
  wasLiveBeforeResume(instance: InstanceRef): boolean;
  /**
   * 该记录行的准入是否发生在导入缓存关闭**之前**（按事件次序恢复，见 engine-world.ts 的
   * recoverImportClosure）。续跑前驱在飞 ask 的判定要它才能在 resume 时精确复原；非 resume 恒 false。
   */
  wasQueuedBeforeImportClose(instance: InstanceRef): boolean;
  /**
   * R2 总量保险丝的计数：本 run 已准入的 ask 行数（引擎所有；resume 按 journal 的
   * `kind:"ask"` 行数恢复，跨生命周期连续——上限是 run 级的事实，反复 resume 不得刷新）。
   */
  askTotalCount(): number;
  /**
   * 记账一行 ask：调用点在**行创建的同一同步步骤里**（导入命中或 live 准入，见
   * scheduler.ts 的 pendingLive 闭包），于是「计数 = journal ask 行数」恒等，
   * resume 恢复（数行）与在生命周期内维护（本方法）给出同一个数。
   */
  countAskAdmitted(): void;
}

/** 一个 live（需真正派发执行）的 ask 节点。 */
export interface AskNode {
  instance: InstanceRef;
  actor: Actor;
  actorSeq: number;
  instructions: string;
  hash: string;
  spec: AskSpec;
  deferred: Deferred<unknown>;
  repairsRemaining: number;
  nudgesRemaining: number;
  settled: boolean;
  dispatched: boolean;
  lastStats?: AskStats;
  /**
   * 准入时算好的指令开头（{@link AskNode.instructions} 的前 N 字符）。存在节点上而不是两处
   * 各算一次：`node-queued` 与 `node-dispatched` 必须带**同一个**串（派发重复出生事实，
   * 见 types.ts 的 `node-dispatched`），存下来这件事就由构造保证，不靠两处调用保持同步。
   */
  instructionsHead?: string;
}

/** 调度器维护的 actor 运行态。 */
export interface Actor {
  ref: ActorRef;
  id: ActorId;
  persona: PersonaSpec;
  name?: string;
  /** journal 中该 actor 已记录的 ask 节点数——replay 时 live 节点须等其全部准入后才放行。 */
  recordedCount: number;
  /** 下一个待准入的 actorSeq。 */
  nextAdmitSeq: number;
  /** 已到达但未准入的记录节点释放动作，按 actorSeq 挂起（hold 规则）。 */
  pendingRecorded: Map<number, () => void>;
  /** 已到达但在等记录节点排空的 live 节点释放动作，按到达顺序。 */
  pendingLive: Array<() => void>;
  /** 已准入待派发的 live 节点（FIFO = 准入顺序）。 */
  liveQueue: AskNode[];
  /** 正在执行的 live 节点（actor 串行，至多一个）。 */
  current?: AskNode;
  /** 会话惰性创建，缓存其 promise（每 actor 一次）。 */
  sessionPromise?: Promise<SessionRef>;
  session?: SessionRef;
  /**
   * amend-resume 的导入消费态（引擎在 createActor 里按名 + persona 匹配后挂上，见
   * imported-cache.ts 的 `matchImportedActor`）。缺席即该 actor 全新重跑。
   */
  imported?: ImportedActorState;
}

// 合入后按当前格式化规则展开会超过调度器的 400 行限制；纯辅助函数与现有 defer 一起收在此处，行为不变。
/** replay 命中但 inputHash 不一致——纯度契约被破坏，run 大声失败。 */
export function hashMismatch(instance: InstanceRef, expected: string, got: string): WorkflowError {
  return new WorkflowError(
    "InputHashMismatch",
    `Replay hit at ${refToString(instance)} but inputHash differs (expected ${expected}, got ` +
      `${got}): the script is not deterministic, so the journal cannot be replayed.`,
    // 结构化 mismatch 与 ScriptHashMismatch 对齐：两个哈希不一致错误共用同一个字段，
    // 读端不必再从 message 文本里抠哈希。
    { mismatch: { expected, got } },
  );
}

/** cause → 一行有界文本（Error 取 message，其余 String()；空则给占位）。 */
export function describeCause(cause: unknown): string {
  const text = cause instanceof Error ? cause.message : String(cause);
  const trimmed = text.trim();
  if (trimmed.length === 0) return "unknown error";
  return trimmed.length > 300 ? `${trimmed.slice(0, 300)}…` : trimmed;
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
 *   已准入行数到达上界即节点级拒绝——不写行、不派发、不记账。拒绝不落 journal 也是
 *   replay 安全的：计数按行数恢复，resume 重放同一份脚本会在同一个准入位置到达同一道闸
 *   （准入次序由每 actor FIFO + hold 规则固定），确定性复现同一拒绝。
 * - **导入命中同样记账**：tryImportedSettle 命中会落一行真 dwf_node（importedAskRecord），
 *   计数跟上，「计数 = journal ask 行数」才恒等（恢复法与维护法是同一个数）。
 * - **R3 积压闸只管 live 路**：导入命中不入 liveNodes；resume 的记录再派发不经本函数
 *   （那不是创建新节点，拒掉它会破坏 replay 保真——journal 行已承诺过派发）。
 * - **记账与行创建同一同步步骤**：被任一闸拒绝的 ask 都不计数，行与计数不漂移。
 */
export function runBudgetGatedAdmission(
  host: SchedulerHost,
  liveNodeCount: number,
  deferred: Deferred<unknown>,
  tryImportedSettle: () => boolean,
  goLive: () => void,
): void {
  const { maxTotal, maxPending } = effectiveAskBudget(host.caps);
  const total = host.askTotalCount();
  if (total >= maxTotal) {
    deferred.reject(agentBudgetExceeded("total", maxTotal, total));
    return;
  }
  if (tryImportedSettle()) {
    host.countAskAdmitted();
    return;
  }
  if (liveNodeCount >= maxPending) {
    deferred.reject(agentBudgetExceeded("pending", maxPending, liveNodeCount));
    return;
  }
  host.countAskAdmitted();
  goLive();
}

/**
 * 落 journal 的 ask stats：**转录早于本次派发**的 ask 抹掉 `worldToolCalls`。
 *
 * 根因：driver 的工具计数器是内存态、每次 ask 起跑时清零，所以接着一段既有转录跑的 ask 只数
 * 得到自己这几轮，转录里原有的工具调用一个也数不到。少报的后果不是账目不准（那是 tokens 的
 * 事），而是**纯度判据被污染**：一个报 0 的 ask 会被后来的修订当成纯条目，在关门之后仍从缓存
 * 结算——而它其实碰过工作区。缺席这个键本就表示「碰过」（保守读法），所以抹掉才是诚实记录。
 * tokens / toolCalls / turns 照记：它们是用量，不是纯度声明。
 *
 * （原为 AskScheduler 私有方法；预算闸合入后调度器顶到 max-lines 门，按本文件既定的
 * 「纯辅助函数收在此处」惯例迁出，行为不变。）
 */
export function journaledStats(
  priorTranscriptAsks: ReadonlySet<string>,
  instance: InstanceRef,
  stats: AskStats,
): AskStats {
  if (!priorTranscriptAsks.has(refToString(instance))) return stats;
  const { worldToolCalls: _unreliable, ...rest } = stats;
  return rest;
}

/**
 * 作者指令的开头（{@link INSTRUCTIONS_HEAD_MAX_CHARS} 个字符，去两端空白，**不加省略号**）。
 * 空指令返回 undefined：缺席的键比一个空串诚实——读面据此退回「不知道它被交代了什么」。
 */
export function headOfInstructions(instructions: string): string | undefined {
  const trimmed = instructions.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length <= INSTRUCTIONS_HEAD_MAX_CHARS
    ? trimmed
    : trimmed.slice(0, INSTRUCTIONS_HEAD_MAX_CHARS);
}

/** 按原有准入顺序清空 actor 队列；派发仍由调度器唯一负责。 */
export function drainActorAdmission(actor: Actor): void {
  let progressed = true;
  while (progressed) {
    progressed = false;
    const release = actor.pendingRecorded.get(actor.nextAdmitSeq);
    if (release !== undefined) {
      actor.pendingRecorded.delete(actor.nextAdmitSeq);
      actor.nextAdmitSeq++;
      release();
      progressed = true;
      continue;
    }
    if (actor.nextAdmitSeq >= actor.recordedCount && actor.pendingLive.length > 0) {
      const admit = actor.pendingLive.shift()!;
      admit();
      progressed = true;
    }
  }
}
