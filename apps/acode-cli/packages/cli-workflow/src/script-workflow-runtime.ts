/* eslint-disable max-lines -- 存量基线豁免:该文件先于 CLI lint 门禁建立即超限(根 lint 的 ignorePatterns 排除 apps/acode-cli,turbo lint 因此从未变绿)。头注豁免以恢复门禁信号;拆分重构超出本批范围。 */
import {
  WorkflowAgentCallInputSchema,
  createChildTraceContext,
  createSessionId,
  type ScriptWorkflowActivityRecord,
  type ScriptWorkflowRunRecord,
  type ScriptWorkflowRunStats,
  type ScriptWorkflowRunStatus,
  type ScriptWorkflowStorePort,
  type SessionId,
  type TraceContext,
  type WorkflowAgentCallInput,
} from "@acode/contracts";
import { assertScriptWorkflowResumeOwner } from "@acode/workflow-run-command/contract";
// W1-R3 宿主解耦（spec 规则 1）：全仓唯一定义移入本包 host-types.ts；bootstrap types.ts 改为 re-export。
import type { PrepareUserExecutionBoundary } from "./host-types.js";
import { readWorkflowScriptDocument, stableHash } from "./script-workflow-meta.js";
import { prepareScriptWorkflowRun } from "./script-workflow-prepare.js";
import { resolveWorkflowConcurrencyCeiling } from "./workflow-concurrency-ceiling.js";
import {
  runScriptWorkflowChild,
  type ScriptWorkflowChildRequest,
} from "./script-workflow-process.js";
import type { ScriptWorkflowProgressAdapter } from "./script-workflow-progress-adapter.js";
import {
  createScriptWorkflowAgentRuntime,
  type ScriptWorkflowAgentRuntimeDeps,
} from "./script-workflow-child-runtime.js";
import {
  emptyScriptWorkflowStats,
  formatScriptWorkflowList,
  formatScriptWorkflowRun,
  formatScriptWorkflowValidation,
} from "./script-workflow-format.js";
import {
  WorkflowWorktreeManager,
  type WorkflowWorktreeHandle,
  type WorkflowWorktreeReleaseResult,
} from "./workflow-worktree-manager.js";
import {
  WorkflowLimiter,
  buildAgentPrompt,
  collectScriptWorkflowSessionStats,
  assertWorkflowOutputSchema,
  isRecord,
  isScriptWorkflowStore,
  mergedSignal,
  parseStructuredResponse,
  serializeError,
} from "./script-workflow-utils.js";

const MAX_WORKFLOW_AGENT_CALLS = 1000;

export interface ScriptWorkflowRuntimeDeps extends ScriptWorkflowAgentRuntimeDeps {
  /** child runtime 的注入工厂；缺省使用与 Dynamic Workflow 相同的生产配置。 */
  createAgentRuntime?: typeof createScriptWorkflowAgentRuntime;
  prepareUserExecutionBoundary: PrepareUserExecutionBoundary;
  /** Owner identity used to bind persisted runs to this session/workspace. */
  remoteSessionId?: string;
  /** Durable workflow owner facts captured by the bridge; legacy test hosts may omit them. */
  ownerGeneration?: number;
  ownerToken?: string;
  ownerReady?: Promise<{ ownerGeneration: number; ownerToken: string } | null | undefined>;
  traceContext: TraceContext;
  workspaceIdentity?: string;
  /** 测试注入点；缺省惰性构造真实 manager（S1，workflow-worktree-isolation.md R2）。 */
  worktreeManager?: WorkflowWorktreeManager;
  /**
   * dwf 进度投影的适配器（可选）。缺席时脚本工作流照跑，只是不进 `workflowRuns` 投影——
   * 那是观察面，绝不该有能力影响 run 本身。
   * 为什么复用 dwf 的投影而不是另建一套，以及「只有运行期实时可见」这条边界，
   * 见 script-workflow-progress-adapter.ts 的文件头。
   */
  progressAdapter?: ScriptWorkflowProgressAdapter;
}

