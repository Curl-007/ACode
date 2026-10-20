// ============================================================
// ToolSearch Handler（specs/tool-search.md R5）
// ============================================================
// 控制工具一：搜索当前请求允许的 deferred 目录。纯读 catalog、无副作用；
// 启用事实来自请求准备注入的 context.toolSearch（缺席 = 未启用，拒绝执行）。

import {
  TOOL_SEARCH_NAME,
  ToolSearchInputJsonSchema,
  ToolSearchInputSchema,
  ToolSearchOutputJsonSchema,
  ToolSearchOutputSchema,
  type ToolSearchInput,
  type ToolSearchOutput,
} from "@acode/contracts";
import type { ToolEntry, ToolHandler } from "../types.js";
import { NATIVE_TOOL_SEARCH_DESCRIPTION } from "../search/description.js";
import { searchTools } from "../search/search.js";

const MAX_SEARCH_RESULT_BYTES = 100_000;
const SEARCH_TIMEOUT_MS = 10_000;

const toolSearchHandler: ToolHandler = async (input, context) => {
  context.abortSignal?.throwIfAborted();
  // 未启用即抛错（R5）：不猜、不降级为空结果——模型侧的启用事实以请求准备为准。
  if (!context.toolSearch?.enabled)
    throw new Error("ToolSearch is not enabled for this request.");
  const parsed = ToolSearchInputSchema.parse(input) as ToolSearchInput;
  const catalog = context.toolSearch.catalog;
  const output: ToolSearchOutput = {
    query: parsed.query,
    matches: searchTools(parsed.query, catalog, parsed.max_results),
    total_deferred_tools: catalog.filter((tool) => tool.deferred).length,
  };
  return output;
};

export const toolSearchToolEntry: ToolEntry = {
  capability: "Search available deferred tools and load their definitions",
  metadata: {
    name: TOOL_SEARCH_NAME,
    // 注册面使用 native 文案；local 请求投影会以 LOCAL_TOOL_SEARCH_DESCRIPTION 覆盖
    //（exposure.ts），因为 local 的调用约定经 DeferredToolCall，两者不能混用。
    description: NATIVE_TOOL_SEARCH_DESCRIPTION,
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: SEARCH_TIMEOUT_MS,
    maxOutputBytes: MAX_SEARCH_RESULT_BYTES,
    sideEffectScope: "none",
    riskLevel: "low",
    needsApproval: false,
    // 控制工具常驻请求（R4 名单），永不 defer。
    alwaysLoad: true,
  },
  handler: toolSearchHandler,
  inputSchema: ToolSearchInputJsonSchema,
  outputSchema: ToolSearchOutputJsonSchema,
  runtimeInputSchema: ToolSearchInputSchema,
  runtimeOutputSchema: ToolSearchOutputSchema,
  // 结果映射为真实 tool_reference 引用块序列（R5/R7）：历史只存引用，
  // schema 展开发生在请求投影；空结果回固定文案。
  formatModelContent: (output) => {
    const parsed = ToolSearchOutputSchema.parse(output);
    return parsed.matches.length > 0
      ? parsed.matches.map((toolName) => ({ type: "tool_reference" as const, toolName }))
      : "No matching deferred tools found";
  },
  permission: {
    permission: "tool.search",
    reason: "Search the current allowed tool catalog",
    riskLevel: "low",
    sideEffectScope: "none",
    needsApproval: false,
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: MAX_SEARCH_RESULT_BYTES,
    maxModelBytes: MAX_SEARCH_RESULT_BYTES,
    strategy: "truncate",
    preview: { maxBytes: MAX_SEARCH_RESULT_BYTES, direction: "head" },
  },
  timeout: { defaultMs: SEARCH_TIMEOUT_MS, maxMs: SEARCH_TIMEOUT_MS, allowCallOverride: false },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "ToolSearch was cancelled before results were returned",
  },
  trace: {
    required: true,
    propagateToAdapters: false,
    recordInput: "summary",
    recordOutput: "summary",
  },
};
