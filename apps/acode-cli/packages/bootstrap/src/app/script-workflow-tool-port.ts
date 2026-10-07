import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  WORKFLOW_RUN_ID_PATTERN,
  createCoreError,
  CoreErrorType,
  isFileSystemPortError,
  type FileSystemPort,
  type Logger,
  type ScriptWorkflowRunStatus,
  type SessionId,
  type SessionStorePort,
  type TraceContext,
  type WorkflowOutput,
  type WorkflowPort,
  type WorkflowStartRequest,
  type WorkflowTaskSnapshot,
  type WorkflowTaskStatus,
} from "@acode/contracts";
import { readWorkflowScriptDocument } from "./script-workflow-meta.js";
import type { ScriptWorkflowRuntime } from "./script-workflow-runtime.js";
import { isScriptWorkflowStore } from "./script-workflow-utils.js";

const WORKFLOW_SCRIPT_SUFFIX = ".workflow.js";
const WORKFLOW_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;
const BUILTIN_WORKFLOW_ALLOWLIST = new Map<string, string>();

interface ScriptWorkflowToolPortDeps {
  fileSystemPort: FileSystemPort;
  getRuntime: () => ScriptWorkflowRuntime;
  logger?: Logger;
  sessionId: SessionId;
  sessionStore: SessionStorePort;
  storageRoot: string;
  traceContext: TraceContext;
  workingDirectory: string;
}

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
      const source = await resolveWorkflowToolSource(deps, request, options?.signal);
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
          deps.logger?.error("Background workflow failed before status was persisted", toError(error), {
            event: "workflow.tool.background_failed",
            module: "bootstrap.workflow",
            runId,
            status: "failed",
          });
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

/**
 * 启动成功回给模型的那句话。
 *
 * 它必须只点名**真实存在**的通道：原文写的是 "Use /workflows <runId> to watch progress"，
 * 而 ACode 没有 `/workflows` 命令（dwf 那边是 `/dwf list`，且它列的是 dwf 的 run，
 * 前缀 dwfrun_ 而不是 wf_）。让模型去用一个不存在的命令，它会要么编一个、要么反复重试，
 * 两种都比直说「等通知」更贵。
 *
 * 三条通道都是接好的：完成通知走 backgroundSource:"workflow"，TaskOutput 走端口的
 * getTask/waitForTask，TaskStop 走新加的 cancel()。
 */
function runWorkflowLaunchResponse(runId: string, scriptPath: string | undefined): string {
  const lines = [
    `Workflow started in the background as ${runId}. It is still running — you will be notified with the final result when it completes, so do not poll it.`,
    `To block until it finishes use TaskOutput with taskId ${runId}; to stop it use TaskStop with the same id.`,
  ];
  if (scriptPath !== undefined) {
    lines.push(
      `The script was saved to ${scriptPath}. To iterate, edit that file and call RunWorkflow again with the same \`scriptPath\` instead of resending the whole script.`,
    );
  }
  return lines.join(" ");
}

