// task 终态/就绪结果与快照、归档删除结果类型：自 acodeTaskService.ts 拆出的纯类型叶子。
import type { ACodeTaskSnapshot } from "@acode/shared";

export interface ACodeTaskSnapshotWithEtagResult {
  snapshot: ACodeTaskSnapshot | null;
  etag?: string;
  notModified?: boolean;
}

/** 同一 workspace 的固定归档删除集合；每个去重后的目标恰好属于一种结果。 */
export interface ACodeArchivedTaskDeletionResult {
  deletedTaskIds: string[];
  skippedTaskIds: string[];
  failedTaskIds: string[];
}

/** 一个 task 输入轮次的终态结果，供后台派发（定时任务）回写运行结果。 */
export interface ACodeTaskTerminalOutcome {
  taskId: string;
  /** 对应的输入轮次 id（= sendPrompt 的 traceId/inputId），用于精确匹配某次派发。 */
  inputId?: string;
  outcome: "succeeded" | "failed" | "stopped";
  /** 失败时的错误信息。 */
  error?: string;
}

/** 一次输入轮次已经真正收口，session 可以安全接受下一条输入。 */
export interface ACodeTaskReadyOutcome {
  taskId: string;
  reason: "prompt_completed" | "prompt_failed";
}
