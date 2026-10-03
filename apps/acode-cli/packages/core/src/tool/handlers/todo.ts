// ============================================================
// Todo Tool Handlers
// ============================================================

import {
  CoreErrorType,
  appendConfidenceObservation,
  completionGateErrorMessage,
  computeAvailable,
  findCompletionGateViolations,
  isSameTodoContent,
  normalizeTodos,
  TODO_METADATA_MAX_KEY_CHARS,
  TODO_METADATA_MAX_KEYS,
  TODO_METADATA_MAX_SERIALIZED_BYTES,
  TodoReadInputJsonSchema,
  TodoReadInputSchema,
  TodoReadOutputJsonSchema,
  TodoReadOutputSchema,
  TodoWriteInputJsonSchema,
  TodoWriteInputSchema,
  TodoWriteOutputJsonSchema,
  TodoWriteOutputSchema,
  createCoreError,
  type NormalizedTodo,
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
  // J2-1（specs/todo-confidence-semantics.md R2/R3）：门槛与 history 追加都需要旧列表，
  // readTodos 提前到判定之前；本 handler 是 confidenceHistory 的唯一写入路径。
  const prior = normalizeTodos(
    await context.sessionStore.readTodos({ sessionID: context.sessionId }),
  );

  // R3 完成门槛：新完成转移缺足够证据状态 → 立即抛 InvalidInput（updateTodos 不执行，
  // 持久化零写入）；grandfather 豁免（旧列表已 completed 的项重发不受检）。
  // 文案点名 id 但不披露枚举排序/门槛边界（保密规则见 completionGateErrorMessage）。
  const violations = findCompletionGateViolations(normalized, prior);
  if (violations.length > 0) {
    throw createCoreError(CoreErrorType.InvalidInput, completionGateErrorMessage(violations), {
      context: {
        toolCallId: context.toolCallId,
        toolName: "TodoWrite",
        todoIds: violations.map((violation) => violation.id),
      },
      recoverable: true,
    });
  }

  // R2 工具自有 history：模型自报的 confidenceHistory 已在 schema 层被 strip
  // （不是可写面成员）；这里按 id+content 双匹配旧项轨迹（对抗复核 F1，单一实现
  // isSameTodoContent），每项最多追加一条观测
  // （机制参照 jcode (MIT) crates/jcode-app-core/src/tool/todo.rs:26-68，自撰实现）。
  const stored = mergeConfidenceHistory(normalized, prior);
  const views = toTodoViews(stored);

  await context.sessionStore.updateTodos({ sessionID: context.sessionId, todos: stored });

  return {
    oldTodos: toTodoViews(prior),
    todos: views,
    summary: summarizeTodos(views),
  } satisfies TodoWriteOutput;
};

/**
 * J2-1 R2：把本次提交的 completionConfidence 观测折叠进工具维护的轨迹。
 * 无观测且旧项无轨迹 → 原样返回（undefined 不物化空数组，旧格式项逐字节不变）；
 * 轨迹通过 appendConfidenceObservation 纯函数追加（连续去重 + 滑动窗口）。
 * 对抗复核 F1：继承判据与 R3 门槛豁免同款 id+content 双匹配（isSameTodoContent 单一实现）
 * ——同 id 但内容变更的项不继承旧轨迹，从本次观测重新开始；否则「剪枝补位/重排/显式 id
 * 换内容」的项会继承前项 ["verified"] 类轨迹，制造伪爬升，污染 J2-2 spike 检测数据源。
 */
function mergeConfidenceHistory(
  submitted: readonly NormalizedTodo[],
  prior: readonly NormalizedTodo[],
): TodoItem[] {
  const priorById = new Map<string, NormalizedTodo>();
  for (const todo of prior) {
    priorById.set(todo.id, todo);
  }
  return submitted.map((todo) => {
    const priorTodo = priorById.get(todo.id);
    const inherited =
      priorTodo !== undefined && isSameTodoContent(todo, priorTodo)
        ? priorTodo.confidenceHistory
        : undefined;
    const history = appendConfidenceObservation(inherited, todo.completionConfidence);
    return history === undefined ? todo : { ...todo, confidenceHistory: [...history] };
  });
}

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
- \`metadata\` is a bounded annotation object (max ${TODO_METADATA_MAX_KEYS} keys, ${TODO_METADATA_MAX_KEY_CHARS}-char keys, ${TODO_METADATA_MAX_SERIALIZED_BYTES / 1024} KB serialized, JSON values only); it is pure annotation and never affects ordering or counts.
- \`completionConfidence\` records the evidence behind an item's completion — report it from what you actually observed, not from what you hope is true. Marking an item \`completed\` without sufficient completion evidence is rejected with the item named; run the checks first, then report from the evidence you have.
- Each returned item carries a tool-maintained \`confidenceHistory\` (the trail of \`completionConfidence\` values reported for it, oldest first); any \`confidenceHistory\` you submit is ignored.`,
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
