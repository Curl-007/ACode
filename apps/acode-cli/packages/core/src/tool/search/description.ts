// ============================================================
// ToolSearch 固定模型侧说明文案（specs/tool-search.md R5）
// ============================================================
// 文案是自撰的等价说明（不拷上游专有描述）；模型面文本恒英文
//（specs/prompt-language-policy.md R3：工具描述属模型面，不接 i18n）。
// 注意：正文里的 XML 风格闭合标签用拼接构造，避免字面闭合序列在
// 其它渲染/传输面被误解析。

const CLOSE_FUNCTION_TAG = "</" + "function>";
const CLOSE_FUNCTIONS_TAG = "</" + "functions>";

function buildDescription(opening: string, callingConvention: string, resultNote: string): string {
  return `${opening}

Tools can be registered as "deferred": their names appear in <system-reminder> announcements, but their parameter schemas are withheld from the request until fetched. A deferred tool cannot be invoked before its schema is loaded. This tool takes a query, matches it against the deferred tool catalog of the current request, and returns the matched tools' complete JSON Schema definitions inside a <functions> block. ${callingConvention}

Result format: each matched tool is rendered as one <function>{"description": "...", "name": "...", "parameters": {...}}${CLOSE_FUNCTION_TAG} line inside a <functions> ... ${CLOSE_FUNCTIONS_TAG} block${resultNote}

Query forms:
- "select:Read,Edit,Grep" — fetch exactly these tools by name (comma separated)
- "notebook jupyter" — keyword search; returns up to max_results best matches
- "+slack send" — require "slack" to appear in the tool name, then rank by the remaining terms`;
}

/**
 * native 模式文案（波 2 才消费）：schema 一经返回即可像顶层工具一样直接调用。
 * 波 1 仅登记，不参与任何请求。
 */
export const NATIVE_TOOL_SEARCH_DESCRIPTION = buildDescription(
  "Fetches the full schema definitions of deferred tools so they become callable.",
  "Once a tool's schema has appeared in such a result, the tool is callable exactly like any tool declared at the top of the prompt.",
  " — the same encoding as the tool list at the top of this prompt.",
);

/**
 * local 模式文案：返回的定义描述的是**目标参数**，调用必须经 DeferredToolCall
 * 包装；常驻工具（含直选返回的）仍走普通工具调用，不能误读成包装入口。
 */
export const LOCAL_TOOL_SEARCH_DESCRIPTION = `${buildDescription(
  "Fetches the full schema definitions of deferred tools so they can be invoked through DeferredToolCall.",
  "Invoke a deferred tool by calling DeferredToolCall with {name, input}. Resident tools keep their normal direct tool calls, even when their definitions were returned here by direct selection.",
  ". For deferred tools, \"parameters\" describes the input object to pass to DeferredToolCall.",
)}

Example (TodoWrite is deferred and its schema was loaded by a previous search):
<example>
DeferredToolCall({"name":"TodoWrite","input":{"todos":[{"content":"Inspect the implementation","status":"in_progress","priority":"high"}]}})
</example>`;
