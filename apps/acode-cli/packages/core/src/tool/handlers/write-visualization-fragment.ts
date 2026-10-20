// ============================================================
// WriteVisualizationFragment Tool Handler
// ============================================================
// 对话内可视化（specs/gen-ui-visualize.md）的写入半边：把 HTML fragment 写进会话产物
// 存储（<storageRoot>/cli/artifacts/<sessionId>/visualize/<name>.html），同名覆盖 = 更新。
//
// 边界（与 Write 工具刻意不同）：
// - 不写工作区 → 不进 Write 权限链，sideEffectScope 是 "session"（结果交回调用方）；
// - 不落 acode-artifact:// 的 tool-result retention——可视化目录独立于 toolCall 生命周期；
// - 技能门：会话没加载 `visualize` 技能就拒绝（428 族，同 requireDynamicWorkflowSkill 先例；
//   技能里才有 fragment 契约，没读过的模型写出的片段几乎必然违反渲染端约束）。

import {
  VISUALIZATION_FRAGMENT_MAX_BYTES,
  VISUALIZATION_FRAGMENT_ONLY_MESSAGE,
  VISUALIZATION_FRAGMENT_TOO_LARGE_MESSAGE,
  VISUALIZE_SKILL_NAME,
  VISUALIZATION_FRAGMENT_ERROR_PREFIX,
  WRITE_VISUALIZATION_FRAGMENT_TOOL_NAME,
  WriteVisualizationFragmentInputJsonSchema,
  WriteVisualizationFragmentInputSchema,
  WriteVisualizationFragmentOutputJsonSchema,
  WriteVisualizationFragmentOutputSchema,
  type ModelMessageContent,
} from "@acode/contracts";
import type {
  ToolEntry,
  ToolExecutionContext,
  ToolHandler,
  ToolHandlerFailure,
  ToolInputResolutionContext,
  ToolInputResolutionResult,
} from "../types.js";
import { requireWorkflowSkill } from "./workflow-skill-gate.js";

const WRITE_VISUALIZATION_TIMEOUT_MS = 10_000;
/** 模型面只回一行确认（内容本身不回灌——它就是模型刚提交的那份）。 */
const WRITE_VISUALIZATION_MODEL_BYTES = 2_000;

/**
 * 业务失败码。沿用 workflow 族习惯：数值只是日志位，判别键在 message 前缀
 * （visualization_fragment_invalid）。「先去读技能」复用 428 族（WORKFLOW_SKILL_NOT_LOADED_CODE）。
 */
const VISUALIZATION_FRAGMENT_ERROR_CODE = 41;

const WRITE_VISUALIZATION_DESCRIPTION = [
  "Writes an interactive HTML fragment into the conversation as a visualization card (chart, diagram, simulation, mockup).",
  "",
  "Load the `visualize` skill (Skill tool) before using this tool — it carries the fragment contract and when a visualization is worth making.",
  "- `content` is a fragment: no <!doctype>/<html>/<head>/<body>; the host wraps it. Inline all data (≤ 1 MiB); no fetch/XHR/WebSocket.",
  "- `name` is lowercase-hyphen ASCII ending `.html` (e.g. `queue-backpressure.html`). Rewriting the same name updates that card.",
  "- Reference it in the turn's final response with `::visualize{\"name\":\"<name>\"}` on its own line — never inside a code fence. Emit the reference exactly once per turn.",
].join("\n");

/** 内容级校验（schema 之外的 422 语义拒绝）。fragment 判定用去空白前缀，容许前后换行。 */
function validateFragmentContent(content: string): ToolHandlerFailure | undefined {
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > VISUALIZATION_FRAGMENT_MAX_BYTES) {
    return {
      result: false,
      errorCode: VISUALIZATION_FRAGMENT_ERROR_CODE,
      message: VISUALIZATION_FRAGMENT_TOO_LARGE_MESSAGE,
    };
  }
  const opening = content.slice(0, 256).trimStart().toLowerCase();
  // 只判「整篇文档」的两种开头；fragment 里合法出现 <html:...> 之类模板串不受影响
  // （渲染端沙箱才是最终兜底，这里不做 HTML 语法深度校验）。
  if (opening.startsWith("<!doctype") || opening.startsWith("<html")) {
    return {
      result: false,
      errorCode: VISUALIZATION_FRAGMENT_ERROR_CODE,
      message: VISUALIZATION_FRAGMENT_ONLY_MESSAGE,
    };
  }
  return undefined;
}

