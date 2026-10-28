// ============================================================
// Session Event tool payloads - 工具调用与后台任务载荷
// ============================================================
// 例外债务偿还（2026-10-28，batch B）：session.events.ts（1373 行）按主题拆叶，
// 本文件承载工具调用载荷（scheduled/started/progress/result/error/batch）与后台任务载荷。
// ExecutionOutputPreview 来自 interfaces/execution.port.js 叶子（原文件顶部 import）。
// 依赖方向（DAG）：shared.js / execution.port / tools/contract / tools/tool-result-metadata /
// skills/index + support 叶 → 本文件 → session.events.ts 桶。

import type { MessageId, SessionId, ToolCallId } from "../interfaces/shared.js";
import type { ExecutionOutputPreview } from "../interfaces/execution.port.js";
import type { ToolSideEffectScope } from "../tools/contract.js";
import type { ToolResultDisplayPayload } from "../tools/tool-result-metadata.js";
import type { SkillTelemetryMetadata } from "../skills/index.js";
import type { ErrorPayload, ToolResultPayload, ToolSchedulePayload } from "./session-event-support.js";

export interface ToolCallScheduledPayload {
  toolCallId: ToolCallId;
  assistantMessageId?: MessageId;
  toolName: string;
  input: unknown;
  dependencies?: ToolCallId[];
  parallelGroupIndex?: number;
  canRunParallel?: boolean;
  display?: ToolResultDisplayPayload;
  schedule: ToolSchedulePayload;
}

export interface ToolCallStartedPayload {
  toolCallId: ToolCallId;
  toolName?: string;
  startedAt: Date;
  display?: ToolResultDisplayPayload;
  /**
   * 这次调用**解析后**的副作用能力（工具元数据 + 按入参解析的运行时能力，例如 Bash 的只读命令判定）。
   * 事件在 handler 动手之前发出，所以订阅者能在第一个字节落盘前知道「要写了」——dynamic-workflow 的
   * driver 据此关闭 amend-resume 的导入缓存（`isWorkspaceMutatingToolCall`）。可选：早于本字段的事件没有。
   */
  readOnly?: boolean;
  sideEffectScope?: ToolSideEffectScope;
}

export interface ToolCallProgressPayload {
  toolCallId: ToolCallId;
  toolName?: string;
  elapsedMs?: number;
  pid?: number;
  stdoutBytes?: number;
  stderrBytes?: number;
  outputBytes?: number;
  outputPreview?: ExecutionOutputPreview;
  stdoutTail?: string;
  stderrTail?: string;
}

export interface ToolCallResultPayload {
  toolCallId: ToolCallId;
  result: ToolResultPayload;
  duration: number;
  /** Skill metadata 仅用于 telemetry，不进入模型可见的 result.content。 */
  skillMetadata?: SkillTelemetryMetadata;
}

export interface ToolCallErrorPayload {
  toolCallId: ToolCallId;
  error: ErrorPayload;
  /** Skill metadata 仅用于 telemetry，不进入模型可见的错误正文。 */
  skillMetadata?: SkillTelemetryMetadata;
}

export interface ToolBatchCompletePayload {
  toolCallIds: ToolCallId[];
  successCount: number;
  errorCount: number;
}

export type BackgroundTaskStatus =
  | "running"
  | "completed"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "spawn_error"
  | "lost";

export interface BackgroundTaskPayloadBase {
  taskId: string;
  toolCallId?: ToolCallId | string;
  toolName?: string;
  // "workflow" = workflow run（CreateWorkflow）。追踪器的行为已按 per-tool lifecycleProvider
  // 分派，taskKind 只决定面板分组与图标，所以加宽是纯展示修正，不改任何生命周期语义。
  taskKind?: "bash" | "subagent" | "workflow";
  childSessionId?: SessionId | string;
  blocked?: boolean;
  blockedReason?: "interactive_prompt_detected" | "no_output_progress" | string;
  cancellable?: boolean;
  cancelRequestedAt?: Date;
  command?: string;
  description?: string;
  status: BackgroundTaskStatus;
  pid?: number;
  startedAt?: Date;
  completedAt?: Date;
  outputPath?: string;
  stderrPersistedOutputPath?: string;
  stdoutPersistedOutputPath?: string;
  outputBytes?: number;
  outputTruncated?: boolean;
  outputTail?: string;
  stderrBytes?: number;
  stderrTail?: string;
  stdoutBytes?: number;
  stdoutTail?: string;
  terminalId?: string;
}

export type BackgroundTaskStartedPayload = BackgroundTaskPayloadBase & {
  status: "running";
};

export type BackgroundTaskUpdatedPayload = BackgroundTaskPayloadBase;

export type BackgroundTaskCompletedPayload = BackgroundTaskPayloadBase & {
  status: Exclude<BackgroundTaskStatus, "running">;
};
