// 复活自 231118f（dev/from-acode-2026-10）。原提交的导入写成 `""@acode/shared"`（双引号笔误，
// 属于其过不了门禁的原因之一），这里修正为合法的裸包名导入。
import { computeLineChangeStat, type LineChangeStat } from "@acode/shared";

export type WritePhase = "generating" | "waiting" | "writing" | "written" | "failed" | "stopped";

export const WRITE_PHASE_MESSAGE_IDS = {
  generating: "chat.toolCall.write.generating",
  waiting: "chat.toolCall.write.waiting",
  writing: "chat.toolCall.write.writingFile",
  written: "chat.toolCall.edit.wrote",
  failed: "chat.toolCall.write.failed",
  stopped: "chat.toolCall.write.stopped",
} as const;

export function readWritePhase(raw: unknown, status: string, isFailed = false): WritePhase {
  if (isFailed) return "failed";
  const fields =
    typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : undefined;
  // v4 的 pending 同时承载生成与待审批，必须读权威阶段，不能凭路径或运行文案推测落盘。
  const phase = typeof fields?.v4Status === "string" ? fields.v4Status : status;
  switch (phase) {
    case "inputStreaming":
    case "pending":
      return fields?.inputPreviewComplete === true ? "waiting" : "generating";
    case "pendingApproval":
      return "waiting";
    case "running":
    case "in_progress":
      return "writing";
    case "success":
    case "completed":
      return "written";
    case "error":
    case "failed":
      return "failed";
    case "cancelled":
    case "stopped":
      return "stopped";
    default:
      return "waiting";
  }
}

export function readWriteStreamingChangeStat(input: unknown): LineChangeStat | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return undefined;
  }

  const fields = input as Record<string, unknown>;
  for (const key of [
    "content",
    "newText",
    "new_text",
    "newString",
    "new_string",
    "text",
    "fileContent",
    "file_content",
    "contents",
    "code",
  ]) {
    const content = fields[key];
    if (typeof content === "string") {
      return content.length > 0 ? computeLineChangeStat(null, content) : undefined;
    }
  }

  return undefined;
}
