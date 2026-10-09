import { SessionEventType, traceContextToLogContext } from "../deps.js";
import type { SessionEvent } from "../deps.js";
import type { RuntimeCommand } from "../command-queue.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { createTurnCancelledError } from "../helpers/turn-errors.js";

export function assertRuntimeModelBranchCurrent(
  runtime: AgentRuntimeInternal,
  expectedGeneration: number | undefined,
): void {
  if (expectedGeneration === undefined || expectedGeneration === runtime.branchGeneration) return;
  runtime.logger?.info("Dropped stale-branch model request", {
    branchGeneration: expectedGeneration,
    currentBranchGeneration: runtime.branchGeneration,
    event: "runtime.model_request.stale_branch_dropped",
    module: "core.runtime",
  });
  throw createTurnCancelledError(new Error("Runtime branch changed before model invocation"));
}

export function isStaleBranchRuntimeCommand(
  runtime: AgentRuntimeInternal,
  command: RuntimeCommand,
): boolean {
  if (
    command.mode !== "task-notification" &&
    command.mode !== "subagent-message" &&
    command.mode !== "control-only-turn"
  ) {
    return false;
  }
  if (command.branchGeneration === runtime.branchGeneration) return false;
  // rewind 与后台 completion 存在竞态；命令即使已入队，也必须在持久化和
  // provider 注入前再次校验 generation，旧分支结果只留诊断日志。
  //
  // 约定（specs/command-terminal-state-audit.md §C）：这里丢弃的是**通知注入**，不是终态。
  // 任务自身的终态仍在 runtime task registry 的快照里，waitForTerminal 不做 branch fencing，
  // 等待方照常拿到终态。所以「丢弃」不等于「终态丢失」。
  //
  // 日志级别用 info 而不是 debug：这是一次队列丢弃，而 CLI 侧把「队列积压和队列丢弃」
  // 明列为必须可观测的面；debug 生产不落盘，等于这条丢弃在生产不可见。频率上它是
  // 每条被丢命令一行，不会成突发。
  runtime.logger?.info("Dropped queued stale-branch runtime command", {
    ...traceContextToLogContext(command.traceContext),
    branchGeneration: command.branchGeneration,
    commandId: command.id,
    currentBranchGeneration: runtime.branchGeneration,
    event: "runtime.command.stale_branch_dropped",
    mode: command.mode,
    module: "core.runtime",
  });
  return true;
}

export function isStaleBranchRuntimeTaskEvent(
  runtime: AgentRuntimeInternal,
  event: SessionEvent,
): boolean {
  if (
    event.type !== SessionEventType.BackgroundTaskUpdated &&
    event.type !== SessionEventType.BackgroundTaskCompleted &&
    event.type !== SessionEventType.SubagentMessage &&
    event.type !== SessionEventType.SubagentStopped
  ) {
    return false;
  }
  const payload =
    event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
      ? (event.payload as Record<string, unknown>)
      : {};
  const taskId =
    typeof payload.taskId === "string"
      ? payload.taskId
      : typeof payload.agentId === "string"
        ? payload.agentId
        : undefined;
  if (!taskId) return false;
  const task = runtime.runtimeTaskRegistry.get(taskId);
  if (!task || task.branchGeneration === runtime.branchGeneration) return false;
  // 姊妹路径，但与上面的命令丢弃**刻意不同级**：这里按事件粒度触发（一个 stale-branch 任务
  // 可以连着产出多条 BackgroundTaskUpdated / SubagentMessage），提到 info 会在 rewind 后
  // 造成日志突发。命令丢弃是一条命令一行、且属于必须可观测的「队列丢弃」面，所以那边是 info。
  // 终态可观察性不依赖这条日志：本函数只读 registry.get(taskId)，不改快照。
  runtime.logger?.debug("Dropped stale-branch runtime task event", {
    branchGeneration: task.branchGeneration,
    currentBranchGeneration: runtime.branchGeneration,
    event: "runtime.task_event.stale_branch_dropped",
    eventType: event.type,
    module: "core.runtime",
    taskId,
  });
  return true;
}
