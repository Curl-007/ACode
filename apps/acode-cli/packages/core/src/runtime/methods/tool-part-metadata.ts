import { PersistedToolSearchContentSchema } from "@acode/contracts";
import {
  COMPLETED_TOOL_PART_METADATA_SCHEMA_VERSION,
  type CompletedToolPartMetadata,
  type ToolExecutionResult,
} from "../deps.js";
import { createMcpToolDisplay } from "../../tool/executor/result-display.js";

export function mcpToolPartMetadata(
  presentation:
    | { serverName: string; toolName: string; description?: string }
    | undefined,
): CompletedToolPartMetadata | undefined {
  const display = createMcpToolDisplay(presentation);
  return display
    ? { schemaVersion: COMPLETED_TOOL_PART_METADATA_SCHEMA_VERSION, display }
    : undefined;
}

export function completedToolPartMetadata(
  result: ToolExecutionResult,
): CompletedToolPartMetadata {
  // ToolSearch 结果的持久化形态（specs/tool-search.md R7/R10）：历史与 part metadata
  // 只保存真实 tool_reference 引用（PersistedToolSearchContentSchema），schema 正文
  // 不落库；冷恢复经 hydrateToolSearchContent 重建。非引用形态的 modelContent 不通过
  // schema，自然缺席（不改变既有工具的持久化字节）。
  const modelContent = PersistedToolSearchContentSchema.safeParse(result.modelContent);
  const serialization = result.serialization
    ? {
        truncated: result.serialization.truncated,
        originalBytes: result.serialization.originalBytes,
        returnedBytes: result.serialization.returnedBytes,
        budgetStrategy: result.serialization.budgetStrategy,
        ...(result.serialization.artifactPath
          ? { artifactPath: result.serialization.artifactPath }
          : {}),
      }
    : undefined;
  return {
    schemaVersion: COMPLETED_TOOL_PART_METADATA_SCHEMA_VERSION,
    ...(modelContent.success ? { modelContent: modelContent.data } : {}),
    ...(result.display ? { display: result.display } : {}),
    ...(serialization ? { serialization } : {}),
    // resume 需要恢复模型当时真实读到的文件快照；只依赖 tool_result 文本
    // 会把主路径绑死在 provider 展示格式上，所以新 session 结构化持久化 read-state。
    ...(result.readFileStateMetadata ? { readFileState: result.readFileStateMetadata } : {}),
  };
}
