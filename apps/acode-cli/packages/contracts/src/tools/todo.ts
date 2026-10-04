// ============================================================
// Todo Tools - session task checklist
// ============================================================
// References: session todo and planning tool behavior

import { z } from "zod";
import type { ToolCallId, TraceId } from "../interfaces/shared.js";
import { toToolJsonSchema } from "./json-schema.js";
import {
  TODO_CONFIDENCE_HISTORY_MAX,
  TodoCompletionConfidenceSchema,
} from "./todo-confidence.js";
import {
  TODO_METADATA_MAX_KEY_CHARS,
  TODO_METADATA_MAX_KEYS,
  TODO_METADATA_MAX_SERIALIZED_BYTES,
  TodoBlockedBySchema,
  TodoIdSchema,
  TodoMetadataSchema,
  validateTodoList,
} from "./todo-deps.js";

// D4 依赖字段的常量与纯函数物理家在 ./todo-deps.js、J2-1 置信度的在 ./todo-confidence.js
// （避免运行时循环导入；后者独立成文件是 AGENTS.md 单文件 400 行上限）；
// 对本模块原样再导出，消费方导出面与 spec「接口」节一致。
export {
  TODO_BLOCKED_BY_MAX_ITEMS,
  TODO_ID_MAX_CHARS,
  TODO_METADATA_MAX_KEY_CHARS,
  TODO_METADATA_MAX_KEYS,
  TODO_METADATA_MAX_SERIALIZED_BYTES,
  computeAvailable,
  derivedTodoId,
  detectTodoCycle,
  normalizeTodos,
  TodoBlockedBySchema,
  TodoDepsJsonSchema,
  TodoIdSchema,
  TodoMetadataSchema,
  validateTodoList,
  type NormalizedTodo,
  type TodoDepsJson,
  type TodoListIssue,
} from "./todo-deps.js";
export {
  TODO_CONFIDENCE_HISTORY_MAX,
  TodoCompletionConfidenceSchema,
  TodoConfidenceJsonSchema,
  appendConfidenceObservation,
  completionConfidencePassesGate,
  completionGateErrorMessage,
  findCompletionGateViolations,
  isSameTodoContent,
  type TodoCompletionConfidence,
  type TodoCompletionGateViolation,
  type TodoConfidenceJson,
} from "./todo-confidence.js";

export const TodoStatus = {
  Pending: "pending",
  InProgress: "in_progress",
  Completed: "completed",
} as const;

export type TodoStatus = (typeof TodoStatus)[keyof typeof TodoStatus];

export const TodoPriority = {
  High: "high",
  Medium: "medium",
  Low: "low",
} as const;

export type TodoPriority = (typeof TodoPriority)[keyof typeof TodoPriority];

export const TodoItemSchema = z.object({
  content: z.string().min(1).describe("Brief description of the task"),
  status: z.enum(["pending", "in_progress", "completed"]).describe("Current status of the task"),
  priority: z.enum(["high", "medium", "low"]).describe("Priority level of the task"),
  // D4 依赖字段（specs/todo-dependency-fields.md R1/R2）：三个键从「被 strip」变成「被解析」，
  // 仍未知的键继续 strip（不加 .strict()——既有客户端多带一个键不应让整次 TodoWrite 失败，R5）。
  id: TodoIdSchema.optional().describe(
    "Stable id, unique within the list; items without one get a position-derived id (todo-<index>) in the stored and returned list",
  ),
  blockedBy: TodoBlockedBySchema.optional().describe(
    "Ids in this same submitted list that must complete before this item can start; each referenced item must carry an explicit id",
  ),
  metadata: TodoMetadataSchema.optional().describe(
    // F3（审计 2026-10-03 登记项）：上界数字由 todo-deps 常量插值渲染，结构上杜绝
    // 「常量改了、文本还写死旧数」的漂移；渲染结果与原硬编码文本逐字节相同。
    `Bounded annotation object (max ${TODO_METADATA_MAX_KEYS} keys, ${TODO_METADATA_MAX_KEY_CHARS}-char keys, ${TODO_METADATA_MAX_SERIALIZED_BYTES / 1024} KB serialized, JSON values only); pure annotation, never affects scheduling or counts`,
  ),
  // J2-1（specs/todo-confidence-semantics.md R1）：可选完成证据状态。四级语义进 describe
  // （枚举成员在 JSON schema 天然可见，语义描述不等于门槛披露）；哪个值过完成门槛是
  // 实现细节，不出现在任何模型可见文案里（R3/R6 保密规则）。
  completionConfidence: TodoCompletionConfidenceSchema.optional().describe(
    "Evidence state behind this item's completion, reported from what you actually observed: speculative (unexamined guess), plausible (reasoned but not yet checked), validated (checked against direct evidence), verified (reproduced end to end)",
  ),
});

