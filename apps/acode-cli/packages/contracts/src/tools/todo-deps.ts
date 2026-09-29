// ============================================================
// Todo dependency fields - pure validation & derivation (D4)
// ============================================================
// specs/todo-dependency-fields.md R1–R4：规范化（铸派生 id）、环检测、available 派生，
// 以及写入合法性规则（id 唯一性 / 悬空引用 / 派生 id 引用 / metadata 上界）。
// 单一实现，两处共享：TodoWriteInputSchema.superRefine（写入合法性唯一判定点）与
// core handler 的输出投影（依赖方向 core→contracts 允许共享，反向不允许——这正是
// 本文件落在 contracts 而不是 core 的原因，见 spec 实施记录）。
// 全部纯函数：不读时钟、不做 I/O、不读 DB（R3 对纯包的同款纪律）。

import { z } from "zod";
import type { TodoItem } from "./todo.js";

// —— 命名常量（spec R2「常量归口」；物理家在本文件以避免与 todo.ts 的运行时循环导入，
//    todo.ts 对消费方原样再导出，导出面与 spec「接口」节一致）——

/** 稳定 id 与 blockedBy 引用的长度上界（与 ARTIFACT_CAPS.maxIdLength 同量级：进 journal/DB/提示词，必须有界）。 */
export const TODO_ID_MAX_CHARS = 64;
/** 单项 blockedBy 引用条数上界（防一个项把整张表当成自己的前驱）。 */
export const TODO_BLOCKED_BY_MAX_ITEMS = 32;
/** metadata 键数上界。 */
export const TODO_METADATA_MAX_KEYS = 16;
/** metadata 单个键的长度上界。 */
export const TODO_METADATA_MAX_KEY_CHARS = 64;
/** metadata 规范化 JSON 序列化后的字节上界（超限报错，绝不截断——截断把悄悄残缺的数据交给消费者）。 */
export const TODO_METADATA_MAX_SERIALIZED_BYTES = 4 * 1024;

export const TodoIdSchema = z.string().min(1).max(TODO_ID_MAX_CHARS);
export const TodoBlockedBySchema = z.array(TodoIdSchema).max(TODO_BLOCKED_BY_MAX_ITEMS);
export const TodoMetadataSchema = z.record(z.string(), z.unknown());

/**
 * deps_json 持久化列的形状（adapters 编解码共用）：只存规范化后的三个可选成员。
 * strict：未来新成员必须由新版本代码显式加宽，旧代码 safeParse 失败即整列忽略
 * （= spec R5 的回滚策略「忽略该列」）。
 */
export const TodoDepsJsonSchema = z
  .object({
    id: TodoIdSchema.optional(),
    blockedBy: TodoBlockedBySchema.optional(),
    metadata: TodoMetadataSchema.optional(),
  })
  .strict();

export type TodoDepsJson = z.infer<typeof TodoDepsJsonSchema>;

/** 规范化后的 todo：id 必在（显式保留，缺席按数组下标铸 todo-<index>）。 */
export type NormalizedTodo = TodoItem & { id: string };

/**
 * 派生 id 的铸法：与 packages/services/.../acodeTaskServiceAdapter.ts 的既有 UI 投影
 * `todo-${index}` 逐字同形（spec R1）——两边算出的 id 一致，不产生第二套 id 词汇。
 */
export function derivedTodoId(index: number): string {
  return `todo-${index}`;
}

/** R1 规范化：有显式 id 原样保留；缺 id 按数组下标铸派生 id。纯函数，输入不可变。 */
export function normalizeTodos(todos: readonly TodoItem[]): NormalizedTodo[] {
  return todos.map((todo, index) => ({ ...todo, id: todo.id ?? derivedTodoId(index) }));
}

/**
 * R3 环检测：每项为节点、blockedBy 为出边（item → 它等待的 id），检测有向环（含自引用）。
 * 返回环上的 id 序列（首尾同一 id，例 ["a","b","a"]），供错误消息点名 `a → b → a`。
 * 前置条件：id 列表内唯一（唯一性校验先行）；悬空引用在 byId 查不到即断边，不参与成环。
 * 迭代 DFS（显式栈），输入顺序确定性遍历，不依赖递归深度。
 */
