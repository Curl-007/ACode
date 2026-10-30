// ============================================================
// ScriptWorkflowRuntime：一次 run 的执行主体（原 run() 方法体的后半段）
// ============================================================
// script-workflow-runtime.ts 偿还 W1-R3 max-lines 例外：把 run() 从「所有权事实落定」之后到终局返回的
// 整段执行主体（脚本读取 → 会话持久化 → run 行落库 → 投影登记 → 子进程执行与三态结算 → 清理）拆到本文件。
// 前置段（中止检查、resume 所有权、执行边界、写边界与 ownerLeaseFacts 赋值）留在主类——那里读的正是
// 主类自己的私有字段；本文件经 {@link ScriptWorkflowRunHost} 拿到全部所需状态。原方法体逐字保留。
//
// 依赖方向（无运行时环）：本文件 → runtime-deps（共享类型）/ run-agent（子请求/事件的处理函数）；
// run-agent → 本文件仅取函数。共享类型（宿主接口与状态词表）住在 script-workflow-runtime-deps.ts——
// 架构检查器把 `import type` 也算依赖边，叶子不能类型回指外壳。

import type { ScriptWorkflowRunRecord } from "@acode/contracts";
import { assertScriptWorkflowResumeOwner } from "@acode/workflow-run-command/contract";
import { formatScriptWorkflowRun } from "./script-workflow-format.js";
import { readWorkflowScriptDocument } from "./script-workflow-meta.js";
import { prepareScriptWorkflowRun } from "./script-workflow-prepare.js";
import { runScriptWorkflowChild } from "./script-workflow-process.js";
import type {
  ScriptWorkflowRunHost,
  ScriptWorkflowRunInput,
  ScriptWorkflowRunOptions,
  ScriptWorkflowSettleStatus,
} from "./script-workflow-runtime-deps.js";
import { serializeError } from "./script-workflow-utils.js";
import { handleChildRunEvent, handleChildRunRequest } from "./script-workflow-run-agent.js";

/** 已 aborted 的 signal 立刻抛其 reason（原文件尾的自由函数，随迁并导出）。 */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error("Workflow script run cancelled");
}

/**
 * resume 的所有权边界（原 assertResumeOwner 方法体）：读取/续跑别人工作区的 run 行之前，
 * 先经 {@link assertScriptWorkflowResumeOwner} 断言本会话就是它的拥有者。
 */
export async function assertRunResumeOwner(
  host: ScriptWorkflowRunHost,
  runId: string,
  knownRun?: ScriptWorkflowRunRecord | null,
): Promise<void> {
  const run = knownRun ?? (await host.store().getScriptWorkflowRun(runId));
  if (!run) throw new Error(`Workflow run not found: ${runId}`);
  await assertScriptWorkflowResumeOwner(
    { sessionId: host.deps.sessionId, sessionStore: host.deps.sessionStore },
    run,
    {
      parentSessionId: host.deps.sessionId,
      remoteSessionId: host.deps.remoteSessionId,
      workspaceIdentity: host.deps.workspaceIdentity,
      workspacePath: host.deps.workingDirectory,
    },
  );
}

/**
 * 追加一条 run 事件（原 appendEvent 方法体）。
 */