/**
 * J2-1 存储/域形状（specs/todo-confidence-semantics.md R4）：可写面 + 工具自有
 * confidenceHistory。history **不是** TodoItemSchema 的成员——模型自报的 history 被 zod
 * 默认 strip 静默丢弃（任何形状都不报错，R2「只出不进」的类型级表达）；工具在 handler
 * 唯一写入路径上追加（每项每次写入最多一条观测）。
 */
export const StoredTodoItemSchema = TodoItemSchema.extend({
  confidenceHistory: z
    .array(TodoCompletionConfidenceSchema)
    .max(TODO_CONFIDENCE_HISTORY_MAX)
    .optional()
    .describe(
      "Tool-owned append-only trail of completionConfidence observations, oldest first; any submitted value is ignored",
    ),
});

/**
 * 域类型 = 存储形状（D4「TodoItem 变宽、端口签名形状不变」同款手法）：
 * session-store 端口、codecs、session-mapper 等消费方零改动自动兼容（可选成员加宽
 * 对读写两个方向都结构兼容）。模型可写面是 z.infer<TodoItemSchema>（不含 history）。
 */
export type TodoItem = z.infer<typeof StoredTodoItemSchema>;

/**
 * R4 输出视图：存储形状 + 派生布尔 available（pending 且未被阻塞）。
 * 只出现在输出 schema——不进 TodoItemSchema 写入面、不是第二份状态，
 * 每次读取/写入时从当次列表重算。
 */
export const TodoItemViewSchema = StoredTodoItemSchema.extend({
  available: z
    .boolean()
    .describe("Derived: pending and unblocked (no blockedBy left, or every referenced item completed)"),
});

export type TodoItemView = z.infer<typeof TodoItemViewSchema>;

export const TodoReadInputSchema = z.object({}).strict();
export type TodoReadInput = z.infer<typeof TodoReadInputSchema>;

export const TodoReadInputJsonSchema = toToolJsonSchema(TodoReadInputSchema);

export interface TodoReadOutput {
  todos: TodoItemView[];
}

export const TodoReadOutputSchema = z
  .object({
    todos: z.array(TodoItemViewSchema),
  })
  .strict();

export type ParsedTodoReadOutput = z.infer<typeof TodoReadOutputSchema>;

export const TodoReadOutputJsonSchema = toToolJsonSchema(TodoReadOutputSchema);

export const TodoWriteInputSchema = z
  .object({
    todos: z
      .array(TodoItemSchema)
      .describe("The complete updated todo list. At most one item may be in_progress at a time."),
  })
  .strict()
  // D4（specs/todo-dependency-fields.md R1/R2/R3）：写入合法性的唯一判定点——
  // id 列表内唯一（含显式 id 与派生 id 撞车）、blockedBy 只解析到同批显式 id（悬空即报错）、
  // 成环即时报错并点名环上的 id 序列、metadata 上界超限报错不截断。
  // 不恢复「恰一个 in_progress」硬约束（下方注释块保持原样）。
  .superRefine((input, context) => {
    for (const issue of validateTodoList(input.todos)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: issue.message,
        path: issue.path,
      });
    }
  });
