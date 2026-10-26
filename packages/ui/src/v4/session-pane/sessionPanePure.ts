// SessionPane 的纯裁决/编码 helper（specs/god-component-split-plan.md 方向）。
//
// 从 SessionPane.tsx 原样外迁：该文件已在 legacy ratchet 基线上（超限只减不增），
// U07 目录接入需要在 pane 层新增 store 透传，必须为它腾出行数。语义零改动。
import type { ConversationSnapshot, SessionErrorInfo } from "@acode/shared/acode-protocol-v4";
import type { ACodeUiError } from "@/lib/acodeUiError.js";
import { WORKSPACE_FILE_DRAG_MIME } from "@/lib/workspaceFileDrag.js";

export function createSessionErrorKey(
  sessionId: string | null | undefined,
  error: SessionErrorInfo,
): string {
  return [
    sessionId?.trim() || "draft",
    error.code,
    error.at,
    error.message,
    error.traceId ?? "",
    error.detail ?? "",
  ].join(":");
}

export const EMPTY_SUBAGENT_PROJECTION: NonNullable<ConversationSnapshot["subagents"]> = {
  revision: 0,
  childSessionIds: [],
  running: [],
  endedTotal: 0,
};

export const MAX_CONVERSATION_FILE_CHANGES_CACHE_ENTRIES = 20;

/** base64 → 字节（可视化卡片分块读）。renderer 里 `atob` 恒在（Chromium）。 */
export function decodeVisualizationBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function toComposerUiError(
  sessionId: string | null | undefined,
  error: SessionErrorInfo,
): ACodeUiError {
  return {
    code: error.code,
    message: error.message,
    ...(error.traceId ? { traceId: error.traceId } : {}),
    ...(error.detail ? { detail: error.detail } : {}),
    ...(error.underlyingErrorMessage
      ? { underlyingErrorMessage: error.underlyingErrorMessage }
      : {}),
    ...(error.underlyingErrorDetail ? { underlyingErrorDetail: error.underlyingErrorDetail } : {}),
    // V4 snapshot 已携带安全归因；此处透传归因字段，保证错误按安全归因聚类。
    ...(error.attribution ? { attribution: error.attribution } : {}),
    ...(sessionId ? { taskId: sessionId } : {}),
  };
}

export function isConversationFileDrag(dataTransfer: DataTransfer): boolean {
  const types = Array.from(dataTransfer.types);
  return (
    types.includes("Files") ||
    types.includes(WORKSPACE_FILE_DRAG_MIME) ||
    Array.from(dataTransfer.items ?? []).some((item) => item.kind === "file")
  );
}