export async function appendRunEvent(
  host: ScriptWorkflowRunHost,
  runId: string,
  type: string,
  payload?: unknown,
): Promise<void> {
  await host.store().appendScriptWorkflowEvent({
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
    host.deps.progressAdapter?.onEvent({ payload, runId, type });
  } catch (error) {
    host.deps.logger?.warn?.("Script workflow progress projection failed", {
      error: error instanceof Error ? error.message : String(error),
      event: "workflow.progress.projection_failed",
      module: "bootstrap.workflow",
      runId,
      type,
    });
  }
}

/**
 * 一次 run 的执行主体（原 run() 方法体自「所有权事实落定」之后的整段）。
 * 前置段留在主类（那里读的是主类私有字段）；本函数从读脚本文档开始，到终局返回结束。
 */
export async function executeScriptWorkflowRun(
  host: ScriptWorkflowRunHost,
  input: ScriptWorkflowRunInput,
  options?: ScriptWorkflowRunOptions,
): Promise<{
  response: string;
  runId: string;
  status: ScriptWorkflowSettleStatus;
  traceId: string;
}> {
  throwIfAborted(options?.abortSignal);
  const document = await readWorkflowScriptDocument({
    fileSystemPort: host.deps.fileSystemPort,
    scriptPath: input.scriptPath,
    traceContext: options?.traceContext ?? host.deps.traceContext,
  });
  throwIfAborted(options?.abortSignal);
  await host.deps.runtime.ensureSessionPersistedForExternalActivity(
    `/workflow run ${document.path}`,
    { traceContext: options?.traceContext ?? host.deps.traceContext },
  );
  throwIfAborted(options?.abortSignal);
  const run = await prepareScriptWorkflowRun({
    args: input.args,
    document,
    parentSessionId: host.deps.sessionId,
    remoteSessionId: host.deps.remoteSessionId,
    resumeFromRunId: input.resumeFromRunId,
    runId: input.runId,
    store: host.store(),
    // 落库的这一份供**冷恢复**用（目录页与工具卡的联接键）；下面 registerRun 那一份供
    // 本次实时投影用。resume 时两者刻意不同：落库不改写（那一行的 toolCallId 是它自己
    // 出生时的事实），而实时投影要联到**本次** resume 调用的那一行工具卡上。
    ...(input.toolCallId === undefined ? {} : { toolCallId: input.toolCallId }),
    workspaceIdentity: host.deps.workspaceIdentity,
    workingDirectory: host.deps.workingDirectory,
    ...host.ownerFacts(),
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
    host.deps.progressAdapter?.registerRun({
      parentSessionId: host.deps.sessionId,
      runId: run.id,
      ...(input.toolCallId === undefined ? {} : { toolCallId: input.toolCallId }),
    });
    progressRegistered = host.deps.progressAdapter !== undefined;
    throwIfAborted(options?.abortSignal);
    await host.appendEvent(run.id, "workflow_started", { scriptPath: document.path });
  } catch (error) {
    if (progressRegistered) host.deps.progressAdapter?.forgetRun(run.id);
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
      await host.store().updateScriptWorkflowRun({
        id: run.id,
        startedAt: Date.now(),
        status: "running",
        ...host.ownerFacts(),
      });
      const childResult = await runScriptWorkflowChild({
        args: input.args ?? run.args,
        budgetTotal: run.budgetTotal,
        document,
        handleEvent: (event) => handleChildRunEvent(host, run.id, event.type, event.payload),
        handleRequest: (request) => handleChildRunRequest(host, run, request, options),
        // 入口文件落盘的 runId：文件名即 `<runId>.mjs`，与 dwf 共用 .acode/workflow-runs/
        // 目录而靠 runId 前缀（wf_ vs dwfrun_）不冲突。
        onEntryFileWarning: (warning) => {
          // 非致命：项目目录写不进时已回落到临时目录，run 照常启动。但「实际执行体不在
          // 项目里」这件事必须留痕，否则事后找不到那次 run 跑的到底是什么。
          void host.appendEvent(run.id, "entry_file_fallback", {
            error: warning.error,
            fallbackDir: warning.fallbackDir,
            projectDir: warning.projectDir,
          });
        },
        runId: run.id,
        signal: options?.abortSignal,
        workingDirectory: host.deps.workingDirectory,
      });
      await host.store().updateScriptWorkflowRun({
        completedAt: Date.now(),
        id: run.id,
        status: "completed",
        ...(childResult.value === undefined ? {} : { result: childResult.value }),
        ...host.ownerFacts(),
      });
      // The run row is the terminal fact and already contains the result. The
      // event is an observation projection: a trigger/temporary lock must not
      // turn an already committed success into workflow_failed.
      try {
        await host.appendEvent(run.id, "workflow_completed", { result: childResult.value });
      } catch (eventError) {
        host.deps.logger?.warn?.("Script workflow completion event failed", {
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
      await host.store().updateScriptWorkflowRun({
        completedAt: Date.now(),
        ...(cancelled ? {} : { failure: serializeError(error) }),
        id: run.id,
        status: cancelled ? "cancelled" : "failed",
        ...host.ownerFacts(),
      });
      await host.appendEvent(
        run.id,
        cancelled ? "workflow_cancelled" : "workflow_failed",
        serializeError(error),
      );
    }
  } finally {
    host.agentCallCounts.delete(run.id);
    host.statsWrites.delete(run.id);
    host.deps.progressAdapter?.forgetRun(run.id);
  }

  const finalRun = (await host.store().getScriptWorkflowRun(run.id)) ?? run;
  const activities = await host.store().listScriptWorkflowActivities({ runId: run.id });
  return {
    response: formatScriptWorkflowRun({ activities, run: finalRun, result: resultValue }),
    runId: run.id,
    // 报自己写过的那个词（见 settleStatus 的声明处）：读回来的行可能被并发改写。
    status: settleStatus,
    traceId: host.deps.traceContext.traceId,
  };
}
