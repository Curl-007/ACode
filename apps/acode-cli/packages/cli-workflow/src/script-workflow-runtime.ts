// ============================================================
// ScriptWorkflowRuntime：脚本工作流的运行时外壳（协调主体）
// ============================================================
// W1-R3 max-lines 例外偿还后的形态：本文件只保留「装配 + 薄委托 + 私有状态的所有权」三件事——
// 按会话持有的私有状态（并发闸门、agent 调用计数、所有权事实、worktree manager、统计写入链），
// 以及把只读查询 / run 主体 / agent 派生 / 统计链委托给五个叶子：
//   - script-workflow-runtime-deps.ts 依赖面（ScriptWorkflowRuntimeDeps）与共享类型（宿主接口、状态词表）
//   - script-workflow-query.ts        validate / list / status
//   - script-workflow-run-body.ts     run() 的执行主体、resume 所有权断言、事件追加、状态词表
//   - script-workflow-run-agent.ts    子请求分发与 agent activity 的完整生命周期
//   - script-workflow-stats.ts        用量收集、串行入账链与不完整登记
// 公开面不变：contract.ts 从此文件 re-export 的 `ScriptWorkflowRuntime` 与 `ScriptWorkflowRuntimeDeps`
// 符号名、路径、形状逐字保持；`ScriptWorkflowRunOptions` / `ScriptWorkflowSettleStatus` 随迁 runtime-deps，
// 本文件 re-export。
//
// run() 的形状：前置段（中止检查、resume 所有权、执行边界、写边界与所有权事实落定）留在这里——
// 它读的正是本类的私有字段；从读脚本文档起的整段执行主体经 executeScriptWorkflowRun 委托。

import type {
  ScriptWorkflowRunStatus,
  ScriptWorkflowStorePort,
} from "@acode/contracts";
import {
  getWorkflowRunStatus,
  listWorkflowRuns,
  validateWorkflowScript,
  type ScriptWorkflowQueryHost,
} from "./script-workflow-query.js";
import {
  appendRunEvent,
  assertRunResumeOwner,
  executeScriptWorkflowRun,
  throwIfAborted,
} from "./script-workflow-run-body.js";
import type {
  ScriptWorkflowRunHost,
  ScriptWorkflowRunInput,
  ScriptWorkflowRunOptions,
  ScriptWorkflowRuntimeDeps,
  ScriptWorkflowSettleStatus,
} from "./script-workflow-runtime-deps.js";
import type { ScriptWorkflowStatsHost } from "./script-workflow-stats.js";
import { WorkflowLimiter, isScriptWorkflowStore } from "./script-workflow-utils.js";
import { resolveWorkflowConcurrencyCeiling } from "./workflow-concurrency-ceiling.js";
import { resolveWriteBoundaryOwner } from "./workflow-owner-lease.js";
import { WorkflowWorktreeManager } from "./workflow-worktree-manager.js";

// 依赖面与共享类型住在 script-workflow-runtime-deps.ts（叶子共享、无回边）；
// 外壳 re-export 以保持公开面：contract.ts 从本文件 re-export `ScriptWorkflowRuntimeDeps`。
export type { ScriptWorkflowRuntimeDeps } from "./script-workflow-runtime-deps.js";
export type { ScriptWorkflowRunOptions, ScriptWorkflowSettleStatus } from "./script-workflow-runtime-deps.js";

export class ScriptWorkflowRuntime {
  // 与 workflow run service / 进程级治理器同一份天花板实现；legacy 工具仍只有本地 limiter，不接治理器。
  private readonly concurrency = resolveWorkflowConcurrencyCeiling();
  private readonly limiter = new WorkflowLimiter(this.concurrency);
  /**
   * 每个 run 各自一份的 agent 调用计数，键是 runId。
   *
   * 为什么不是单个实例字段：runtime 实例按**会话** memoize（script-workflow-methods.ts 的
   * `runtime ??= new ScriptWorkflowRuntime(...)`），而 1000 的上限是**每 run** 的语义。
   * 用一个 `callIndex` 实例字段时它会跨 run 累加——一个会话里累计跑满 1000 次 agent 之后，
   * 此后每次 `agent()` 都抛 `Workflow agent call limit exceeded`，脚本工作流在该会话里
   * 永久失效直到重启。同一字段还让并发的两个 run 互相吃对方的额度。
   *
   * 原来 `validate()` 里那句 `this.callIndex = 0` 是同一个 bug 的另一半：validate 根本不派生
   * agent，它去归零只会清掉某个**在飞** run 的计数，让那个 run 的上限形同不存在。已删除。
   */
  private readonly agentCallCounts = new Map<string, number>();
  private ownerLeaseFacts?: { ownerGeneration: number; ownerToken: string };
  private worktreeManagerInstance?: WorkflowWorktreeManager;
  /**
   * 入账及实时投影的串行化链，按 runId 各一条。实现与完整注释随迁
   * script-workflow-stats.ts（addRunStatsForActivity）；清理点与 agentCallCounts 同一个（run 结算）。
   */
  private readonly statsWrites = new Map<string, Promise<void>>();
  /**
   * 交给四个叶子的宿主面：全是本类私有状态的**引用**（不是副本），叶子经它接触 runtime。
   * 同一个对象同时满足三个宿主接口（查询 / run 编排 / 统计），因为它们要的状态面大量重叠，
   * 一份装配避免三处漂移。appendEvent 是对本类方法的懒自引用（经 run-body 的 appendRunEvent），
   * 调用时才求值，不构成构造期环。
   */
  private readonly host: ScriptWorkflowQueryHost & ScriptWorkflowRunHost & ScriptWorkflowStatsHost;