export function detectTodoCycle(
  todos: readonly NormalizedTodo[],
): { cycle: string[] } | undefined {
  const byId = new Map<string, NormalizedTodo>();
  for (const todo of todos) {
    byId.set(todo.id, todo);
  }
  const done = new Set<string>();
  for (const start of todos) {
    if (done.has(start.id)) continue;
    const path: NormalizedTodo[] = [];
    const onPath = new Set<string>();
    const stack: Array<{ todo: NormalizedTodo; edge: number }> = [{ todo: start, edge: 0 }];
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const { todo } = frame;
      if (frame.edge === 0) {
        if (onPath.has(todo.id)) {
          const from = path.findIndex((item) => item.id === todo.id);
          return { cycle: [...path.slice(from).map((item) => item.id), todo.id] };
        }
        if (done.has(todo.id)) {
          stack.pop();
          continue;
        }
        onPath.add(todo.id);
        path.push(todo);
      }
      const refs = todo.blockedBy ?? [];
      if (frame.edge < refs.length) {
        const next = byId.get(refs[frame.edge]);
        frame.edge += 1;
        if (next && !done.has(next.id)) {
          stack.push({ todo: next, edge: 0 });
        }
        continue;
      }
      stack.pop();
      onPath.delete(todo.id);
      path.pop();
      done.add(todo.id);
    }
  }
  return undefined;
}

/**
 * R4 available 派生：`pending` 且（blockedBy 缺席/为空，或其引用的每一项在本次列表里
 * `completed`——指向已完成项的依赖视为已解除）。in_progress/completed 永不 available。
 * 引用解析不到（写入合法性校验后不可达；防御历史/手搓数据）按未解除处理。
 * 派生只读投影：不落库、不进 journal、不跨调用缓存。
 */
export function computeAvailable(todos: readonly NormalizedTodo[]): boolean[] {
  const byId = new Map<string, NormalizedTodo>();
  for (const todo of todos) {
    byId.set(todo.id, todo);
  }
  return todos.map((todo) => {
    if (todo.status !== "pending") return false;
    const refs = todo.blockedBy ?? [];
    return refs.every((ref) => byId.get(ref)?.status === "completed");
  });
}

/** 供 superRefine 使用的结构化问题：path 相对 TodoWriteInput 根（例 ["todos", 2, "blockedBy"]）。 */
export interface TodoListIssue {
  path: (string | number)[];
  message: string;
}

/**
 * R1/R2/R3 的整表写入合法性判定（superRefine 的唯一实现）。
 * 顺序有意义：metadata 上界逐项独立报；唯一性失败后跳过引用解析与环检测
 * （id 撞车时后续判定是噪音）；引用解析失败不阻断环检测（悬空边自然断掉）。
 */
export function validateTodoList(items: readonly TodoItem[]): TodoListIssue[] {
  const issues: TodoListIssue[] = [];

  items.forEach((item, index) => {
    if (item.metadata !== undefined) {
      issues.push(...validateTodoMetadata(item.metadata, ["todos", index, "metadata"]));
    }
  });

  const normalized = normalizeTodos(items);
  const explicitIds = new Map<string, number>();
  const derivedOwners = new Map<string, number>();
  let idsUnique = true;
  normalized.forEach((todo, index) => {
    const explicit = items[index].id !== undefined;
    const explicitCollision = explicitIds.get(todo.id);
    const derivedCollision = derivedOwners.get(todo.id);
    if (explicitCollision !== undefined || derivedCollision !== undefined) {
      idsUnique = false;
      if (explicit && derivedCollision !== undefined) {
        // 责任在显式 id：派生 id 由位置决定，作者唯一能改的是显式 id。
        issues.push({
          path: ["todos", index, "id"],
          message: `explicit id "${todo.id}" collides with the position-derived id of todos[${derivedCollision}]; pick a different explicit id`,
        });
      } else if (!explicit && explicitCollision !== undefined) {
        issues.push({
          path: ["todos", explicitCollision, "id"],
          message: `explicit id "${todo.id}" of todos[${explicitCollision}] collides with the position-derived id of todos[${index}]; pick a different explicit id`,
        });
      } else {
        issues.push({
          path: ["todos", index, "id"],
          message: `todo id "${todo.id}" is used by todos[${explicitCollision ?? derivedCollision}] and todos[${index}]; ids must be unique within the list`,
        });
      }
      return;
    }
    (explicit ? explicitIds : derivedOwners).set(todo.id, index);
  });

  if (!idsUnique) {
    return issues;
  }

  // R1：blockedBy 只解析到本次提交的显式 id——引用派生 id 等于让作者猜规范化结果。
  items.forEach((item, index) => {
    for (const ref of item.blockedBy ?? []) {
      if (explicitIds.has(ref)) continue;
      const derivedOwner = derivedOwners.get(ref);
      issues.push({
        path: ["todos", index, "blockedBy"],
        message:
          derivedOwner !== undefined
            ? `todos[${index}].blockedBy references "${ref}", which is only the position-derived id of todos[${derivedOwner}]; give the referenced item an explicit id`
            : `todos[${index}].blockedBy references unknown id "${ref}"; blockedBy resolves only against ids in the same submitted list`,
      });
    }
  });

  const cycle = detectTodoCycle(normalized);
  if (cycle) {
    issues.push({
      path: ["todos"],
      message: `blockedBy forms a dependency cycle: ${cycle.cycle.join(" → ")}; remove one of the edges`,
    });
  }

  return issues;
}

