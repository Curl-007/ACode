// conflict:// 读形态（specs/conflict-uri-resolution.md R4）——会话冲突注册表
// 虚拟资源，不落文件管线；错误按 WI-13 skill:// 同款契约：模型可自纠的业务性
// 拒绝走 CoreError(ToolExecutionFailed, recoverable)。
import { CoreErrorType, createCoreError, type ReadTextOutput } from "@acode/contracts";
import type { ToolExecutionContext } from "../types.js";
import { ConflictUriError, isConflictUri, readConflictRegion } from "../conflict/index.js";

export { isConflictUri };

/**
 * 把 conflict://<id>[/<side>] 解析为 ReadTextOutput 形态（type:"text"），
 * 行号锚定真实文件坐标（startLine=块起始行），复用既有带行号渲染管线。
 */
export function buildConflictReadOutput(
  filePath: string,
  context: ToolExecutionContext,
): ReadTextOutput {
  let region: ReturnType<typeof readConflictRegion>;
  try {
    region = readConflictRegion({ sessionId: context.sessionId, rawUri: filePath });
  } catch (error) {
    if (error instanceof ConflictUriError) {
      throw createCoreError(CoreErrorType.ToolExecutionFailed, error.message, {
        context: { toolCallId: context.toolCallId, toolName: "Read" },
        recoverable: true,
      });
    }
    throw error;
  }
  const lines = region.content.split("\n");
  return {
    type: "text",
    filePath: region.sourcePath,
    content: region.content,
    numLines: lines.length,
    startLine: region.startLine,
    totalLines: region.endLine,
  };
}
