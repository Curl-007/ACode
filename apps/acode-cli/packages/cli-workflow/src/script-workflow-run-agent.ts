// ============================================================
// ScriptWorkflowRuntime：run 内的 agent 派生（子请求分发 / agent 调用 / live 执行）
// ============================================================
// script-workflow-runtime.ts 偿还 W1-R3 max-lines 例外：把子进程的三类回调处理（agent 请求分发、
// 事件转发）与 agent 的完整生命周期（限额与缓存 → activity 落库 → live 执行：worktree 隔离、
// 子会话、用量结算、任务联接、终态裁决）拆到本文件。run() 主体（script-workflow-run-body.ts）
// 在发起子进程时把这里的两个处理函数作为回调递下去。
//
// 对 runtime 状态的全部触碰经 {@link ScriptWorkflowRunHost}（run-body 定义、主类构造）递进来；
// 统计入账经 script-workflow-stats.ts 的函数（同一宿主对象）。原方法体逐字保留。
//
// 依赖方向（无运行时环）：run-body → 本文件（函数），本文件 → run-body（仅类型）、→ stats（函数）。
// 公开面：主类不再暴露这些私有方法；调用方（run-body）按函数引用。
//
// MAX_WORKFLOW_AGENT_CALLS：上限按 run 计，不按 runtime 实例计（理由见主类 agentCallCounts 字段注释）。

import {
  WorkflowAgentCallInputSchema,
  createChildTraceContext,
  createSessionId,
  type ScriptWorkflowActivityRecord,
  type ScriptWorkflowRunRecord,
  type ScriptWorkflowRunStats,
  type WorkflowAgentCallInput,
} from "@acode/contracts";
import { createScriptWorkflowAgentRuntime } from "./script-workflow-child-runtime.js";
import { stableHash } from "./script-workflow-meta.js";
import type { ScriptWorkflowChildRequest } from "./script-workflow-process.js";
import {
  addRunStatsForActivity,
  collectSessionStats,
  markUsageIncomplete,
} from "./script-workflow-stats.js";
import type {
  ScriptWorkflowRunHost,
  ScriptWorkflowRunOptions,
} from "./script-workflow-runtime-deps.js";
import {
  assertWorkflowOutputSchema,
  buildAgentPrompt,
  isRecord,
  mergedSignal,
  parseStructuredResponse,
  serializeError,
} from "./script-workflow-utils.js";
import type {
  WorkflowWorktreeHandle,
  WorkflowWorktreeReleaseResult,
} from "./workflow-worktree-manager.js";

const MAX_WORKFLOW_AGENT_CALLS = 1000;

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

/** 子进程的一条请求分发（原 handleChildRequest 方法体）。 */
export async function handleChildRunRequest(
  host: ScriptWorkflowRunHost,
  run: ScriptWorkflowRunRecord,
  request: ScriptWorkflowChildRequest,
  options?: ScriptWorkflowRunOptions,
): Promise<unknown> {
  if (request.type === "agent") {
    return runWorkflowAgent(host, run, WorkflowAgentCallInputSchema.parse(request.payload), options);
  }
  if (request.type === "workflow") {
    throw new Error("Nested workflow() is reserved for a later workflow runtime version.");
  }
  throw new Error(`Unknown workflow child request: ${request.type}`);
}

/** 子进程的一条事件转发（原 handleChildEvent 方法体）。 */
export async function handleChildRunEvent(
  host: ScriptWorkflowRunHost,
  runId: string,
  type: string,
  payload: unknown,
): Promise<void> {
  if (type === "phase" && isRecord(payload) && typeof payload.title === "string") {
    await host.store().updateScriptWorkflowRun({
      currentPhase: payload.title,
      id: runId,
      ...host.ownerFacts(),
    });
  }
  await host.appendEvent(runId, `script_${type}`, payload);
}

/**
 * 一次 `agent()` 调用（原 runAgent 方法体）：限额 → 缓存命中 → activity 落库 → 经并发闸门进 live 执行。
 */
