// ============================================================
// Script Workflow 工具端口：来源解析与启动响应（自 script-workflow-tool-port.ts 行数拆分）
// ============================================================
// 拆出依据：原文件 556 行超过 400 行门禁（同时负有 1 条 max-lines disable 头注之债）。
// 按「读面 / 起面」拆成两叶：本叶承载 start() 之前的全部来源解析——四种来源的优先级裁决、
// 脚本持久化、路径校验、内建允许名单与启动回话；读面（快照/等待）在 tool-port-snapshot.ts。
// 依赖方向：tool-port-snapshot（deps 类型）← 本叶，单向；叶子不反向 import 原文件。

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  createCoreError,
  CoreErrorType,
  isFileSystemPortError,
  type FileSystemPort,
  type SessionId,
  type TraceContext,
  type WorkflowOutput,
  type WorkflowStartRequest,
} from "@acode/contracts";
import {
  assertScriptWorkflowResumeOwner,
  type ScriptWorkflowOwnerContext,
} from "@acode/workflow-run-command/contract";
import { readWorkflowScriptDocument } from "./script-workflow-meta.js";
import type { ScriptWorkflowRuntime } from "./script-workflow-runtime.js";
import { isScriptWorkflowStore } from "./script-workflow-utils.js";
import type { ScriptWorkflowToolPortDeps } from "./tool-port-snapshot.js";

export const WORKFLOW_SCRIPT_SUFFIX = ".workflow.js";
export const WORKFLOW_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;
export const BUILTIN_WORKFLOW_ALLOWLIST = new Map<string, string>();

/** start() 解析出的脚本来源：名字（可选）+ 持久化后的脚本路径（可选，resume 有名字无路径亦可）。 */
export interface ResolvedWorkflowSource {
  name?: string;
  scriptPath?: string;
}

export async function resolveWorkflowToolSource(
  deps: ScriptWorkflowToolPortDeps,
  request: WorkflowStartRequest,
  signal?: AbortSignal,
  owner?: ScriptWorkflowOwnerContext,
): Promise<ResolvedWorkflowSource> {
  // `resumeFromRunId` is an owner-bound read.  Resolve it before looking at any
  // competing source field so a direct port caller cannot smuggle a foreign run
  // through the scriptPath/script/name precedence rule.  The schema rejects this
  // combination for normal tool calls; keep the runtime check here as the
  // fail-closed boundary for callers that bypass schema validation.
  if (request.resumeFromRunId) {
    const resumed = await findResumeSource(
      deps,
      request.resumeFromRunId,
      owner ?? {
        parentSessionId: deps.sessionId,
        remoteSessionId: deps.remoteSessionId,
        workspaceIdentity: deps.workspaceIdentity,
        workspacePath: deps.workingDirectory,
      },
    );
    if (request.scriptPath || request.script || request.name) {
      throw new Error(
        "RunWorkflow cannot combine resumeFromRunId with scriptPath, script, or name; resume the existing run by id alone.",
      );
    }
    return resumed;
  }

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
  owner: ScriptWorkflowOwnerContext,
): Promise<ResolvedWorkflowSource> {
  if (!isScriptWorkflowStore(deps.sessionStore)) {
    throw new Error("Script workflow store is not available for this session store.");
  }
  const run = await deps.sessionStore.getScriptWorkflowRun(runId);
  if (!run) throw new Error(`Workflow run not found: ${runId}`);
  await assertScriptWorkflowResumeOwner(deps, run, owner);
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

function safeId(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, "_");
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
export function runWorkflowLaunchResponse(runId: string, scriptPath: string | undefined): string {
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

export function workflowOutputFromRunResult(
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
