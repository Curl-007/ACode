// Todo 原地置换（specs/todo-displacement.md）：投影层预扫描计算置换集，
// WeakMap 侧信道（row 对象身份键）把锚点计数传给 legacy 桥接——v4 row 是协议
// 数据不可变异；row 修订换新对象时侧信道自然失效，与 useMemo([row]) 桥接同节奏。
import type { ToolCallRow } from "@acode/shared/acode-protocol-v4";
import { resolveToolCallIdentity } from "@/lib/toolIdentity.js";
import type { AssistantWorkRow } from "@/v4/conversationTurnRenderUnits.js";

/** 当前板锚点资格：成功或仍在形成的板（R1）。error/cancelled 永不作锚、永不被置换。 */
const LIVE_TODO_ROW_STATUSES = new Set(["success", "running", "inputStreaming", "pendingApproval"]);

const todoSupersededCounts = new WeakMap<object, number>();

export function setTodoSupersededCount(row: ToolCallRow, count: number): void {
  todoSupersededCounts.set(row, count);
}

export function getTodoSupersededCount(row: unknown): number | undefined {
  if (typeof row !== "object" || row === null) return undefined;
  const value = todoSupersededCounts.get(row);
  return typeof value === "number" && value > 0 ? value : undefined;
}

function isTodoToolCallRow(row: AssistantWorkRow): row is ToolCallRow {
  if (row.kind !== "toolCall") return false;
  // identity 判定与 resolveRenderer 的 "todo" family 同源（TodoWrite 及 legacy 变体名）。
  return resolveToolCallIdentity({ kind: row.toolName, input: row.input }).family === "todo";
}

export interface TodoDisplacementPlan {
  /** 被置换（不渲染）的 todo 行 rowId 集合。 */
  displacedRowIds: ReadonlySet<number>;
  /** 锚点行与其置换计数（单 turn 至多一个锚点）。 */
  anchor?: { row: ToolCallRow; count: number };
}

/** 纯函数预扫描：锚点 = 最后一个 success/live todo 行；被置换 = 锚点前的 success 行（R1/R4）。 */
export function computeTodoDisplacement(rows: readonly AssistantWorkRow[]): TodoDisplacementPlan {
  const todoRows = rows.filter(isTodoToolCallRow);
  if (todoRows.length < 2) return { displacedRowIds: new Set() };

  let anchorIndex = -1;
  for (let index = todoRows.length - 1; index >= 0; index -= 1) {
    if (LIVE_TODO_ROW_STATUSES.has(todoRows[index]!.status)) {
      anchorIndex = index;
      break;
    }
  }
  // 无锚点（全 error/cancelled）或锚点即首行：没有可置换的前置成功板。
  if (anchorIndex <= 0) return { displacedRowIds: new Set() };

  const displacedRowIds = new Set<number>();
  for (let index = 0; index < anchorIndex; index += 1) {
    const row = todoRows[index]!;
    if (row.status === "success") displacedRowIds.add(row.rowId);
  }
  if (displacedRowIds.size === 0) return { displacedRowIds };
  return { displacedRowIds, anchor: { row: todoRows[anchorIndex]!, count: displacedRowIds.size } };
}
