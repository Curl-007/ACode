// ============================================================
// Workflow Port - background workflow launch boundary
// ============================================================

import type { WorkflowInput, WorkflowOutput } from "../tools/workflow.js";
import type { SessionId, ToolCallId, TurnId } from "./shared.js";
import type { TraceContext } from "../tracing/tracer.js";

export interface WorkflowStartRequest extends WorkflowInput {
  parentToolCallId: ToolCallId | string;
  sessionId: SessionId;
  trace: TraceContext;
  turnId?: TurnId;
  workingDirectory: string;
  workspaceRoot: string;
}

export interface WorkflowStartOptions {
  signal?: AbortSignal;
}

export type WorkflowTaskStatus = "running" | "completed" | "failed" | "cancelled" | "lost";

export interface WorkflowTaskSnapshot {
  completedAt?: Date;
  description?: string;
  error?: string;
  name?: string;
  output?: WorkflowOutput;
  runId: string;
  startedAt: Date;
  status: WorkflowTaskStatus;
  taskId: string;
}

export interface WorkflowPort {
  start(request: WorkflowStartRequest, options?: WorkflowStartOptions): Promise<WorkflowOutput>;
  getTask?(taskId: string): Promise<WorkflowTaskSnapshot | undefined>;
  waitForTask?(
    taskId: string,
    options?: { signal?: AbortSignal },
  ): Promise<WorkflowTaskSnapshot | undefined>;
  /**
   * 中止一个在飞的 run。可选：缺席即 `cancellable: false`，TaskStop 会如实告诉模型停不了。
   *
   * 为什么必须有它：`start` 一旦返回 `backgrounded`，run 就刻意脱离了发起它的那个 turn
   * （父 turn 取消不该连带杀掉已经交出去的任务），于是**再没有别的通道能碰到它的
   * AbortController**。而工具契约明文要求「resume 前先 TaskStop 掉上一个 run」——
   * 没有这个方法，那句话就是假的，模型会以为停掉了、然后与仍在飞的 run 一起写同一份
   * journal。实现方持有 runId → AbortController 的映射即可，不需要新状态。
   */
  cancel?(taskId: string): Promise<boolean>;
}