// 多 subagent / 并行任务下需要允许多个 in_progress，旧的 schema 硬拒绝会让
// TodoWrite 失败并触发后续调度组被跳过；先整段注释保留，便于回滚或对比。
// .superRefine((input, context) => {
//   const inProgressCount = input.todos.filter((todo) => todo.status === "in_progress").length;
//   if (inProgressCount <= 1) return;
//   context.addIssue({
//     code: z.ZodIssueCode.custom,
//     message: "At most one todo can be in_progress",
//     path: ["todos"],
//   });
// });

export type TodoWriteInput = z.infer<typeof TodoWriteInputSchema>;

export const TodoWriteInputJsonSchema = toToolJsonSchema(TodoWriteInputSchema);

export interface TodoSummary {
  total: number;
  pending: number;
  inProgress: number;
  completed: number;
  /** R4(i)：pending 且未被阻塞的项数——与逐项 available 布尔的计数恒一致。 */
  available: number;
}

export interface TodoWriteOutput {
  oldTodos: TodoItemView[];
  todos: TodoItemView[];
  summary: TodoSummary;
}

export const TodoSummarySchema = z
  .object({
    total: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
    inProgress: z.number().int().nonnegative(),
    completed: z.number().int().nonnegative(),
    available: z.number().int().nonnegative(),
  })
  .strict();

export const TodoWriteOutputSchema = z
  .object({
    oldTodos: z.array(TodoItemViewSchema),
    todos: z.array(TodoItemViewSchema),
    summary: TodoSummarySchema,
  })
  .strict();

export type ParsedTodoWriteOutput = z.infer<typeof TodoWriteOutputSchema>;

export const TodoWriteOutputJsonSchema = toToolJsonSchema(TodoWriteOutputSchema);

export interface TodoReadToolCall {
  id: ToolCallId;
  name: "TodoRead";
  input: TodoReadInput;
  traceId: TraceId;
  startedAt: Date;
}

export interface TodoWriteToolCall {
  id: ToolCallId;
  name: "TodoWrite";
  input: TodoWriteInput;
  traceId: TraceId;
  startedAt: Date;
}

export function isTodoToolName(value: string | undefined): value is "TodoRead" | "TodoWrite" {
  return value === "TodoRead" || value === "TodoWrite";
}

/**
 * 从工具结果 JSON 里提取 todo 列表。宽容解析：只要求顶层 `todos` 数组，元素按
 * 存储形状解析（strip 掉 available 等输出视图字段）——同一函数因此同时接受
 * D4 之前（三字段）、D4 之后（含 id/blockedBy/metadata/available）与 J2-1 之后
 * （含 completionConfidence/confidenceHistory）的历史结果形状。元素 history **不带
 * max(TODO_CONFIDENCE_HISTORY_MAX)**：窗口上限是存储不变量而不是解析不变量，
 * 未来版本放宽窗口后回滚，历史结果仍可解析。当前仓库内无调用方（knip 基线内保留的
 * 公开契约助手）。
 */
const TodoResultContentSchema = z.object({
  todos: z.array(
    TodoItemSchema.extend({
      confidenceHistory: z.array(TodoCompletionConfidenceSchema).optional(),
    }),
  ),
});

export function todoItemsFromToolResultContent(content: string): TodoItem[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return undefined;
  }

  const result = TodoResultContentSchema.safeParse(parsed);
  if (!result.success) {
    return undefined;
  }
  return cloneTodos(result.data.todos);
}

export function formatTodoStateForModel(todos: readonly TodoItem[]): string {
  if (todos.length === 0) {
    return "";
  }

  return [
    "Current session todo state (authoritative):",
    ...todos.map(
      (todo, index) => `${index + 1}. [${todo.status}][${todo.priority}] ${todo.content}`,
    ),
  ].join("\n");
}

function cloneTodos(todos: readonly TodoItem[]): TodoItem[] {
  return todos.map((todo) => ({ ...todo }));
}
