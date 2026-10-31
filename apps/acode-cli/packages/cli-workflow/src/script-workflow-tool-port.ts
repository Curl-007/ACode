// ============================================================
// Script Workflow 工具端口：工厂（WorkflowPort 唯一实现）
// ============================================================
// 行数拆分（原 556 行超过 400 行门禁，并带有 1 条 max-lines 的 lint disable 头注，已随拆分删除）：
// 按「读面 / 起面」拆成两个叶子——
//   - tool-port-snapshot.ts：getTask / waitForTask 的全部逻辑（durable 结果读取、逻辑状态映射、
//     失败消息、等待）与 `ScriptWorkflowToolPortDeps`；
//   - tool-port-launch.ts：start() 之前的来源解析（四种来源的优先级裁决、脚本持久化、路径校验、
//     内建允许名单、启动回话与输出投影）。
// 本文件降为工厂本身：`createScriptWorkflowToolPort` 装配 cancel / getTask / waitForTask / start
// 四个方法并持有三张运行态表（completionSnapshots / launchSnapshots / runAbortControllers）——
// resume 并发守卫与 cancel 通道必须与这三张表同住，拆不得。
// 依赖方向：叶子 ← 本文件，叶子不反向 import 本文件。对外导出不变：只有工厂。
//
// resume 前的并发守卫判据必须复用 completionSnapshots（run promise 未结算即在飞），
// 不另立第二份运行态（测试钉住了源码形状）。

import {
  WORKFLOW_RUN_ID_PATTERN,
  createCoreError,
  CoreErrorType,
  type WorkflowOutput,
  type WorkflowPort,
  type WorkflowTaskSnapshot,
} from "@acode/contracts";
import {
  resolveWorkflowToolSource,
  runWorkflowLaunchResponse,
  workflowOutputFromRunResult,
} from "./tool-port-launch.js";
import {
  getWorkflowTaskSnapshot,
  waitForWorkflowTaskCompletion,
  workflowTaskStatus,
  type ScriptWorkflowToolPortDeps,
} from "./tool-port-snapshot.js";

