// v4 ToolCallRow → 旧 ToolCallBlocks 输入形态（TaskChatToolCallTreeNode）适配。
// 纯函数：ToolCallBlock 及其 renderers（execute/read/edit/...）吃的是旧 ACode Agent 的
// TaskChatToolCall 形态；v4 row 自包含，字段一一映射即可，不需要看别的行。
import { buildACodeStreamingToolInputPreview } from "@acode/shared";
import type { ToolCallRow } from "@acode/shared/acode-protocol-v4";
import type { TaskChatToolCallTreeNode } from "@/lib/toolCallTree.js";
import { normalizeWrappedErrorText } from "@/lib/toolError.js";
// 本文件唯一的非纯输入：todo 置换计数经 WeakMap 侧信道由投影层登记（specs/
// todo-displacement.md R2）——v4 row 是协议数据不可变异，计数又不能进 wire。
import { getTodoSupersededCount } from "@/v4/todoDisplacement.js";

// v4 status → 旧 ChatToolCall.status（mapToolStatus 的输入词表：
// pending/in_progress/completed/failed/stopped）。
// pendingApproval 视为 pending：审批中输入已定，展示为待执行。
const STATUS_MAP: Record<ToolCallRow["status"], string> = {
  inputStreaming: "pending",
  pendingApproval: "pending",
  running: "in_progress",
  success: "completed",
  error: "failed",
  cancelled: "stopped",
};

interface ResolvedToolInputPreview {
  input: unknown;
  inputPreviewComplete?: boolean;
  streamingRawInputLength?: number;
}

function isEmptyPlainRecord(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  );
}

/** input 缺席时，用 v4 inputText 还原完整或流式半截工具参数预览。 */
function resolveToolInputPreview(row: ToolCallRow): ResolvedToolInputPreview {
  if (row.input !== undefined) {
    return {
      input: row.input,
      inputPreviewComplete: true,
      ...(row.inputText.length > 0 ? { streamingRawInputLength: row.inputText.length } : {}),
    };
  }
  if (!row.inputText) {
    return { input: undefined };
  }
  const preview = buildACodeStreamingToolInputPreview(row.inputText);
  return {
    input: isEmptyPlainRecord(preview.input) ? undefined : preview.input,
    inputPreviewComplete: preview.complete,
    streamingRawInputLength: row.inputText.length,
  };
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function resolveV4ToolErrorText(row: ToolCallRow): string | undefined {
  if (row.status !== "error") {
    return undefined;
  }

  const directMessage = readNonEmptyString(row.error?.message);
  if (directMessage) {
    return directMessage;
  }

  const outputText = readNonEmptyString(row.output?.text);
  if (outputText) {
    return normalizeWrappedErrorText(outputText);
  }

  return readNonEmptyString(row.error?.code);
}

export function toolCallRowToLegacyNode(row: ToolCallRow): TaskChatToolCallTreeNode {
  const legacyStatus = STATUS_MAP[row.status];
  const errorText = resolveV4ToolErrorText(row);
  const inputPreview = resolveToolInputPreview(row);
  // intent 字段（apps/acode-cli/specs/tool-intent-field.md R4）：展示面无条件剥离
  // 顶层 `i` 并桥接为 title（ToolLayout 的悬浮提示，全渲染器零改动）。UI 不门控
  // ——远端 agent 的 env 不可见；现工具面无任何工具自有 `i` 参数（contracts 实证）。
  const intentStripped = stripToolIntentForDisplay(inputPreview.input);
  // CUA 等结构化展示事实位于 output.display；顶层 display 仅是旧 Node REPL 图片通道。
  // 优先读取 canonical output，同时保留旧快照和 Browser 轮尾截图的兼容路径。
  const display = row.output?.display ?? row.display;
  // CUA v1 历史 display 会重复保存 input；工具调用行已经持有唯一输入，桥接时丢弃旧副本。
  const legacyDisplay =
    display?.kind === "cua" ? (({ input: _legacyInput, ...rest }) => rest)(display) : display;
  return {
    toolCall: {
      toolId: row.toolCallId,
      toolName: row.toolName,
      // kind 兼容旧聚合分类：v4 下没有旧 ACode Agent 快照形态，直接用固定工具名。
      kind: row.toolName,
      input: intentStripped.input,
      ...(intentStripped.intent !== undefined ? { title: intentStripped.intent } : {}),
      status: legacyStatus,
      output: row.output?.text,
      // V4 ToolCallRow 没有 legacy taskNotification raw；background Agent
      // 的终态摘要只落在 output。Agent renderer 读取 content 展示活动结果，因此在
      // Agent/Task 行显式桥接，避免失败详情虽已投影却仍只显示一张空卡。
      ...((row.toolName === "Agent" || row.toolName === "Task") && row.output?.text
        ? { content: row.output.text }
        : {}),
      // v4 row 是自包含投影，部分 provider 只把工具失败正文塞进 output，
      // 不补回 legacy error 会让 ToolOutput 看不到失败原因，只剩一张空的 failed 摘要。
      error: errorText,
      raw: {
        error: row.error,
        rawOutput: row.output?.text,
        outputPreview: row.outputPreview,
        outputTruncated: row.output?.truncated,
        status: legacyStatus,
        toolCallId: row.toolCallId,
        toolName: row.toolName,
        v4Status: row.status,
        ...(row.cuaApp ? { cuaApp: row.cuaApp } : {}),
        ...(legacyDisplay ? { display: legacyDisplay } : {}),
        inputPreviewComplete: inputPreview.inputPreviewComplete,
        streamingRawInputLength: inputPreview.streamingRawInputLength,
      },
      startedAt: typeof row.startedAt === "number" ? row.startedAt : undefined,
      // todo 原地置换计数（specs/todo-displacement.md R2）：投影层经 WeakMap 侧信道
      // 登记，桥接层读取；缺席（legacy 快照/非锚点行）时字段不出现。
      ...(getTodoSupersededCount(row) !== undefined
        ? { todoSupersededCount: getTodoSupersededCount(row) }
        : {}),
    },
    // subagent 不内嵌 child rows；v4 工具行没有子树，嵌套工具在旧形态里也
    // 由独立 row（subagent/toolCall）表达。
    childToolCalls: [],
  };
}

/**
 * 剥离展示 input 顶层的 intent 字段 `i`（specs/tool-intent-field.md R4）。
 * 非 record / 无 `i` → 原样透传；raw 通道（rawInput/inputText）不改写，
 * 调试面（ModelTrajectory）保留模型原始 args。
 */
function stripToolIntentForDisplay(input: unknown): { input: unknown; intent?: string } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { input };
  }
  const record = input as Record<string, unknown>;
  if (!("i" in record)) {
    return { input };
  }
  const intent = record["i"];
  const rest: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    if (key !== "i") rest[key] = record[key];
  }
  return {
    input: rest,
    ...(typeof intent === "string" && intent.trim().length > 0 ? { intent: intent.trim() } : {}),
  };
}
