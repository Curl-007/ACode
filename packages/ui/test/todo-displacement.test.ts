// Todo 原地置换（specs/todo-displacement.md）验收：R1 锚点/置换集纯函数语义 +
// R2 投影→WeakMap→legacy 桥接的计数传递 + 被置换行不产生 items。
import assert from "node:assert/strict";
import { test } from "node:test";
import { computeTodoDisplacement } from "../src/v4/todoDisplacement.js";
import { buildAssistantWorkRenderItems } from "../src/v4/conversationAssistantWorkItems.js";
import { toolCallRowToLegacyNode } from "../src/v4/toolCallRowAdapter.js";
import type { ToolCallRow } from "@acode/shared/acode-protocol-v4";

const VISIBILITY = {
  messageStreamShowReasoning: true,
  messageStreamFirstReasoningRowId: undefined,
} as const;

let nextRowId = 1000;
function todoRow(status: string): ToolCallRow {
  const rowId = nextRowId++;
  return {
    kind: "toolCall",
    rowId,
    turnId: 1,
    toolCallId: `todo-${rowId}`,
    toolName: "TodoWrite",
    status,
    inputText: "{}",
    input: { todos: [{ content: "step", status: "pending", priority: "high" }] },
  } as unknown as ToolCallRow;
}

function readRow(path: string): ToolCallRow {
  const rowId = nextRowId++;
  return {
    kind: "toolCall",
    rowId,
    turnId: 1,
    toolCallId: `read-${rowId}`,
    toolName: "Read",
    status: "success",
    inputText: "{}",
    input: { file_path: path },
  } as unknown as ToolCallRow;
}

test("(场景1) 三次成功 TodoWrite：置换前两张，锚点=最后一张 count=2", () => {
  const [t1, t2, t3] = [todoRow("success"), todoRow("success"), todoRow("success")];
  const plan = computeTodoDisplacement([t1!, t2!, t3!]);
  assert.deepEqual([...plan.displacedRowIds].sort(), [t1!.rowId, t2!.rowId].sort());
  assert.equal(plan.anchor?.row.rowId, t3!.rowId);
  assert.equal(plan.anchor?.count, 2);
});

test("(场景2) S S E S：error 行不被置换，锚点=末张成功板 count=2", () => {
  const rows = [todoRow("success"), todoRow("success"), todoRow("error"), todoRow("success")];
  const plan = computeTodoDisplacement(rows);
  assert.equal(plan.displacedRowIds.size, 2);
  assert.equal(plan.displacedRowIds.has(rows[2]!.rowId), false);
  assert.equal(plan.anchor?.row.rowId, rows[3]!.rowId);
});

test("(场景3) 末行 running：锚点为运行中板，前置成功板全部置换", () => {
  const rows = [todoRow("success"), todoRow("success"), todoRow("running")];
  const plan = computeTodoDisplacement(rows);
  assert.equal(plan.anchor?.row.rowId, rows[2]!.rowId);
  assert.equal(plan.anchor?.count, 2);
});

test("(场景4) 单张 todo / 全 error / 锚点即首行：无置换无锚点计数", () => {
  assert.equal(computeTodoDisplacement([todoRow("success")]).displacedRowIds.size, 0);
  const allErrors = computeTodoDisplacement([todoRow("error"), todoRow("error")]);
  assert.equal(allErrors.displacedRowIds.size, 0);
  assert.equal(allErrors.anchor, undefined);
  const anchorFirst = computeTodoDisplacement([todoRow("success"), todoRow("error")]);
  assert.equal(anchorFirst.displacedRowIds.size, 0);
  assert.equal(anchorFirst.anchor, undefined);
});

test("(场景5/7) 投影集成：被置换行不产生 items；非 todo 行不受影响", () => {
  const rows = [readRow("/a.ts"), todoRow("success"), todoRow("success"), readRow("/b.ts")];
  const items = buildAssistantWorkRenderItems(rows, VISIBILITY);
  // Read 行两张（不相邻同类不折叠——中间隔着 todo）+ todo 锚点一张 = 3 items
  assert.equal(items.length, 3);
  const rowItems = items.filter((item) => item.kind === "row");
  assert.equal(rowItems.length, 3);
  const todoItems = rowItems.filter(
    (item) => item.kind === "row" && (item.row as ToolCallRow).toolName === "TodoWrite",
  );
  assert.equal(todoItems.length, 1);
});

test("(R2) 桥接：投影登记后 legacy toolCall 携带 todoSupersededCount；未登记行缺席", () => {
  const rows = [todoRow("success"), todoRow("success"), todoRow("success")];
  buildAssistantWorkRenderItems(rows, VISIBILITY);
  const anchorNode = toolCallRowToLegacyNode(rows[2]!);
  assert.equal(anchorNode.toolCall.todoSupersededCount, 2);
  const freshNode = toolCallRowToLegacyNode(todoRow("success"));
  assert.equal(freshNode.toolCall.todoSupersededCount, undefined);
});
