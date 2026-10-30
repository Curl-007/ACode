// ============================================================
// Script Workflow 工具端口：任务快照与等待（自 script-workflow-tool-port.ts 行数拆分）
// ============================================================
// 拆出依据：原文件 556 行超过 400 行门禁（同时负有 1 条 max-lines disable 头注之债）。
// 按「读面 / 起面」拆成两叶：本叶承载 getTask / waitForTask 的全部逻辑（durable 结果读取、
// 逻辑状态映射、失败消息），另一叶（tool-port-launch.ts）承载来源解析与脚本持久化。
// 两叶共用 `ScriptWorkflowToolPortDeps`，声明在本叶（launch 叶单向 import 本叶）。
// 原文件降为工厂（start/cancel/getTask/waitForTask 的装配）：叶子不反向 import 原文件。

import {
  type FileSystemPort,
  type Logger,
  type SessionId,
  type SessionStorePort,
  type ScriptWorkflowRunRecord,
  type TraceContext,
  type WorkflowTaskSnapshot,
  type WorkflowTaskStatus,
} from "@acode/contracts";
import { isScriptWorkflowStore } from "./script-workflow-utils.js";
import { formatScriptWorkflowRun } from "./script-workflow-format.js";
import type { ScriptWorkflowRuntime } from "./script-workflow-runtime.js";
import {
  logicalScriptWorkflowStatus,
  type ScriptWorkflowLogicalStatus,
} from "./script-workflow-run-status.js";

/** 工具端口的依赖包：文件系统、runtime、会话存储与路径基准。 */
export interface ScriptWorkflowToolPortDeps {
  fileSystemPort: FileSystemPort;
  getRuntime: () => ScriptWorkflowRuntime;
  logger?: Logger;
  remoteSessionId?: string;
  sessionId: SessionId;
  sessionStore: SessionStorePort;
  storageRoot: string;
  traceContext: TraceContext;
  workspaceIdentity?: string;
  workingDirectory: string;
}

/** 从 durable 存储重建一个任务的快照（冷恢复后唯一来源）。 */
export async function getWorkflowTaskSnapshot(
  deps: ScriptWorkflowToolPortDeps,
  taskId: string,
): Promise<WorkflowTaskSnapshot | undefined> {
  if (!isScriptWorkflowStore(deps.sessionStore)) return undefined;
  const run = await deps.sessionStore.getScriptWorkflowRun(taskId);
  if (!run) return undefined;
  // 读**逻辑**状态：物理词 `cancelled` 同时承载「用户停的」与「宿主没了」，后者该报 `lost`
  // （我们再也不知道它怎么样了），前者才是 `cancelled`。判据是 failure 上的结构化 code，
  // 解码只有 script-workflow-run-status.ts 一处。
  const logicalStatus = logicalScriptWorkflowStatus(run);
  const status = workflowTaskStatus(logicalStatus);
  const output = await durableWorkflowOutput(deps, run, logicalStatus);
  return {
    completedAt: run.completedAt ? new Date(run.completedAt) : undefined,
    description: run.name,
    error: failureMessage(run.failure),
    name: run.name,
    output:
      // `lost` 也在列：孤儿收敛之后行的状态是 `interrupted` → 映射成 `lost`，
      // 而「我们把它丢了」本身就是一个确定的结局，TaskOutput 该给一句准话而不是空手而归
      // （否则模型会以为还在跑、继续等一个永不到来的结果）。
      status === "completed" || status === "failed" || status === "cancelled" || status === "lost"
        ? {
            backgroundTaskId: run.id,
            name: run.name,
            response: output ?? `Workflow ${status}: ${run.id}`,
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

/**
 * `workflow_completed.result` 已经是 durable 事件事实；读取端必须和实时 completion 使用同一
 * formatter，否则完成后/冷恢复的 TaskOutput 会退化成状态摘要。缺少旧事件时保留摘要回退，
 * 但不伪造一个空结果。
 */
async function durableWorkflowOutput(
  deps: ScriptWorkflowToolPortDeps,
  run: ScriptWorkflowRunRecord,
  status: ScriptWorkflowLogicalStatus,
): Promise<string | undefined> {
  if (status !== "completed" || !isScriptWorkflowStore(deps.sessionStore)) return undefined;
  try {
    const [activities, events] = await Promise.all([
      deps.sessionStore.listScriptWorkflowActivities({ runId: run.id }),
      deps.sessionStore.listScriptWorkflowEvents({ runId: run.id }),
    ]);
    const event = [...events].reverse().find((entry) => entry.type === "workflow_completed");
    const payload = event?.payload;
    const result =
      payload && typeof payload === "object" && "result" in payload
        ? (payload as { result?: unknown }).result
        : undefined;
    return formatScriptWorkflowRun({ activities, result, run });
  } catch (error) {
    deps.logger?.warn?.("Script workflow durable result read failed", {
      error: error instanceof Error ? error.message : String(error),
      event: "workflow.tool.result_read_failed",
      module: "bootstrap.workflow",
      runId: run.id,
    });
    return undefined;
  }
}

/** 逻辑状态 → 后台任务词汇表。工厂的实时 completion 快照与冷恢复快照共用同一映射。 */
export function workflowTaskStatus(status: ScriptWorkflowLogicalStatus): WorkflowTaskStatus {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "cancelled") return "cancelled";
  // 宿主进程死了留下的遗物：不是脚本失败、也不是用户取消，而是「我们再也不知道它怎么样了」。
  // `lost` 正是这个词在后台任务词汇表里的既有含义，不是兜底凑数。
  if (status === "interrupted") return "lost";
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

/** 等待结算，但尊重调用方的 signal（等待被打断不等于 run 被取消）。 */
export function waitForWorkflowTaskCompletion(
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
