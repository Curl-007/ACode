// DeferredToolCall 包装的 TodoWrite 投影验收（apps/acode-cli/specs/tool-search.md R6
// 「V4/UI 以目标事件定稿工具行」+ packages/ui/specs/todo-displacement.md 任务清单）。
//
// 根因：tool-search local 模式下，模型经 DeferredToolCall({name:"TodoWrite", input}) 调用
// deferred 工具。tool_call_scheduled 与流式 tool_input_start/tool_call 携带的是**包装名**
// DeferredToolCall 与 {name, input} 包装入参；只有 ToolCallStarted（准入通过后由
// canonicalToolCall 发出）携带**目标工具名** TodoWrite。此前 ProductProjection 从不把行
// 收敛到目标身份：TodoWrite 的任务清单卡停在 raw fallback（identity=DeferredToolCall，
// family≠todo），plan 面板也拿不到 steps（isTodoPlanToolName("DeferredToolCall")=false），
// 即「直连调用序列化错了 + 任务清单失败」两条同链路症状。
//
// 本测试用真 ProductProjection 驱动完整事件链（scheduled→started→result），对照直接调用
// 与包装调用：修复后两条链路的 row.toolName、row.input 与 plan 投影逐字节一致。
import assert from "node:assert/strict";
import test from "node:test";

const { ProductProjection } =
  await import("../packages/bootstrap/src/acode-protocol-v4/product-projection.ts");

const SID = "sess-deferred-todo-projection";
const TODOS = {
  todos: [
    { content: "Inspect the implementation", status: "in_progress", priority: "high" },
    { content: "Write the fix", status: "pending", priority: "medium" },
  ],
};
// TodoWrite handler 的成功输出形状（oldTodos/todos/summary）——result 路径据此二次投影 plan。
const TODO_OUTPUT = JSON.stringify({
  oldTodos: [],
  todos: [
    { content: "Inspect the implementation", status: "in_progress", priority: "high", available: false },
    { content: "Write the fix", status: "pending", priority: "medium", available: true },
  ],
  summary: { total: 2, pending: 1, inProgress: 1, completed: 0, available: 1 },
});

let seq = 0;
const ev = (type, payload) => ({
  id: `ev-${++seq}`,
  sessionId: SID,
  type,
  timestamp: new Date(),
  traceId: "trace-deferred-todo",
  sequenceNumber: seq,
  payload,
});

function driveLifecycle(scheduledToolName, scheduledInput, startedToolName) {
  const projection = new ProductProjection(SID, "epoch-deferred-todo");
  projection.applyEvent(
    ev("turn_started", {
      turnId: "turn-1",
      turnNumber: 1,
      transcriptMessageId: "user-1",
      messageId: "msg-user-1",
      input: "Track my work",
    }),
  );
  projection.applyEvent(
    ev("tool_call_scheduled", {
      assistantMessageId: "msg-a1",
      input: scheduledInput,
      toolCallId: "tc-todo-1",
      toolName: scheduledToolName,
    }),
  );
  const started = projection.applyEvent(
    ev("tool_call_started", {
      toolCallId: "tc-todo-1",
      // ToolCallStarted 携带目标工具名（准入通过后 canonicalToolCall 发出）。
      toolName: startedToolName,
      startedAt: new Date(),
    }),
  );
  const result = projection.applyEvent(
    ev("tool_call_result", {
      toolCallId: "tc-todo-1",
      result: { success: true, content: TODO_OUTPUT },
      duration: 5,
    }),
  );
  return { projection, started, result };
}

function lastToolCallRow(deltas) {
  const rows = deltas.filter((d) => d.op === "row.upserted" && d.row.kind === "toolCall");
  return rows.length > 0 ? rows[rows.length - 1].row : undefined;
}

function planItemsFrom(deltas) {
  const planDelta = deltas.find((d) => d.op === "state.updated" && d.patch.plan);
  return planDelta?.patch?.plan?.items ?? null;
}

test("直接调用 TodoWrite：行名/入参/plan 全程为 TodoWrite（回归基线，防修复误伤直连）", () => {
  const { started, result } = driveLifecycle("TodoWrite", TODOS, "TodoWrite");
  const startedRow = lastToolCallRow(started);
  assert.equal(startedRow?.toolName, "TodoWrite");
  assert.deepEqual(startedRow?.input, TODOS);
  const resultRow = lastToolCallRow(result);
  assert.equal(resultRow?.toolName, "TodoWrite");
  // 直接调用的 plan 在 scheduled(input) 与 result(output) 两处都产出；result 段在场即可。
  assert.ok(planItemsFrom(result), "direct path must project a plan on result");
});

test("包装调用 DeferredToolCall(TodoWrite)：started 定稿为目标名、解包入参、投影 plan", () => {
  const wrapped = { name: "TodoWrite", input: TODOS };
  const { started, result } = driveLifecycle("DeferredToolCall", wrapped, "TodoWrite");

  // started 事件必须把行从包装身份定稿到目标工具身份（R6「以目标事件定稿工具行」）。
  const startedRow = lastToolCallRow(started);
  assert.equal(startedRow?.toolName, "TodoWrite", "started must finalize the row to the target tool");
  assert.deepEqual(startedRow?.input, TODOS, "wrapper {name,input} must be unwrapped to inner input");
  assert.equal(
    startedRow?.inputText,
    JSON.stringify(TODOS),
    "inputText must stay in sync with the unwrapped input",
  );
  // started 阶段即产出 live plan（此前包装名下 isTodoPlanToolName 返回 false → 无 plan）。
  const startedPlan = planItemsFrom(started);
  assert.ok(startedPlan, "started must project the todo plan once the row is finalized");
  assert.equal(startedPlan.length, 2);
  assert.deepEqual(
    startedPlan.map((item) => item.status),
    ["inProgress", "pending"],
  );

  // result 阶段用已定稿的目标名二次投影（output.todos 路径），与直接调用同形。
  const resultRow = lastToolCallRow(result);
  assert.equal(resultRow?.toolName, "TodoWrite");
  assert.ok(planItemsFrom(result), "result must keep projecting the plan under the target name");
});

test("准入失败：ToolCallStarted 不发（无目标名），包装失败记录原样保留（R6）", () => {
  // 准入失败路径 executor 直接发 ToolCallError，不发 ToolCallStarted；投影行保持包装身份，
  // 不得被伪定稿成一个从未成功调用的目标工具。
  const wrapped = { name: "TodoWrite", input: TODOS };
  const projection = new ProductProjection(SID, "epoch-deferred-todo-deny");
  projection.applyEvent(
    ev("turn_started", {
      turnId: "turn-1",
      turnNumber: 1,
      transcriptMessageId: "user-1",
      messageId: "msg-user-1",
      input: "go",
    }),
  );
  projection.applyEvent(
    ev("tool_call_scheduled", {
      assistantMessageId: "msg-a1",
      input: wrapped,
      toolCallId: "tc-deny-1",
      toolName: "DeferredToolCall",
    }),
  );
  const errorDeltas = projection.applyEvent(
    ev("tool_call_error", {
      toolCallId: "tc-deny-1",
      error: { type: "tool_not_found", message: "not a deferred tool" },
    }),
  );
  const errorRow = lastToolCallRow(errorDeltas);
  assert.equal(errorRow?.toolName, "DeferredToolCall", "denied wrapper record must stay wrapped");
  assert.equal(errorRow?.status, "error");
});