/** activity result 信封里的 worktree 登记（R5：kept/path/branch 供调用方处置隔离产物）。 */
function buildWorktreeRecord(
  handle: WorkflowWorktreeHandle,
  release: WorkflowWorktreeReleaseResult | undefined,
) {
  return {
    baseRef: handle.baseRef,
    branch: handle.branch,
    kept: release?.kept ?? true,
    path: handle.path,
    releaseReason: release?.reason ?? "release-skipped",
  };
}

type ScriptWorkflowRunOptions = {
  abortSignal?: AbortSignal;
  onEvent?: (event: unknown) => void | Promise<void>;
} & Parameters<PrepareUserExecutionBoundary>[0];

/**
 * `run()` / `resume()` 返回值里的状态词——只有这两个方法**自己会写**的那三个。
 *
 * 为什么不直接用 `ScriptWorkflowRunStatus`：那个词表还含 `interrupted`（孤儿收敛写的，
 * 见 script-workflow-reconcile.ts）与 `pending`/`running`/`paused`（起跑前 / 在飞）。
 * 这两个方法在返回之前一定已经亲手结算过这条 run，所以返回值只可能是三者之一。
 *
 * 收窄不是装饰：facade 的返回类型是 `ExpertWorkflowCommandResult`，它的 `status` 用的是
 * **expert workflow 自己的**词汇（`WorkflowRunStatus`）。把更宽的词表塞过去编译不过，
 * 而为了迁就它去给另一套系统的词表加值是错的耦合——两套工作流系统各有各的状态词，
 * 只在投影/目录那一层翻译（script-workflow-run-summary.ts）。
 */
