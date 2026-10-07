// ============================================================
// 脚本工作流 run 的后台停止分支（runtime.stopBackgroundTask 的 local_workflow 分派）
// ============================================================
//
// 与 background-stop-dynamic-workflow.ts 是**并列**的两支，不是同一支：两套工作流系统各有
// 自己的端口（WorkflowPort vs DynamicWorkflowRunPort）、自己的存储与自己的终态词。
// 共用的是入口——GUI 的 v4 `cancelBackgroundWork {workId}` 与模型的 `TaskStop` 都汇到
// `runtime.stopBackgroundTask`，只在 strict 上不同。
//
// 为什么必须单独成一支：`stopBackgroundTask` 的分派是**显式列举** taskType 的，列举之外一律
// 落进兜底的 `unsupportedBackgroundStopResult`。`local_workflow`（脚本工作流的任务类型）
// 此前不在列举里，于是端口上明明有 `cancel`、`background-tasks.ts` 也照实把 `cancellable`
// 报成 true，TaskStop 却回答 "cannot be stopped"（reason = background_task_cancel_not_supported）。
// 报得出能力、走不到能力——这是比「诚实地报 false」更坏的一种不一致。
//
// 单独成模块同样是为了限制 background.ts 的规模：那边只加一个 import 与一行分派。

import type { AgentRuntimeInternal } from "../internal.js";
import type {
  RuntimeBackgroundStopResult,
  TypedRuntimeBackgroundStopTarget,
} from "./background-stop-types.js";

/**
 * 停止一个脚本工作流 run：taskId ≡ runId，直接交给 `WorkflowPort.cancel`。
 *
 * 端口内部 abort 它按 runId 登记的那个 AbortController（`script-workflow-tool-port.ts` 的
 * `runAbortControllers`），子进程被 kill，runtime 的 catch 按 run 级 signal 已 aborted 判定为
 * 用户取消：存储写 `cancelled`、发 `workflow_cancelled`，适配器再翻成 dwf 的
 * `run-settled { status: "stopped", stopReason: "user" }`——**不是** `errored`。
 * 那条链的语义与理由见 specs/script-workflow-revival.md R12。
 *
 * 与 dwf 那一支的两点刻意差别：
 *   - 不写 `stopInitiator` 到 registry。dwf 需要它是因为终态通知与 AmendWorkflow 的免确认
 *     规则要读「是谁停的」；脚本工作流没有 amend 面，而它的终态词已经由 cancelled 承载。
 *   - `cancel` 不接受 initiator 入参（契约就是 `(taskId) => Promise<boolean>`）。
 *
 * 两种降级都返回结构化结果而不是假装成功：端口整个缺席或未实现 cancel → 能力不支持；
 * 端口对未知/已结算的 run 回 false → not_found。
 */
export async function stopScriptWorkflowBackgroundTask(
  this: AgentRuntimeInternal,
  target: TypedRuntimeBackgroundStopTarget,
  unsupported: (target: TypedRuntimeBackgroundStopTarget) => RuntimeBackgroundStopResult,
): Promise<RuntimeBackgroundStopResult> {
  const port = this.workflowPort;
  // cancel 是契约上的**可选**方法：宿主没实现时不能答应停得掉。
  if (!port || typeof port.cancel !== "function") {
    return unsupported(target);
  }
  const cancelled = await port.cancel(target.taskId);
  if (!cancelled) {
    return {
      ok: false,
      reason: "background_task_not_found",
      status: "lost",
      taskId: target.taskId,
      type: "local_workflow",
    };
  }
  return {
    ok: true,
    status: "cancelled",
    taskId: target.taskId,
    type: "local_workflow",
  };
}