async function runWorkflowAgent(
  host: ScriptWorkflowRunHost,
  run: ScriptWorkflowRunRecord,
  input: WorkflowAgentCallInput,
  options?: ScriptWorkflowRunOptions,
): Promise<unknown> {
  if (input.opts?.schema) assertWorkflowOutputSchema(input.opts.schema);
  // 上限按 run 计，不按 runtime 实例计（字段注释里记了为什么）。
  const used = host.agentCallCounts.get(run.id) ?? 0;
  if (used >= MAX_WORKFLOW_AGENT_CALLS) {
    throw new Error(`Workflow agent call limit exceeded: ${MAX_WORKFLOW_AGENT_CALLS}`);
  }
  const callIndex = used + 1;
  host.agentCallCounts.set(run.id, callIndex);
  const callPath = input.callPath ?? `root/agent${callIndex}`;
  const phase = input.opts?.phase ?? input.phase;
  const inputHash = stableHash({ opts: input.opts, phase, prompt: input.prompt });
  const cached = await host.store().findCachedScriptWorkflowActivity({
    callPath,
    inputHash,
    runId: run.id,
  });
  if (cached?.result) {
    // 事件载荷带上投影所需的事实（callPath / label / phase）。原来只有 activityId，
    // 而进度适配器要据此构造 dwf 投影的 instance/actor 引用（`{siteId, ordinal}`）与
    // 子代理显示名——按 id 回查 store 是每条事件一次异步读，既有开销又有竞态。
    // 追加键对既有消费者无害（它们只读 activityId）。
    await host.appendEvent(run.id, "activity_cached", {
      activityId: cached.id,
      callPath,
      label: input.opts?.label,
      phase,
    });
    // The child runner unwraps result.value while reading stats from the envelope.
    return cached.result;
  }

  const activity = await host.store().createScriptWorkflowActivity({
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
  return host.limiter.run(() => runLiveWorkflowAgent(host, run, activity, input, options));
}

/**
 * 一次 agent activity 的 live 执行（原 runLiveAgent 方法体）：worktree 隔离、子 runtime、
// 用量结算、任务联接与终态裁决。
 */
async function runLiveWorkflowAgent(
  host: ScriptWorkflowRunHost,
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
  const childTraceContext = createChildTraceContext(host.deps.traceContext, {
    attributes: {
      parentSessionId: host.deps.sessionId,
      workflowActivityId: activity.id,
      workflowRunId: run.id,
    },
    sessionId: childSessionId,
  });
  const agentPrompt = buildAgentPrompt(input);

  let unsubscribe: (() => void) | undefined;
  try {
    if (input.opts?.isolation === "worktree") {
      worktree = await host.worktrees().ensureWorktree({
        activityId: activity.id,
        label: input.opts.label,
        repoDir: host.deps.workingDirectory,
        runId: run.id,
      });
    }
    const childRuntime = (host.deps.createAgentRuntime ?? createScriptWorkflowAgentRuntime)({
      childSessionId,
      deps: host.deps,
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
    await host.store().updateScriptWorkflowActivity({
      childSessionId,
      id: activity.id,
      startedAt,
      status: "running",
    });
    await host.appendEvent(run.id, "activity_started", {
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
    const stats = await collectSessionStats(host.deps, childSessionId);
    measuredStats = stats;
    const value = input.opts?.schema
      ? parseStructuredResponse(result.response, input.opts.schema)
      : result.response;
    // R5：成功路径在写 completed 记录**之前**完成回收裁决——result 信封要带 kept 信息。
    if (worktree) {
      worktreeRelease = await host.worktrees().releaseWorktree(worktree);
    }
    const activityResult = {
      response: result.response,
      stats,
      traceId: result.traceId,
      turnId: result.turnId,
      value,
      ...(worktree ? { worktree: buildWorktreeRecord(worktree, worktreeRelease) } : {}),
    };
    await host.store().updateScriptWorkflowActivity({
      completedAt: Date.now(),
      id: activity.id,
      result: activityResult,
      status: "completed",
    });
    activityFinalized = true;
    // activity 进入 completed 后立即把 child 已持久化的用量并入 run；后续的 task-link 或
    // 观察事件属于派生面，失败时不能让这笔真实用量丢失或在 catch 中重复计数。
    try {
      await addRunStatsForActivity(host, run.id, stats, activity.id);
      usageSettled = true;
    } catch (statsError) {
      // 已完成的 activity 不能因为统计写入失败而改判为 failed。事务按 activityId 幂等，
      // 因此即使 commit 已成功而响应丢失，重试一次也不会重复累计。
      try {
        await addRunStatsForActivity(host, run.id, stats, activity.id);
        usageSettled = true;
      } catch (retryError) {
        await markUsageIncomplete(host, run.id, activity.id, activityResult, retryError);
        usageSettled = true;
        host.deps.logger?.warn?.("Script workflow usage accounting incomplete", {
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
    await host.store().createSessionTaskLink({
      activityId: activity.id,
      agentType: input.opts?.agentType,
      childSessionId,
      id: `tasklink_${crypto.randomUUID()}`,
      label: input.opts?.label,
      model: childSelection
        ? `${childSelection.providerId}/${childSelection.modelId}`
        : undefined,
      parentSessionId: host.deps.sessionId,
      path: activity.callPath,
      phase: activity.phase,
      role: "workflow_agent",
      rootWorkflowRunId: run.id,
      status: "completed",
    });
    await host.appendEvent(run.id, "activity_completed", {
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
      worktreeRelease = await host.worktrees().releaseWorktree(worktree);
    }
    // 终态 activity 只允许写一次。结果解析失败、usage 投影失败或尾部事件落盘失败都可能
    // 在 completed 写入之后抛错；这些错误不能把已完成的 activity 改成 failed，也不能再次
    // 计作一笔 agent。否则 durable stats 与活动终态会相互矛盾。
    const needsFailureEvent = !activityFinalized;
    if (needsFailureEvent) {
      await host.store().updateScriptWorkflowActivity({
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
        measuredStats ??= await collectSessionStats(host.deps, childSessionId);
        await addRunStatsForActivity(
          host,
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
        await markUsageIncomplete(
          host,
          run.id,
          activity.id,
          worktree ? { worktree: buildWorktreeRecord(worktree, worktreeRelease) } : undefined,
          statsError,
        );
        host.deps.logger?.warn?.("Script workflow usage accounting incomplete", {
          error: statsError instanceof Error ? statsError.message : String(statsError),
          event: "workflow.usage.accounting_incomplete",
          module: "bootstrap.workflow",
          runId: run.id,
          activityId: activity.id,
        });
      }
    }
    if (needsFailureEvent) {
      await host.appendEvent(run.id, "activity_failed", {
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
      await host.worktrees()
        .releaseWorktree(worktree)
        .catch(() => undefined);
    }
  }
}