export type ScriptWorkflowSettleStatus = "cancelled" | "completed" | "failed";

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

  constructor(private readonly deps: ScriptWorkflowRuntimeDeps) {}

  /** worktree 生命周期唯一所有者（惰性构造；测试可经 deps.worktreeManager 注入替身）。 */
  private worktrees(): WorkflowWorktreeManager {
    this.worktreeManagerInstance ??= this.deps.worktreeManager ?? new WorkflowWorktreeManager();
    return this.worktreeManagerInstance;
  }

  async validate(input: { scriptPath: string }): Promise<{ response: string; traceId: string }> {
    const document = await readWorkflowScriptDocument({
      fileSystemPort: this.deps.fileSystemPort,
      scriptPath: input.scriptPath,
      traceContext: this.deps.traceContext,
    });
    // 刻意不碰 agentCallCounts：validate 不派生任何 agent，它去重置计数只会清掉某个在飞 run
    // 的额度（见字段注释）。
    return {
      response: formatScriptWorkflowValidation({
        meta: document.meta,
        scriptHash: document.hash,
        scriptPath: document.path,
      }),
      traceId: this.deps.traceContext.traceId,
    };
  }

  async list(input: { limit?: number } = {}): Promise<{ response: string; traceId: string }> {
    const runs = await this.store().listScriptWorkflowRuns({
      cwd: this.deps.workingDirectory,
      limit: input.limit ?? 20,
    });
    return {
      response: formatScriptWorkflowList(runs),
      traceId: this.deps.traceContext.traceId,
    };
  }

  async status(input: { runId?: string } = {}): Promise<{
    response: string;
    runId?: string;
    status?: ScriptWorkflowRunStatus;
    traceId: string;
  }> {
    const run = input.runId
      ? await this.store().getScriptWorkflowRun(input.runId)
      : (
          await this.store().listScriptWorkflowRuns({
            cwd: this.deps.workingDirectory,
            limit: 1,
          })
        )[0];
    if (!run) {
      return {
        response: "No workflow run found.",
        traceId: this.deps.traceContext.traceId,
      };
    }
    const activities = await this.store().listScriptWorkflowActivities({ runId: run.id });
    return {
      response: formatScriptWorkflowRun({ activities, run }),
      runId: run.id,
      status: run.status,
      traceId: this.deps.traceContext.traceId,
    };
  }

  async run(
    input: {
      args?: unknown;
      resumeFromRunId?: string;
      runId?: string;
      scriptPath: string;
      /** 发起这次 run 的工具调用；dwf 投影靠它把 run 卡联接到聊天里的那一行。 */
      toolCallId?: string;
    },
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
      await this.assertResumeOwner(input.resumeFromRunId);
    }
    await this.deps.prepareUserExecutionBoundary(options);
    const owner = await this.deps.ownerReady;
    if (owner === null) throw new Error("Workflow session owner lease is held by another process");
    this.ownerLeaseFacts = owner ??
      (this.deps.ownerToken === undefined || this.deps.ownerGeneration === undefined
        ? undefined
        : { ownerGeneration: this.deps.ownerGeneration, ownerToken: this.deps.ownerToken });
    throwIfAborted(options?.abortSignal);
    const document = await readWorkflowScriptDocument({
      fileSystemPort: this.deps.fileSystemPort,
      scriptPath: input.scriptPath,
      traceContext: options?.traceContext ?? this.deps.traceContext,
    });
    throwIfAborted(options?.abortSignal);
    await this.deps.runtime.ensureSessionPersistedForExternalActivity(
      `/workflow run ${document.path}`,
      { traceContext: options?.traceContext ?? this.deps.traceContext },
    );
    throwIfAborted(options?.abortSignal);
    const run = await prepareScriptWorkflowRun({
      args: input.args,
      document,
      parentSessionId: this.deps.sessionId,
      remoteSessionId: this.deps.remoteSessionId,
      resumeFromRunId: input.resumeFromRunId,
      runId: input.runId,
      store: this.store(),
      // 落库的这一份供**冷恢复**用（目录页与工具卡的联接键）；下面 registerRun 那一份供
      // 本次实时投影用。resume 时两者刻意不同：落库不改写（那一行的 toolCallId 是它自己
      // 出生时的事实），而实时投影要联到**本次** resume 调用的那一行工具卡上。
      ...(input.toolCallId === undefined ? {} : { toolCallId: input.toolCallId }),
      workspaceIdentity: this.deps.workspaceIdentity,
      workingDirectory: this.deps.workingDirectory,
      ...this.ownerFacts(),
    });
    // prepareScriptWorkflowRun is the first durable startup step.  A signal
    // that arrived while it was in flight must stop before projection/event
    // registration or child spawn; the orphan reconciler handles any row that
    // the storage adapter committed before this check.
    throwIfAborted(options?.abortSignal);
    // 投影上下文必须在第一个事件之前登记：`workflow_started` 会被翻译成 run-started，
    // 而那条信封要带上 toolCallId 才能把 run 卡联接到聊天里发起它的那一行。
    let progressRegistered = false;
    try {
      throwIfAborted(options?.abortSignal);
      this.deps.progressAdapter?.registerRun({
        parentSessionId: this.deps.sessionId,
        runId: run.id,
        ...(input.toolCallId === undefined ? {} : { toolCallId: input.toolCallId }),
      });
      progressRegistered = this.deps.progressAdapter !== undefined;
      throwIfAborted(options?.abortSignal);
      await this.appendEvent(run.id, "workflow_started", { scriptPath: document.path });
    } catch (error) {
      if (progressRegistered) this.deps.progressAdapter?.forgetRun(run.id);
      throw error;
    }

    // 脚本 return 的值，只在成功那条路上被赋值；失败/取消时保持 undefined，
    // formatter 据此不印 result 节（failure 节已经说了发生了什么）。
    let resultValue: unknown;
    // 报**自己写过的那个词**，而不是事后再读一遍行。读回来的值可能被并发改写
    // （孤儿收敛、兄弟进程），而本方法的返回值该说的是「我把它结算成了什么」。
    let settleStatus: ScriptWorkflowSettleStatus = "completed";

    try {
      try {
      throwIfAborted(options?.abortSignal);
      await this.store().updateScriptWorkflowRun({
        id: run.id,
        startedAt: Date.now(),
        status: "running",
        ...this.ownerFacts(),
      });
      const childResult = await runScriptWorkflowChild({
        args: input.args ?? run.args,
        budgetTotal: run.budgetTotal,
        document,
        handleEvent: (event) => this.handleChildEvent(run.id, event.type, event.payload),
        handleRequest: (request) => this.handleChildRequest(run, request, options),
        // 入口文件落盘的 runId：文件名即 `<runId>.mjs`，与 dwf 共用 .acode/workflow-runs/
        // 目录而靠 runId 前缀（wf_ vs dwfrun_）不冲突。
        onEntryFileWarning: (warning) => {
          // 非致命：项目目录写不进时已回落到临时目录，run 照常启动。但「实际执行体不在
          // 项目里」这件事必须留痕，否则事后找不到那次 run 跑的到底是什么。
          void this.appendEvent(run.id, "entry_file_fallback", {
            error: warning.error,
            fallbackDir: warning.fallbackDir,
            projectDir: warning.projectDir,
          });
        },
        runId: run.id,
        signal: options?.abortSignal,
        workingDirectory: this.deps.workingDirectory,
      });
      await this.store().updateScriptWorkflowRun({
        completedAt: Date.now(),
        id: run.id,
        status: "completed",
        ...(childResult.value === undefined ? {} : { result: childResult.value }),
        ...this.ownerFacts(),
      });
      // The run row is the terminal fact and already contains the result. The
      // event is an observation projection: a trigger/temporary lock must not
      // turn an already committed success into workflow_failed.
      try {
        await this.appendEvent(run.id, "workflow_completed", { result: childResult.value });
      } catch (eventError) {
        this.deps.logger?.warn?.("Script workflow completion event failed", {
          error: eventError instanceof Error ? eventError.message : String(eventError),
          event: "workflow.terminal_event_failed",
          module: "bootstrap.workflow",
          runId: run.id,
        });
      }
      // 脚本 `return` 的值只在这一刻手上有着：run 记录没有这一列，事件表当前也没有读路径。
      // 不回传的后果是调用方永远拿不到工作流产出——技能 §2 明写「return 是 run 交回结果的
      // 方式」，而实测（真实 headless 跑一遍）模型确实什么值都收不到，只能靠读脚本源码去猜。
      resultValue = childResult.value;
      } catch (error) {
      // 用户停下与脚本崩了是两笔不同的事实，必须分开落库：
      //   - 词表本来就有 `cancelled`（SCRIPT_WORKFLOW_RUN_STATUSES），而 tool port 的
      //     `workflowTaskStatus` 与终态判定（`status === "completed" || "failed" || "cancelled"`）
      //     早就认它——只是这里从来没写过，于是一次 TaskStop 在每一条读面上都显示成 failed；
      //   - 判据只认 **run 级** signal。`runAgent` 里 per-agent 超时用的是
      //     `mergedSignal(options?.abortSignal, timeoutMs)` 合出来的另一个 signal，它中止时
      //     run 级 signal 仍然没 aborted——那种情况是货真价实的失败（activity_failed 冒上来），
      //     不能算用户取消。
      // 取消不记 `failure`：abort reason 恒为「被取消」，记下来只会让 scriptWorkflowStatus
      // 与后台任务快照把一次用户主动停止报成带错误信息的失败。dwf 的 settleStopped 同款取舍
      // （只有 interrupted / provider 两种 reason 才随车带 error）。
      const cancelled = options?.abortSignal?.aborted === true;
      settleStatus = cancelled ? "cancelled" : "failed";
      await this.store().updateScriptWorkflowRun({
        completedAt: Date.now(),
        ...(cancelled ? {} : { failure: serializeError(error) }),
        id: run.id,
        status: cancelled ? "cancelled" : "failed",
        ...this.ownerFacts(),
      });
      await this.appendEvent(
        run.id,
        cancelled ? "workflow_cancelled" : "workflow_failed",
        serializeError(error),
      );
      }
    } finally {
      this.agentCallCounts.delete(run.id);
      this.statsWrites.delete(run.id);
      this.deps.progressAdapter?.forgetRun(run.id);
    }

    const finalRun = (await this.store().getScriptWorkflowRun(run.id)) ?? run;
    const activities = await this.store().listScriptWorkflowActivities({ runId: run.id });
    return {
      response: formatScriptWorkflowRun({ activities, run: finalRun, result: resultValue }),
      runId: run.id,
      // 报自己写过的那个词（见 settleStatus 的声明处）：读回来的行可能被并发改写。
      status: settleStatus,
      traceId: this.deps.traceContext.traceId,
    };
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
    await this.assertResumeOwner(input.runId, run);
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

  private async assertResumeOwner(
    runId: string,
    knownRun?: ScriptWorkflowRunRecord | null,
  ): Promise<void> {
    const run = knownRun ?? (await this.store().getScriptWorkflowRun(runId));
    if (!run) throw new Error(`Workflow run not found: ${runId}`);
    await assertScriptWorkflowResumeOwner(
      { sessionId: this.deps.sessionId, sessionStore: this.deps.sessionStore },
      run,
      {
        parentSessionId: this.deps.sessionId,
        remoteSessionId: this.deps.remoteSessionId,
        workspaceIdentity: this.deps.workspaceIdentity,
        workspacePath: this.deps.workingDirectory,
      },
    );
  }

  private async handleChildRequest(
    run: ScriptWorkflowRunRecord,
    request: ScriptWorkflowChildRequest,
    options?: ScriptWorkflowRunOptions,
  ): Promise<unknown> {
    if (request.type === "agent") {
      return this.runAgent(run, WorkflowAgentCallInputSchema.parse(request.payload), options);
    }
    if (request.type === "workflow") {
      throw new Error("Nested workflow() is reserved for a later workflow runtime version.");
    }
    throw new Error(`Unknown workflow child request: ${request.type}`);
  }

  private async handleChildEvent(runId: string, type: string, payload: unknown): Promise<void> {
    if (type === "phase" && isRecord(payload) && typeof payload.title === "string") {
      await this.store().updateScriptWorkflowRun({
        currentPhase: payload.title,
        id: runId,
        ...this.ownerFacts(),
      });
    }
    await this.appendEvent(runId, `script_${type}`, payload);
  }

  private async runAgent(
    run: ScriptWorkflowRunRecord,
    input: WorkflowAgentCallInput,
    options?: ScriptWorkflowRunOptions,
  ): Promise<unknown> {
    if (input.opts?.schema) assertWorkflowOutputSchema(input.opts.schema);
    // 上限按 run 计，不按 runtime 实例计（字段注释里记了为什么）。
    const used = this.agentCallCounts.get(run.id) ?? 0;
    if (used >= MAX_WORKFLOW_AGENT_CALLS) {
      throw new Error(`Workflow agent call limit exceeded: ${MAX_WORKFLOW_AGENT_CALLS}`);
    }
    const callIndex = used + 1;
    this.agentCallCounts.set(run.id, callIndex);
    const callPath = input.callPath ?? `root/agent${callIndex}`;
    const phase = input.opts?.phase ?? input.phase;
    const inputHash = stableHash({ opts: input.opts, phase, prompt: input.prompt });
    const cached = await this.store().findCachedScriptWorkflowActivity({
      callPath,
      inputHash,
      runId: run.id,
    });
    if (cached?.result) {
      // 事件载荷带上投影所需的事实（callPath / label / phase）。原来只有 activityId，
      // 而进度适配器要据此构造 dwf 投影的 instance/actor 引用（`{siteId, ordinal}`）与
      // 子代理显示名——按 id 回查 store 是每条事件一次异步读，既有开销又有竞态。
      // 追加键对既有消费者无害（它们只读 activityId）。
      await this.appendEvent(run.id, "activity_cached", {
        activityId: cached.id,
        callPath,
        label: input.opts?.label,
        phase,
      });
      // The child runner unwraps result.value while reading stats from the envelope.
      return cached.result;
    }

    const activity = await this.store().createScriptWorkflowActivity({
      callIndex,
      callPath,
      id: `activity_${crypto.randomUUID()}`,
      inputHash,
      label: input.opts?.label,
      opts: input.opts,
      phase,
      prompt: input.prompt,
      runId: run.id,
      type: "agent",
    });
    return this.limiter.run(() => this.runLiveAgent(run, activity, input, options));
  }

  private async runLiveAgent(
    run: ScriptWorkflowRunRecord,
    activity: ScriptWorkflowActivityRecord,
    input: WorkflowAgentCallInput,
    options?: ScriptWorkflowRunOptions,
  ): Promise<unknown> {
    // S1（specs/workflow-worktree-isolation.md）：isolation:"worktree" 由 not-implemented
    // 桩兑现为真实 git worktree 隔离——ensure 失败 fail-loud 进 catch（activity failed），
    // 绝不静默降级回共享 cwd；终态回收裁决见下方 try/catch/finally。
    let worktree: WorkflowWorktreeHandle | undefined;
    let worktreeRelease: WorkflowWorktreeReleaseResult | undefined;
    let childSessionPersisted = false;
    let measuredStats: ScriptWorkflowRunStats | undefined;
    let activityFinalized = false;
    let usageSettled = false;
    const startedAt = Date.now();
    const childSessionId = createSessionId(`workflow_${activity.id}`);
    const childTraceContext = createChildTraceContext(this.deps.traceContext, {
      attributes: {
        parentSessionId: this.deps.sessionId,
        workflowActivityId: activity.id,
        workflowRunId: run.id,
      },
      sessionId: childSessionId,
    });
    const agentPrompt = buildAgentPrompt(input);

    let unsubscribe: (() => void) | undefined;
    try {
      if (input.opts?.isolation === "worktree") {
        worktree = await this.worktrees().ensureWorktree({
          activityId: activity.id,
          label: input.opts.label,
          repoDir: this.deps.workingDirectory,
          runId: run.id,
        });
      }
      const childRuntime = (this.deps.createAgentRuntime ?? createScriptWorkflowAgentRuntime)({
        childSessionId,
        deps: this.deps,
        request: input,
        traceContext: childTraceContext,
        // R4 注入面：configOverrides 的 spread 顺序覆盖 deps 直传的父目录；
        // workspaceRoot 与 workingDirectory 同源（agent-runtime），breaker 收敛随迁。
        ...(worktree ? { configOverrides: { workingDirectory: worktree.path } } : {}),
      });
      // workflow_activity.child_session_id has an FK to session(id), so link only after persistence.
      await childRuntime.ensureSessionPersistedForExternalActivity(agentPrompt, {
        traceContext: childTraceContext,
      });
      childSessionPersisted = true;
      await this.store().updateScriptWorkflowActivity({
        childSessionId,
        id: activity.id,
        startedAt,
        status: "running",
      });
      await this.appendEvent(run.id, "activity_started", {
        activityId: activity.id,
        // 用 activity 记录上的字段而不是局部变量：这一段在 runLiveAgent 里，
        // callPath/phase 的局部绑定属于调用方 runAgent 的作用域。记录才是持久化的真值。
        callPath: activity.callPath,
        childSessionId,
        label: activity.label ?? input.opts?.label,
        phase: activity.phase,
      });
      unsubscribe = options?.onEvent
        ? childRuntime.subscribeEvents({ onSessionEvent: options.onEvent })
        : undefined;
      const signal = mergedSignal(options?.abortSignal, input.opts?.timeoutMs);
      const result = await childRuntime.executeTurn(agentPrompt, undefined, {
        abortSignal: signal,
        inputSource: "subagent",
        traceContext: childTraceContext,
      });
      const stats = await this.collectSessionStats(childSessionId);
      measuredStats = stats;
      const value = input.opts?.schema
        ? parseStructuredResponse(result.response, input.opts.schema)
        : result.response;
      // R5：成功路径在写 completed 记录**之前**完成回收裁决——result 信封要带 kept 信息。
      if (worktree) {
        worktreeRelease = await this.worktrees().releaseWorktree(worktree);
      }
      const activityResult = {
        response: result.response,
        stats,
        traceId: result.traceId,
        turnId: result.turnId,
        value,
        ...(worktree ? { worktree: buildWorktreeRecord(worktree, worktreeRelease) } : {}),
      };
      await this.store().updateScriptWorkflowActivity({
        completedAt: Date.now(),
        id: activity.id,
        result: activityResult,
        status: "completed",
      });
      activityFinalized = true;
      // activity 进入 completed 后立即把 child 已持久化的用量并入 run；后续的 task-link 或
      // 观察事件属于派生面，失败时不能让这笔真实用量丢失或在 catch 中重复计数。
      try {
        await this.addRunStatsForActivity(run.id, stats, activity.id);
        usageSettled = true;
      } catch (statsError) {
        // 已完成的 activity 不能因为统计写入失败而改判为 failed。事务按 activityId 幂等，
        // 因此即使 commit 已成功而响应丢失，重试一次也不会重复累计。
        try {
          await this.addRunStatsForActivity(run.id, stats, activity.id);
          usageSettled = true;
        } catch (retryError) {
          await this.markUsageIncomplete(run.id, activity.id, activityResult, retryError);
          usageSettled = true;
          this.deps.logger?.warn?.("Script workflow usage accounting incomplete", {
            error: retryError instanceof Error ? retryError.message : String(retryError),
            firstError: statsError instanceof Error ? statsError.message : String(statsError),
            event: "workflow.usage.accounting_incomplete",
            module: "bootstrap.workflow",
            runId: run.id,
            activityId: activity.id,
          });
        }
      }
      const childSelection = childRuntime.getSessionModelSelection();
      await this.store().createSessionTaskLink({
        activityId: activity.id,
        agentType: input.opts?.agentType,
        childSessionId,
        id: `tasklink_${crypto.randomUUID()}`,
        label: input.opts?.label,
        model: childSelection
          ? `${childSelection.providerId}/${childSelection.modelId}`
          : undefined,
        parentSessionId: this.deps.sessionId,
        path: activity.callPath,
        phase: activity.phase,
        role: "workflow_agent",
        rootWorkflowRunId: run.id,
        status: "completed",
      });
      await this.appendEvent(run.id, "activity_completed", {
        activityId: activity.id,
        callPath: activity.callPath,
        label: activity.label ?? input.opts?.label,
        phase: activity.phase,
      });
      // Keep the activity envelope on the child-process IPC boundary; script code receives value.
      return activityResult;
    } catch (error) {
      // R5：失败/abort 同样先裁决——abort 常留半截编辑（dirty），材料优先保留并登记。
      if (worktree && !worktreeRelease) {
        worktreeRelease = await this.worktrees().releaseWorktree(worktree);
      }
      // 终态 activity 只允许写一次。结果解析失败、usage 投影失败或尾部事件落盘失败都可能
      // 在 completed 写入之后抛错；这些错误不能把已完成的 activity 改成 failed，也不能再次
      // 计作一笔 agent。否则 durable stats 与活动终态会相互矛盾。
      const needsFailureEvent = !activityFinalized;
      if (needsFailureEvent) {
        await this.store().updateScriptWorkflowActivity({
          completedAt: Date.now(),
          error: serializeError(error),
          id: activity.id,
          ...(worktree
            ? { result: { worktree: buildWorktreeRecord(worktree, worktreeRelease) } }
            : {}),
          status: "failed",
        });
        activityFinalized = true;
      }
      if (!usageSettled && childSessionPersisted) {
        try {
          measuredStats ??= await this.collectSessionStats(childSessionId);
          await this.addRunStatsForActivity(
            run.id,
            {
              ...measuredStats,
              failedAgentCalls: measuredStats.failedAgentCalls + (needsFailureEvent ? 1 : 0),
            },
            activity.id,
          );
          usageSettled = true;
        } catch (statsError) {
          // 统计读取失败不能伪装成零用量；同时登记持久化不完整标记，冷恢复和任务输出
          // 也能如实显示未知，而不是只有日志知道该 run 的账本少了一笔。
          await this.markUsageIncomplete(
            run.id,
            activity.id,
            worktree ? { worktree: buildWorktreeRecord(worktree, worktreeRelease) } : undefined,
            statsError,
          );
          this.deps.logger?.warn?.("Script workflow usage accounting incomplete", {
            error: statsError instanceof Error ? statsError.message : String(statsError),
            event: "workflow.usage.accounting_incomplete",
            module: "bootstrap.workflow",
            runId: run.id,
            activityId: activity.id,
          });
        }
      }
      if (needsFailureEvent) {
        await this.appendEvent(run.id, "activity_failed", {
          activityId: activity.id,
          callPath: activity.callPath,
          error: serializeError(error),
          label: activity.label ?? input.opts?.label,
          phase: activity.phase,
        });
      }
      throw error;
    } finally {
      unsubscribe?.();
      // 兜底：正常路径已在 try/catch 内裁决；仅当 release 自身意外抛出才走到这里。
      if (worktree && !worktreeRelease) {
        await this.worktrees()
          .releaseWorktree(worktree)
          .catch(() => undefined);
      }
    }
  }

  private async collectSessionStats(sessionId: SessionId): Promise<ScriptWorkflowRunStats> {
    return collectScriptWorkflowSessionStats(
      this.deps.sessionStore,
      sessionId,
      emptyScriptWorkflowStats,
    );
  }

  private async markUsageIncomplete(
    runId: string,
    activityId: string,
    result: unknown,
    error: unknown,
  ): Promise<void> {
    await this.store().updateScriptWorkflowActivity({
      id: activityId,
      result: {
        ...(isRecord(result) ? result : {}),
        usageAccounting: { error: serializeError(error), status: "incomplete" },
      },
    });
    try {
      await this.appendEvent(runId, "workflow_usage_incomplete", { activityId });
    } catch (eventError) {
      // result 标记已经落盘，是冷恢复的真值；通知写入失败不能再次失败结算已完成的 activity。
      this.deps.logger?.warn?.("Script workflow usage incomplete event failed", {
        activityId,
        error: eventError instanceof Error ? eventError.message : String(eventError),
        event: "workflow.usage.incomplete_event_failed",
        module: "bootstrap.workflow",
        runId,
      });
    }
  }

  /**
   * 入账及实时投影的串行化链，按 runId 各一条。
   *
   * SQLite 事务负责 durable 统计及 activity 幂等；这里让每笔提交后的累计用量投影有序，
   * 避免并发 agent 的观察通知晚到后把卡片里的 token 总量改回旧值。
   *
   * 链只串行同一 run；不同 run 互不阻塞。清理点与 agentCallCounts 同一个（run 结算），
   * 否则长会话里每个 run 漏一条 Map 项——那条注释里记的正是同款 bug。
   */
  private readonly statsWrites = new Map<string, Promise<void>>();

  private addRunStatsForActivity(
    runId: string,
    delta: ScriptWorkflowRunStats,
    activityId: string,
  ): Promise<void> {
    const previous = this.statsWrites.get(runId) ?? Promise.resolve();
    const next = previous.then(() => this.writeRunStatsForActivity(runId, delta, activityId));
    return this.trackStatsWrite(runId, next);
  }

  private trackStatsWrite(runId: string, next: Promise<void>): Promise<void> {
    // 链上存的是吞掉失败的版本：一次写失败不该把这条 run 后续所有的写都堵死。
    // 调用方拿到的仍是会 reject 的 `next`（runAgent 在 try/catch 里 await 它）。
    this.statsWrites.set(
      runId,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  private async writeRunStatsForActivity(
    runId: string,
    delta: ScriptWorkflowRunStats,
    activityId: string,
  ): Promise<void> {
    const run = await this.store().recordScriptWorkflowActivityUsage({
      activityId,
      delta,
      eventId: `workflow_event_${crypto.randomUUID()}`,
      runId,
      ...this.ownerFacts(),
    });
    // SQLite 同一事务提交累计值与 activityId 账本；重试只读回原值。这里仅做观察投影，
    // 失败不会改变 activity 终态，亦不会重新累计已经持久化的真实用量。
    try {
      this.deps.progressAdapter?.onEvent({
        payload: { spentTokens: run.budgetSpent },
        runId,
        type: "workflow_usage",
      });
    } catch (error) {
      this.deps.logger?.warn?.("Script workflow usage projection failed", {
        error: error instanceof Error ? error.message : String(error),
        event: "workflow.usage.projection_failed",
        module: "bootstrap.workflow",
        runId,
        spentTokens: run.budgetSpent,
      });
    }
  }

  private async appendEvent(runId: string, type: string, payload?: unknown): Promise<void> {
    await this.store().appendScriptWorkflowEvent({
      id: `workflow_event_${crypto.randomUUID()}`,
      payload,
      runId,
      type,
    });
    // 观察面挂在持久化之后：先落库再投影，于是「投影里有的事件一定已经durable」。
    // 整段包 try/catch —— dwf 的进度汇自己承诺永不抛（见其文件头的三条降级路径），
    // 但这里是**第二**个消费者，不能把「适配器有 bug」变成「run 挂掉」。进度面是观察面，
    // 绝不该有能力终止一个正在跑的 run；这条纪律与 dwf 进度汇同源。
    try {
      this.deps.progressAdapter?.onEvent({ payload, runId, type });
    } catch (error) {
      this.deps.logger?.warn?.("Script workflow progress projection failed", {
        error: error instanceof Error ? error.message : String(error),
        event: "workflow.progress.projection_failed",
        module: "bootstrap.workflow",
        runId,
        type,
      });
    }
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

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error("Workflow script run cancelled");
}
