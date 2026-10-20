// ============================================================
// local 投影基元（specs/tool-search.md R7）
// ============================================================
// functions 容器的渲染基元：定义编码 + 加载提示。闭合标签用拼接构造，
// 避免字面闭合序列在本文件之外的渲染面被误解析。

import { DEFERRED_TOOL_CALL_NAME, type ModelToolContract } from "@acode/contracts";
import { wrapSystemReminderForSource } from "../../system-reminder/source.js";

const OPEN_FUNCTION_TAG = "<" + "function>";
const CLOSE_FUNCTION_TAG = "</" + "function>";

/**
 * 请求内定义渲染器：编码只在本次请求内按工具定义（对象引用）复用，保证同一
 * 请求里多处引用同一工具时字节一致（稳定前缀）；下一请求必须重新读取当前
 * 定义，不引入跨请求缓存或失效状态（R7）。
 */
export function createLocalToolDefinitionRenderer(): (tool: ModelToolContract) => string {
  const definitions = new Map<ModelToolContract, string>();
  return (tool) => {
    let definition = definitions.get(tool);
    if (definition === undefined) {
      definition =
        OPEN_FUNCTION_TAG +
        JSON.stringify({
          description: tool.description ?? "",
          name: tool.name,
          parameters: tool.inputSchema,
        }) +
        CLOSE_FUNCTION_TAG;
      definitions.set(tool, definition);
    }
    return definition;
  };
}

/** 重复搜索已在上下文的工具：提醒直接用包装调用，不再展开定义。 */
export function localToolsAlreadyLoadedReminder(names: readonly string[]): string {
  // 指引属于当前工具结果，内联 tool_result_warning 即可；不作为 attachment 参与重排。
  return wrapSystemReminderForSource(
    "tool_result_warning",
    `Tool definitions already available in this conversation: ${names.join(", ")}. Use ${DEFERRED_TOOL_CALL_NAME} with {name, input} to execute these tools. Searching again does not execute them.`,
  );
}

/** 首次加载成功：给出包装调用的下一步指引。 */
export function localToolsLoadedReminder(names: readonly string[]): string {
  const action = names.length === 1 ? "Call it now" : "Call them now";
  return wrapSystemReminderForSource(
    "tool_result_warning",
    `Loaded: ${names.join(", ")}. ${action} with ${DEFERRED_TOOL_CALL_NAME} {"name":"<tool name>","input":{...}}, using the exact tool name and filling input according to its schema above. No additional ToolSearch is needed before calling these tools.`,
  );
}