function waitForWorkflowTaskCompletion(
  completion: Promise<WorkflowTaskSnapshot | undefined>,
  signal: AbortSignal | undefined,
): Promise<WorkflowTaskSnapshot | undefined> {
  if (!signal) return completion;
  if (signal.aborted) return Promise.reject(workflowAbortReason(signal));

  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = (): void => {
      cleanup();
      reject(workflowAbortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    completion.then(
      (snapshot) => {
        cleanup();
        resolve(snapshot);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function workflowAbortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("Workflow task wait aborted");
}

function workflowOutputFromRunResult(
  result: Awaited<ReturnType<ScriptWorkflowRuntime["run"]>>,
  source: ResolvedWorkflowSource,
  traceId: string,
): WorkflowOutput {
  return {
    backgroundTaskId: result.runId,
    name: source.name,
    response: result.response,
    runId: result.runId,
    scriptPath: source.scriptPath,
    status: result.status === "completed" ? "completed" : "failed",
    traceId,
  };
}

async function getWorkflowTaskSnapshot(
  deps: ScriptWorkflowToolPortDeps,
  taskId: string,
): Promise<WorkflowTaskSnapshot | undefined> {
  if (!isScriptWorkflowStore(deps.sessionStore)) return undefined;
  const run = await deps.sessionStore.getScriptWorkflowRun(taskId);
  if (!run) return undefined;
  const status = workflowTaskStatus(run.status);
  return {
    completedAt: run.completedAt ? new Date(run.completedAt) : undefined,
    description: run.name,
    error: failureMessage(run.failure),
    name: run.name,
    output:
      status === "completed" || status === "failed" || status === "cancelled"
        ? {
            backgroundTaskId: run.id,
            name: run.name,
            response: `Workflow ${status}: ${run.id}`,
            runId: run.id,
            scriptPath: run.scriptPath,
            status: status === "completed" ? "completed" : "failed",
            traceId: deps.traceContext.traceId,
          }
        : undefined,
    runId: run.id,
    startedAt: new Date(run.startedAt ?? run.createdAt),
    status,
    taskId: run.id,
  };
}

interface ResolvedWorkflowSource {
  name?: string;
  scriptPath?: string;
}

async function resolveWorkflowToolSource(
  deps: ScriptWorkflowToolPortDeps,
  request: WorkflowStartRequest,
  signal?: AbortSignal,
): Promise<ResolvedWorkflowSource> {
  if (request.scriptPath) {
    const sourcePath = resolve(request.workingDirectory, request.scriptPath);
    await validateScriptPath(deps.fileSystemPort, sourcePath, request.trace, signal);
    const copiedPath = await persistScriptCopy(deps, request, sourcePath, signal);
    await validateScriptPath(deps.fileSystemPort, copiedPath, request.trace, signal);
    return { scriptPath: copiedPath };
  }

  if (request.script) {
    const scriptPath = await persistInlineScript(deps, request, signal);
    await validateScriptPath(deps.fileSystemPort, scriptPath, request.trace, signal);
    return { scriptPath };
  }

  if (request.name) {
    const sourcePath = await resolveNamedWorkflowPath(deps, request.name, request.trace, signal);
    const copiedPath = await persistScriptCopy(deps, request, sourcePath, signal);
    await validateScriptPath(deps.fileSystemPort, copiedPath, request.trace, signal);
    return { name: request.name, scriptPath: copiedPath };
  }

  if (request.resumeFromRunId) {
    return findResumeSource(deps, request.resumeFromRunId);
  }

  throw new Error("Workflow requires scriptPath, script, name, or resumeFromRunId.");
}

async function persistInlineScript(
  deps: ScriptWorkflowToolPortDeps,
  request: WorkflowStartRequest,
  signal?: AbortSignal,
): Promise<string> {
  const scriptPath = sessionWorkflowScriptPath(deps.storageRoot, deps.sessionId, request);
  await deps.fileSystemPort.writeTextFile(
    {
      atomic: true,
      content: request.script ?? "",
      createParents: true,
      path: scriptPath,
      trace: request.trace,
    },
    { signal },
  );
  return scriptPath;
}

async function persistScriptCopy(
  deps: ScriptWorkflowToolPortDeps,
  request: WorkflowStartRequest,
  sourcePath: string,
  signal?: AbortSignal,
): Promise<string> {
  const script = await deps.fileSystemPort.readTextFile(
    { path: sourcePath, trace: request.trace },
    { signal },
  );
  const scriptPath = sessionWorkflowScriptPath(deps.storageRoot, deps.sessionId, request);
  await deps.fileSystemPort.writeTextFile(
    {
      atomic: true,
      content: script.content,
      createParents: true,
      path: scriptPath,
      trace: request.trace,
    },
    { signal },
  );
  return scriptPath;
}

async function resolveNamedWorkflowPath(
  deps: ScriptWorkflowToolPortDeps,
  name: string,
  trace: TraceContext,
  signal?: AbortSignal,
): Promise<string> {
  const fileName = workflowFileName(name);
  const candidates = [
    join(deps.workingDirectory, ".acode", "workflows", fileName),
    join(homedir(), ".acode", "workflows", fileName),
  ];
  const builtIn = BUILTIN_WORKFLOW_ALLOWLIST.get(name);
  if (builtIn) candidates.push(builtIn);

  for (const candidate of candidates) {
    if (await isReadableFile(deps.fileSystemPort, candidate, trace, signal)) return candidate;
  }
  throw new Error(`Workflow not found: ${name}`);
}

async function findResumeSource(
  deps: ScriptWorkflowToolPortDeps,
  runId: string,
): Promise<ResolvedWorkflowSource> {
  if (!isScriptWorkflowStore(deps.sessionStore)) {
    throw new Error("Script workflow store is not available for this session store.");
  }
  const run = await deps.sessionStore.getScriptWorkflowRun(runId);
  if (!run) throw new Error(`Workflow run not found: ${runId}`);
  if (!run.scriptPath) throw new Error(`Workflow run has no script path: ${runId}`);
  return { name: run.name, scriptPath: run.scriptPath };
}

async function validateScriptPath(
  fileSystemPort: FileSystemPort,
  scriptPath: string,
  traceContext: TraceContext,
  signal?: AbortSignal,
): Promise<void> {
  await readWorkflowScriptDocument({ fileSystemPort, scriptPath, traceContext });
  if (signal?.aborted) {
    throw createCoreError(CoreErrorType.ToolCancelled, "Workflow launch cancelled");
  }
}

async function isReadableFile(
  fileSystemPort: FileSystemPort,
  path: string,
  trace: TraceContext,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    const stat = await fileSystemPort.stat({ path, trace }, { signal });
    return stat.kind === "file";
  } catch (error) {
    if (isFileSystemPortError(error) && error.code === "not_found") return false;
    throw error;
  }
}

function workflowFileName(name: string): string {
  if (!WORKFLOW_NAME_PATTERN.test(name)) {
    throw new Error(`Workflow name must contain only letters, numbers, dot, dash, or underscore.`);
  }
  return name.endsWith(WORKFLOW_SCRIPT_SUFFIX) ? name : `${name}${WORKFLOW_SCRIPT_SUFFIX}`;
}

function workflowTaskStatus(status: ScriptWorkflowRunStatus): WorkflowTaskStatus {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "cancelled") return "cancelled";
  if (status === "pending" || status === "running" || status === "paused") return "running";
  return "lost";
}

function failureMessage(failure: unknown): string | undefined {
  if (!failure) return undefined;
  if (typeof failure === "string") return failure;
  if (typeof failure === "object" && "message" in failure) {
    const message = (failure as { message?: unknown }).message;
    return typeof message === "string" ? message : undefined;
  }
  return String(failure);
}

function sessionWorkflowScriptPath(
  storageRoot: string,
  sessionId: SessionId,
  request: WorkflowStartRequest,
): string {
  const baseName = request.name
    ? workflowFileName(request.name)
    : `${safeId(request.parentToolCallId)}${WORKFLOW_SCRIPT_SUFFIX}`;
  return join(storageRoot, "cli", "sessions", sessionId, "workflows", baseName);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function safeId(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, "_");
}