const writeVisualizationFragmentHandler: ToolHandler = async (input, context) => {
  const parsed = WriteVisualizationFragmentInputSchema.parse(input);
  const store = context.visualizationFragmentStore;
  if (store === undefined) {
    return storeUnavailableFailure();
  }
  const written = await store.writeVisualizationFragment({
    sessionId: context.sessionId,
    name: parsed.name,
    content: parsed.content,
    ...(parsed.title ? { title: parsed.title } : {}),
  });
  return { name: parsed.name, bytes: written.bytes };
};

function storeUnavailableFailure(): ToolHandlerFailure {
  return {
    result: false,
    errorCode: VISUALIZATION_FRAGMENT_ERROR_CODE,
    message: `visualization_store_unavailable: this session has no visualization fragment storage wired, so nothing was written. Do not emit a ::visualize reference for it — it would render as plain text.`,
  };
}

function formatModelContent(output: unknown): ModelMessageContent {
  const parsed = WriteVisualizationFragmentOutputSchema.safeParse(output);
  if (!parsed.success) {
    return "WriteVisualizationFragment returned an invalid result.";
  }
  return `Fragment ${parsed.data.name} stored (${parsed.data.bytes} bytes). Reference it in the final response with ::visualize{"name":"${parsed.data.name}"} on its own line.`;
}

/** 技能门 + 内容校验都收在 resolveInput：确认窗之前拒绝，不打断用户。 */
function resolveWriteVisualizationInput(
  input: unknown,
  context: ToolInputResolutionContext,
): ToolInputResolutionResult {
  const gateFailure = requireWorkflowSkill(
    context,
    WRITE_VISUALIZATION_FRAGMENT_TOOL_NAME,
    VISUALIZE_SKILL_NAME,
  );
  if (gateFailure) return gateFailure;
  const parsed = WriteVisualizationFragmentInputSchema.safeParse(input);
  if (!parsed.success) {
    return schemaFailure(parsed.error.issues.map((issue) => issue.message).join("; "));
  }
  const contentFailure = validateFragmentContent(parsed.data.content);
  if (contentFailure) return contentFailure;
  return { result: true, input: parsed.data };
}

function schemaFailure(details: string): ToolHandlerFailure {
  return {
    result: false,
    errorCode: VISUALIZATION_FRAGMENT_ERROR_CODE,
    message: `${VISUALIZATION_FRAGMENT_ERROR_PREFIX}: ${details}`,
  };
}

export const writeVisualizationFragmentToolEntry: ToolEntry = {
  capability:
    "Write an interactive HTML fragment into the conversation as a visualization card (gated on the visualize skill)",
  metadata: {
    shouldDefer: true, // tool-search wave1a: 非常驻内置工具默认 defer(specs/tool-search.md R4)
    name: WRITE_VISUALIZATION_FRAGMENT_TOOL_NAME,
    description: WRITE_VISUALIZATION_DESCRIPTION,
    // 读模型内容、写会话存储；不碰工作区（spec：不进 Write 工具权限链）。
    readOnly: false,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: WRITE_VISUALIZATION_TIMEOUT_MS,
    maxOutputBytes: WRITE_VISUALIZATION_MODEL_BYTES,
    sideEffectScope: "session",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: writeVisualizationFragmentHandler,
  inputSchema: WriteVisualizationFragmentInputJsonSchema,
  outputSchema: WriteVisualizationFragmentOutputJsonSchema,
  runtimeInputSchema: WriteVisualizationFragmentInputSchema,
  runtimeOutputSchema: WriteVisualizationFragmentOutputSchema,
  formatModelContent,
  resolveInput: resolveWriteVisualizationInput,
  permission: {
    permission: "visualizationFragment",
    reason: "WriteVisualizationFragment stores an HTML fragment in session storage only",
    riskLevel: "low",
    sideEffectScope: "session",
    needsApproval: false,
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: WRITE_VISUALIZATION_MODEL_BYTES,
    maxModelBytes: WRITE_VISUALIZATION_MODEL_BYTES,
    strategy: "truncate",
    preview: { maxBytes: WRITE_VISUALIZATION_MODEL_BYTES, direction: "head" },
  },
  timeout: {
    kind: "timed",
    defaultMs: WRITE_VISUALIZATION_TIMEOUT_MS,
    maxMs: WRITE_VISUALIZATION_TIMEOUT_MS,
    allowCallOverride: false,
  },
  cancellation: {
    supported: false,
    cleanup: "none",
    userVisibleMessage:
      "WriteVisualizationFragment stores one bounded fragment and cannot be cancelled",
  },
  trace: {
    required: true,
    propagateToAdapters: false,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

export { validateFragmentContent as validateVisualizationFragmentContent };