export function createScriptWorkflowToolPort(deps: ScriptWorkflowToolPortDeps): WorkflowPort {
  const completionSnapshots = new Map<string, Promise<WorkflowTaskSnapshot | undefined>>();
  const launchSnapshots = new Map<string, WorkflowTaskSnapshot>();
  /**
   * 在飞 run 的中止句柄。`start` 刻意让 run 脱离发起它的 turn（见下面的注释），
   * 于是这张表是**唯一**能碰到那个 run 的通道——`cancel` 读它，run 结算时清它。
   */
  const runAbortControllers = new Map<string, AbortController>();
  return {
    async cancel(taskId): Promise<boolean> {
      const controller = runAbortControllers.get(taskId);
      if (controller === undefined) return false;
      controller.abort();
      // 不在这里删表项：run 结算路径的 finally 会删。删两次无害，但让「谁负责清理」
      // 只有一个答案比省一次 Map.delete 更重要。
      return true;
    },
    async getTask(taskId): Promise<WorkflowTaskSnapshot | undefined> {
      return (await getWorkflowTaskSnapshot(deps, taskId)) ?? launchSnapshots.get(taskId);
    },
    async waitForTask(taskId, options): Promise<WorkflowTaskSnapshot | undefined> {
      const current = (await getWorkflowTaskSnapshot(deps, taskId)) ?? launchSnapshots.get(taskId);
      if (!current || current.status !== "running") return current;
      const completion = completionSnapshots.get(taskId);
      if (!completion) return current;
      return waitForWorkflowTaskCompletion(completion, options?.signal);
    },
    async start(request, options): Promise<WorkflowOutput> {
      if (options?.signal?.aborted) {
        throw createCoreError(CoreErrorType.ToolCancelled, "Workflow launch cancelled");
      }
      const source = await resolveWorkflowToolSource(deps, request, options?.signal, {
        parentSessionId: request.sessionId,
        remoteSessionId: request.remoteSessionId ?? deps.remoteSessionId,
        workspaceIdentity: request.workspaceIdentity ?? deps.workspaceIdentity,
        workspacePath: request.workspaceRoot || deps.workingDirectory,
      });
      if (options?.signal?.aborted) {
        throw createCoreError(CoreErrorType.ToolCancelled, "Workflow launch cancelled");
      }
      const runId = request.resumeFromRunId ?? `wf_${crypto.randomUUID()}`;
      if (!WORKFLOW_RUN_ID_PATTERN.test(runId)) {
        throw new Error(`Invalid workflow run id: ${runId}`);
      }
      // resume 前的并发守卫。同一个 runId 上一次的 run 还没结算就再起一份，两份 agent 会写
      // 同一批 activity 行、抢同一组缓存键，于是 resume 赖以成立的「(prompt, opts) 未变即命中」
      // 不再可信——命中的可能是另一份 run 刚写下的结果。fail-loud 而不是排队或静默接管：
      // 只有调用方能决定是等还是停。
      // 判据复用 completionSnapshots（run promise 未结算即在飞），不另立第二份运行态。
      if (completionSnapshots.has(runId)) {
        throw new Error(
          `Workflow run ${runId} has not exited yet. Stop it with TaskStop, or wait for it to finish, before resuming — two live copies would write the same journal and corrupt the resume cache.`,
        );
      }
      const startedAt = new Date();
      launchSnapshots.set(runId, {
        description: source.name ?? runId,
        name: source.name,
        runId,
        startedAt,
        status: "running",
        taskId: runId,
      });

      const runtime = deps.getRuntime();
      // 后台 workflow 已脱离当前 tool call；父 turn 取消不应中止已返回 runId 的任务。
      // 代价是必须有另一条中止通道，否则没有任何东西能停掉它——那条通道就是 cancel()
      // 与下面这张表。
      const runAbortController = new AbortController();
      runAbortControllers.set(runId, runAbortController);
      const runPromise = source.scriptPath
        ? runtime.run(
            {
              args: request.args,
              resumeFromRunId: request.resumeFromRunId,
              runId,
              scriptPath: source.scriptPath,
              // 投影靠它把 run 卡联接到聊天里发起它的那一行。缺席只是少一个联接，
              // run 照跑、进度照进投影。
              ...(request.parentToolCallId === undefined
                ? {}
                : { toolCallId: String(request.parentToolCallId) }),
            },
            { abortSignal: runAbortController.signal },
          )
        : runtime.resume({ runId }, { abortSignal: runAbortController.signal });

      const completion = runPromise.then(
        (result) => {
          const snapshot: WorkflowTaskSnapshot = {
            completedAt: new Date(),
            description: source.name ?? result.runId,
            name: source.name,
            output: workflowOutputFromRunResult(result, source, deps.traceContext.traceId),
            runId,
            startedAt,
            status: workflowTaskStatus(result.status),
            taskId: runId,
          };
          launchSnapshots.set(runId, snapshot);
          return snapshot;
        },
        (error: unknown) => {
          const snapshot: WorkflowTaskSnapshot = {
            completedAt: new Date(),
            description: source.name ?? runId,
            error: toError(error).message,
            name: source.name,
            runId,
            startedAt,
            status: "failed",
            taskId: runId,
          };
          launchSnapshots.set(runId, snapshot);
          deps.logger?.error(
            "Background workflow failed before status was persisted",
            toError(error),
            {
              event: "workflow.tool.background_failed",
              module: "bootstrap.workflow",
              runId,
              status: "failed",
            },
          );
          return snapshot;
        },
      );
      completionSnapshots.set(
        runId,
        completion.finally(() => {
          completionSnapshots.delete(runId);
          runAbortControllers.delete(runId);
        }),
      );
      void completion;

      return {
        backgroundTaskId: runId,
        name: source.name,
        response: runWorkflowLaunchResponse(runId, source.scriptPath),
        runId,
        scriptPath: source.scriptPath,
        status: "backgrounded",
        traceId: request.trace.traceId,
      };
    },
  };
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
