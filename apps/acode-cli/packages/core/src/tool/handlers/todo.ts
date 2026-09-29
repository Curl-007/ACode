// ============================================================
// Todo Tool Handlers
// ============================================================

import {
  CoreErrorType,
  computeAvailable,
  normalizeTodos,
  TodoReadInputJsonSchema,
  TodoReadInputSchema,
  TodoReadOutputJsonSchema,
  TodoReadOutputSchema,
  TodoWriteInputJsonSchema,
  TodoWriteInputSchema,
  TodoWriteOutputJsonSchema,
  TodoWriteOutputSchema,
  createCoreError,
  type TodoItem,
  type TodoItemView,
  type TodoReadOutput,
  type TodoSummary,
  type TodoWriteInput,
  type TodoWriteOutput,
} from "@acode/contracts";
import type { ToolEntry, ToolHandler } from "../types.js";

const MAX_TODO_MODEL_BYTES = 100_000;

const todoReadHandler: ToolHandler = async (input, context) => {
  TodoReadInputSchema.parse(input);

  if (!context.sessionStore) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "SessionStorePort is not configured for TodoRead",
      {
        context: {
          toolCallId: context.toolCallId,
          toolName: "TodoRead",
        },
        recoverable: false,
      },
    );
  }

  const todos = await context.sessionStore.readTodos({ sessionID: context.sessionId });
  return { todos: toTodoViews(todos) } satisfies TodoReadOutput;
};

const todoWriteHandler: ToolHandler = async (input, context) => {
  const { todos } = TodoWriteInputSchema.parse(input) as TodoWriteInput;

  if (!context.sessionStore) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "SessionStorePort is not configured for TodoWrite",
      {
        context: {
          toolCallId: context.toolCallId,
          toolName: "TodoWrite",
        },
        recoverable: false,
      },
    );
  }

  // R1 规范化（铸派生 id）在写入前完成：持久化、返回视图与 summary 用同一份规范化结果。
  // 写入合法性（唯一性/悬空引用/环/metadata 上界）已由 TodoWriteInputSchema.superRefine
  // 在 parse 时判定——报错时下面的 read/update 都不会执行（验收场景 1「不静默断边」）。
  const normalized = normalizeTodos(todos);
  const views = toTodoViews(normalized);

  const oldTodos = await context.sessionStore.readTodos({ sessionID: context.sessionId });
  await context.sessionStore.updateTodos({ sessionID: context.sessionId, todos: normalized });

  return {
    oldTodos: toTodoViews(oldTodos),
    todos: views,
    summary: summarizeTodos(views),
  } satisfies TodoWriteOutput;
};

/**
 * R4：available 是当次列表的派生只读投影——不落库、不进 journal、不跨调用缓存
 * （concurrentSafe: false 的整表替换语义下，跨调用缓存 available 必然陈旧）。
 * 规范化在这里是幂等的（显式 id 原样保留），读路径对缺 id 的历史行铸同款派生 id。
 */
function toTodoViews(todos: readonly TodoItem[]): TodoItemView[] {
  const normalized = normalizeTodos(todos);
  const available = computeAvailable(normalized);
  return normalized.map((todo, index) => ({ ...todo, available: available[index] }));
}

export const todoReadToolEntry: ToolEntry = {
  capability: "Read the current session todo list without modifying external state",
  metadata: {
    name: "TodoRead",
    description: "Read the current session todo list",
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: 30000,
    maxOutputBytes: MAX_TODO_MODEL_BYTES,
    sideEffectScope: "none",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: todoReadHandler,
  inputSchema: TodoReadInputJsonSchema,
  outputSchema: TodoReadOutputJsonSchema,
  runtimeInputSchema: TodoReadInputSchema,
  runtimeOutputSchema: TodoReadOutputSchema,
  permission: {
    permission: "todo.read",
    reason: "TodoRead only reads session-local task state",
    riskLevel: "low",
    sideEffectScope: "none",
    needsApproval: false,
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: MAX_TODO_MODEL_BYTES,
    maxModelBytes: MAX_TODO_MODEL_BYTES,
    strategy: "truncate",
    preview: {
      maxBytes: MAX_TODO_MODEL_BYTES,
      direction: "head",
    },
  },
  timeout: {
    defaultMs: 30000,
    maxMs: 30000,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "TodoRead was cancelled before todo state was returned",
  },
  trace: {
    required: true,
    propagateToAdapters: false,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

export const todoWriteToolEntry: ToolEntry = {
  capability:
    "Replace the current session todo list to track multi-step task progress and resume state",
  metadata: {
    name: "TodoWrite",
    description: `Create and update a task list for the current session. The list is rendered to the user as your working plan.

- Each todo has \`content\`, \`status\` ("pending" | "in_progress" | "completed"), and \`priority\` ("high" | "medium" | "low").
- Send the full list each call; it replaces the previous one.
- Keep one item \`in_progress\` at a time and mark it \`completed\` when done.
- Optionally give an item a stable \`id\` (unique within the list); items without one are assigned a position-derived id like \`todo-0\` in the stored and returned list.
- \`blockedBy\` lists ids from the same submitted list that must complete first: each referenced item must carry an explicit \`id\`, and dangling references or dependency cycles are rejected. Every returned item is marked \`available\` when it is pending and unblocked (no \`blockedBy\` left, or all referenced items completed), and \`summary.available\` counts them.
- \`metadata\` is a bounded annotation object (max 16 keys, 64-char keys, 4 KB serialized, JSON values only); it is pure annotation and never affects ordering or counts.`,
    readOnly: true,
    destructive: false,
    concurrentSafe: false,
    timeoutMs: 30000,
    maxOutputBytes: MAX_TODO_MODEL_BYTES,
    sideEffectScope: "session",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: todoWriteHandler,
  inputSchema: TodoWriteInputJsonSchema,
  outputSchema: TodoWriteOutputJsonSchema,
  runtimeInputSchema: TodoWriteInputSchema,
  runtimeOutputSchema: TodoWriteOutputSchema,
  permission: {
    permission: "todo.write",
    reason: "TodoWrite only updates session-local task state for progress tracking",
    riskLevel: "low",
    sideEffectScope: "session",
    needsApproval: false,
    patternSources: ["toolName", "input"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: MAX_TODO_MODEL_BYTES,
    maxModelBytes: MAX_TODO_MODEL_BYTES,
    strategy: "truncate",
    preview: {
      maxBytes: MAX_TODO_MODEL_BYTES,
      direction: "head",
    },
  },
  timeout: {
    defaultMs: 30000,
    maxMs: 30000,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "TodoWrite was cancelled before todo state was updated",
  },
  trace: {
    required: true,
    propagateToAdapters: false,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

/** 计数从同一份视图数组派生：summary.available 与逐项 available 布尔恒一致（验收场景 3）。 */
function summarizeTodos(todos: readonly TodoItemView[]): TodoSummary {
  return {
    total: todos.length,
    pending: todos.filter((todo) => todo.status === "pending").length,
    inProgress: todos.filter((todo) => todo.status === "in_progress").length,
    completed: todos.filter((todo) => todo.status === "completed").length,
    available: todos.filter((todo) => todo.available).length,
  };
}