  constructor(private readonly deps: ScriptWorkflowRuntimeDeps) {
    this.host = {
      agentCallCounts: this.agentCallCounts,
      appendEvent: (runId, type, payload) => appendRunEvent(this.host, runId, type, payload),
      deps,
      limiter: this.limiter,
      ownerFacts: () => this.ownerFacts(),
      statsWrites: this.statsWrites,
      store: () => this.store(),
      worktrees: () => this.worktrees(),
    };
  }

  /** worktree 生命周期唯一所有者（惰性构造；测试可经 deps.worktreeManager 注入替身）。 */
  private worktrees(): WorkflowWorktreeManager {
    this.worktreeManagerInstance ??= this.deps.worktreeManager ?? new WorkflowWorktreeManager();
    return this.worktreeManagerInstance;
  }

  async validate(input: { scriptPath: string }): Promise<{ response: string; traceId: string }> {
    return validateWorkflowScript(this.host, input);
  }

  async list(input: { limit?: number } = {}): Promise<{ response: string; traceId: string }> {
    return listWorkflowRuns(this.host, input);
  }

  async status(input: { runId?: string } = {}): Promise<{
    response: string;
    runId?: string;
    status?: ScriptWorkflowRunStatus;
    traceId: string;
  }> {
    return getWorkflowRunStatus(this.host, input);
  }

  async run(
    input: ScriptWorkflowRunInput,
    options?: ScriptWorkflowRunOptions,
  ): Promise<{
    response: string;
    runId: string;
    status: ScriptWorkflowSettleStatus;
    traceId: string;
  }> {
    throwIfAborted(options?.abortSignal);
    // Resume is also reachable through the app facade, not only WorkflowPort.
    // Enforce the same owner boundary here before reading the supplied script
    // path or touching any durable workflow state.
    if (input.resumeFromRunId !== undefined) {
      await assertRunResumeOwner(this.host, input.resumeFromRunId);
    }
    await this.deps.prepareUserExecutionBoundary(options);
    // D3/R4 修复：写边界恒经 resolveWriteBoundaryOwner 读 **live** 所有权（内部走 reclaim），
    // 不再读冻结的一次性 ownerReady。旧形状在初始 claim 成功后 ownerReady 永久非 null，接管后
    // reclaim 永不触发 → run() 拿陈旧 facts 越过闸门、落库陈旧行（见 dwf ensureWorkflowOwner
    // 同处注释与 specs/workflow-owner-lease.md D3）。
    const owner = await resolveWriteBoundaryOwner({
      ownerReady: this.deps.ownerReady,
      ownerReclaim: this.deps.ownerReclaim,
    });
    if (owner === null) throw new Error("Workflow session owner lease is held by another process");
    this.ownerLeaseFacts = owner ??
      (this.deps.ownerToken === undefined || this.deps.ownerGeneration === undefined
        ? undefined
        : { ownerGeneration: this.deps.ownerGeneration, ownerToken: this.deps.ownerToken });
    return executeScriptWorkflowRun(this.host, input, options);
  }

  async resume(
    input: { runId: string },
    options?: ScriptWorkflowRunOptions,
  ): Promise<{
    response: string;
    runId: string;
    // resume 委托给 run()，所以能返回的词与它逐字同一套（理由见 ScriptWorkflowSettleStatus）。
    status: ScriptWorkflowSettleStatus;
    traceId: string;
  }> {
    throwIfAborted(options?.abortSignal);
    const run = await this.store().getScriptWorkflowRun(input.runId);
    if (!run) throw new Error(`Workflow run not found: ${input.runId}`);
    await assertRunResumeOwner(this.host, input.runId, run);
    if (!run.scriptPath) throw new Error(`Workflow run has no script path: ${input.runId}`);
    return this.run(
      {
        args: run.args,
        resumeFromRunId: input.runId,
        scriptPath: run.scriptPath,
      },
      options,
    );
  }

  private store(): ScriptWorkflowStorePort {
    if (isScriptWorkflowStore(this.deps.sessionStore)) return this.deps.sessionStore;
    throw new Error("Script workflow store is not available for this session store.");
  }

  private ownerFacts():
    | { ownerGeneration: number; ownerToken: string }
    | Record<string, never> {
    const owner = this.ownerLeaseFacts ??
      (this.deps.ownerToken === undefined || this.deps.ownerGeneration === undefined
        ? undefined
        : { ownerGeneration: this.deps.ownerGeneration, ownerToken: this.deps.ownerToken });
    return owner === undefined
      ? {}
      : owner;
  }
}