/** R2：metadata 上界与 JSON 可序列化性。超限报错、不截断。 */
function validateTodoMetadata(metadata: unknown, path: (string | number)[]): TodoListIssue[] {
  const issues: TodoListIssue[] = [];
  const keys = Object.keys(metadata as Record<string, unknown>);
  if (keys.length > TODO_METADATA_MAX_KEYS) {
    issues.push({
      path,
      message: `metadata has ${keys.length} keys, exceeding the ${TODO_METADATA_MAX_KEYS}-key cap (rejected, not truncated)`,
    });
  }
  for (const key of keys) {
    if (key.length > TODO_METADATA_MAX_KEY_CHARS) {
      issues.push({
        path,
        message: `metadata key of ${key.length} chars exceeds the ${TODO_METADATA_MAX_KEY_CHARS}-char key cap`,
      });
      break;
    }
  }

  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(metadata);
  } catch {
    // 循环引用 / BigInt 等 JSON.stringify 直接抛错的值。
    issues.push({
      path,
      message: "metadata must be JSON-serializable (circular structures and BigInt are rejected)",
    });
    return issues;
  }
  if (serialized === undefined) {
    issues.push({ path, message: "metadata must be a JSON object" });
    return issues;
  }
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes > TODO_METADATA_MAX_SERIALIZED_BYTES) {
    issues.push({
      path,
      message: `metadata serializes to ${bytes} bytes, exceeding the ${TODO_METADATA_MAX_SERIALIZED_BYTES}-byte cap (rejected, not truncated)`,
    });
  }

  // stringify 成功即结构无环，可安全深走查：函数 / undefined / 非有限数 / Date /
  // 类实例（Map、Set、promise…）一律拒绝——stringify 会静默丢弃或改写它们（R2）。
  const nonJsonPath = findNonJsonMemberPath(metadata, "metadata");
  if (nonJsonPath !== undefined) {
    issues.push({
      path,
      message: `metadata contains a non-JSON value at ${nonJsonPath} (plain object/array/string/finite number/boolean/null only; functions, undefined, NaN, Date and class instances are rejected)`,
    });
  }
  return issues;
}

function findNonJsonMemberPath(value: unknown, path: string): string | undefined {
  if (value === null) return undefined;
  if (typeof value === "string" || typeof value === "boolean") return undefined;
  if (typeof value === "number") return Number.isFinite(value) ? undefined : path;
  if (typeof value !== "object") return path; // function / symbol / bigint / undefined
  if (value instanceof Date) return path;
  if (Array.isArray(value)) {
    for (const [index, member] of value.entries()) {
      const found = findNonJsonMemberPath(member, `${path}[${index}]`);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return path; // 类实例一律拒绝
  for (const [key, member] of Object.entries(value)) {
    const found = findNonJsonMemberPath(member, `${path}.${key}`);
    if (found !== undefined) return found;
  }
  return undefined;
}
