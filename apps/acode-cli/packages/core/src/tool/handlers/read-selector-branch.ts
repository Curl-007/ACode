// 路径选择器分支（specs/read-structural-summary.md R3，阶段 1：单区间 + raw）。
// 尾段完整匹配选择器文法才拆分——Windows 盘符（"C:\..."冒号后是路径体）与
// skill://、conflict:// 等 scheme 天然不匹配，零误拆；真实文件优先语义由
// 调用方路径解析承担（拆分只发生在文法命中时）。
import { CoreErrorType, createCoreError } from "@acode/contracts";
import { splitPathSelector } from "../read-summary/selector.js";
import type { ToolExecutionContext } from "../types.js";

export interface PathSelectorResolution {
  /** 选择器剥离后的路径（未命中选择器时为原输入）。 */
  path: string;
  /** 单区间选择器折算的 offset（1-based）。 */
  offset?: number;
  /** 单区间选择器折算的 limit。 */
  limit?: number;
  /** :raw——抑制结构化摘要（R3）。 */
  suppressSummary?: boolean;
}

export function applyPathSelector(
  filePathInput: string,
  context: ToolExecutionContext,
): PathSelectorResolution {
  const { path, selector } = splitPathSelector(filePathInput);
  switch (selector.kind) {
    case "none":
      return { path: filePathInput };
    case "raw": {
      if (!selector.ranges || selector.ranges.length === 0) {
        return { path, suppressSummary: true };
      }
      if (selector.ranges.length === 1) {
        return { ...rangeToWindow(selector.ranges[0]!), suppressSummary: true, path };
      }
      return unsupported(filePathInput, "raw multi-range", context);
    }
    case "lines": {
      if (selector.ranges.length === 1) {
        return { path, ...rangeToWindow(selector.ranges[0]!) };
      }
      return unsupported(filePathInput, "multi-range", context);
    }
    case "tail":
      return unsupported(filePathInput, "tail (:-N)", context);
    case "conflicts":
      return unsupported(filePathInput, "conflicts", context);
  }
}

function rangeToWindow(range: {
  start: number;
  end?: number;
}): { offset: number; limit?: number } {
  const offset = Math.max(1, range.start);
  return {
    offset,
    ...(range.end !== undefined ? { limit: Math.max(1, range.end - offset + 1) } : {}),
  };
}

function unsupported(
  filePathInput: string,
  form: string,
  context: ToolExecutionContext,
): never {
  // 阶段 2 登记面（spec R3）：tail/多区间/:conflicts 解析器已就位，接线待后续。
  // fail-loud 给可操作替代，不静默按字面路径读（会 ENOENT 误导模型）。
  throw createCoreError(
    CoreErrorType.ToolExecutionFailed,
    `Selector form "${form}" in "${filePathInput}" is not supported yet. Use a single range (path:N-M, path:N, path:N-), path:raw, or the offset/limit parameters.`,
    {
      context: { toolCallId: context.toolCallId, toolName: "Read" },
      recoverable: true,
    },
  );
}
