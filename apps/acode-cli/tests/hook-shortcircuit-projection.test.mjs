// middleware 短路的 hook invocation row 收口 + hookCount 精确化
// （apps/acode-cli/specs/plugin-hook-middleware.md 一.6 / 接线 W1）。
//
// hookCount 是链入口预扫描值；middleware 不调 next 自答短路时下游环节零事件，
// executions.length < hookCount 永久成立。接线后：成功轮末把「全部已记录 execution
// 到终态但数量不足预扫描值」的本轮 row 收口为终态并把 hookCount 精确化为实际发事件
// 环节数；cancelled/error 轮维持 SessionResumed 强制 failed 的既有 fail-closed 语义
// （中断与短路在事件面不可区分，不得误标 completed）；在飞 execution（async 环节）
// 不满足谓词，照常等待自己的终态事件。
import assert from "node:assert/strict";
import test from "node:test";

const { ProductProjection } =
  await import("../packages/bootstrap/src/acode-protocol-v4/product-projection.ts");

const SID = "sess-hook-shortcircuit";

let seq = 0;
const ev = (type, payload, extra = {}) => ({
  id: `ev-${++seq}`,
  sessionId: SID,
  type,
  timestamp: new Date(1_700_000_000_000 + ++seq * 1_000),
  traceId: "trace-hook-shortcircuit",
  sequenceNumber: seq,
  payload,
  ...extra,
});

const DESCRIPTOR = {
  clientVisible: true,
  commandDisplay: "node hooks/guard.mjs",
  executionMode: "foreground",
  executionType: "command",
  sourceKind: "project",
  timeoutMs: 60_000,
};

function hookPayload(overrides) {
  return {
    descriptor: DESCRIPTOR,
    hookCount: 2,
    hookEventName: "PreToolUse",
    hookIndex: 0,
    hookInvocationId: "inv-1",
    hookRunId: "run-1",
    startedAt: 1_700_000_000_000,
    toolCallId: "tc-1",
    toolName: "Bash",
    ...overrides,
  };
}

function driveShortCircuit(resultType) {
  const projection = new ProductProjection(SID, "epoch-hook-shortcircuit");
  const deltas = [];
  deltas.push(
    ...projection.applyEvent(
      ev("turn_started", {
        turnId: "turn-1",
        turnNumber: 1,
        transcriptMessageId: "user-1",
        messageId: "msg-user-1",
        input: "run the guarded tool",
      }),
    ),
  );
  // middleware 环节（hookIndex 0）启动并完成；下游环节（hookIndex 1）被短路，零事件。
  deltas.push(
    ...projection.applyEvent(ev("hook_run_started", hookPayload({}), { turnId: "turn-1" })),
  );
  deltas.push(
    ...projection.applyEvent(
      ev(
        "hook_run_completed",
        hookPayload({ durationMs: 12, outcome: "success" }),
        { turnId: "turn-1" },
      ),
    ),
  );
  deltas.push(...projection.applyEvent(ev("turn_complete", { resultType }), { turnId: "turn-1" }));
  const rows = projection
    .getSnapshot()
    .rows.window.filter((row) => row.kind === "hookInvocation");
  return { deltas, rows };
}

test("成功轮末：短路 invocation row 收口为 completed，hookCount 精确化为实际发事件环节数", () => {
  const { rows } = driveShortCircuit("success");
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.state, "completed", "短路链在成功轮末没有收口：row 停在 running 等 resume 误报 failed");
  assert.equal(row.hookCount, 1, "hookCount 没有精确化：仍是预扫描值 2，UI 会永远等待缺席的环节");
  assert.equal(row.executions.length, 1);
  assert.equal(row.executions[0].state, "completed");
  assert.ok(Number.isFinite(row.durationMs), "收口 row 必须带 durationMs");
  assert.ok(row.endedAt >= row.startedAt);
});

test("cancelled 轮不做短路收口：中断与短路不可区分，保持既有 running → SessionResumed fail-closed 语义", () => {
  const { rows } = driveShortCircuit("cancelled");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, "running", "cancelled 轮被误收口成终态：中断会被误标为 completed/短路");
  assert.equal(rows[0].hookCount, 2, "cancelled 轮不得改写 hookCount");
});

test("在飞 execution（async 环节）不满足收口谓词：成功轮末照常等待自己的终态事件", () => {
  const projection = new ProductProjection(SID, "epoch-hook-async");
  projection.applyEvent(
    ev("turn_started", {
      turnId: "turn-2",
      turnNumber: 1,
      transcriptMessageId: "user-2",
      messageId: "msg-user-2",
      input: "async hook turn",
    }),
  );
  // 环节 0（middleware 之外的普通 hook）完成；环节 1 是后台 async，Started 后仍在飞。
  projection.applyEvent(ev("hook_run_started", hookPayload({ hookCount: 3, hookInvocationId: "inv-2" }), { turnId: "turn-2" }));
  projection.applyEvent(
    ev("hook_run_completed", hookPayload({ durationMs: 5, hookCount: 3, hookInvocationId: "inv-2", outcome: "success" }), { turnId: "turn-2" }),
  );
  projection.applyEvent(
    ev(
      "hook_run_started",
      hookPayload({
        hookCount: 3,
        hookIndex: 1,
        hookInvocationId: "inv-2",
        hookRunId: "run-2",
        descriptor: { ...DESCRIPTOR, executionMode: "background" },
      }),
      { turnId: "turn-2" },
    ),
  );
  projection.applyEvent(ev("turn_complete", { resultType: "success" }), { turnId: "turn-2" });

  const rows = projection
    .getSnapshot()
    .rows.window.filter((row) => row.kind === "hookInvocation");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, "running", "在飞 async 环节被成功轮末误收口");
  assert.equal(rows[0].hookCount, 3);

  // 后台环节自己的终态事件到达后走既有 onHookRunLifecycle 重算收口。
  projection.applyEvent(
    ev(
      "hook_run_completed",
      hookPayload({
        durationMs: 900,
        hookCount: 3,
        hookIndex: 1,
        hookInvocationId: "inv-2",
        hookRunId: "run-2",
        outcome: "success",
      }),
      { turnId: "turn-2" },
    ),
  );
  const settled = projection
    .getSnapshot()
    .rows.window.filter((row) => row.kind === "hookInvocation");
  // 环节 2 被短路（3 个预扫描环节只发了 2 个的事件）——但轮已收口，本 row 的
  // 收口由既有语义处理：executions 全部终态且数量仍 < hookCount 时，晚到事件
  // 重算 hookInvocationState 仍是 running；这正是 spec「row 状态按既有 flush 收口」
  // 的残余形态，成功轮末的精确化只覆盖轮末前已齐终态的短路链。
  assert.equal(settled[0].executions.length, 2);
});

test("接线文字在案：成功轮末调用短路收口，且方法头注与 spec W1 互引", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(
    new URL("../packages/bootstrap/src/acode-protocol-v4/product-projection.ts", import.meta.url),
    "utf8",
  );
  const calls = source.match(/this\.closeShortCircuitedHookRows\(event\)/gu) ?? [];
  assert.equal(calls.length, 2, "controlOnly 与常规成功轮两处收口调用点应同时在案");
  assert.match(source, /specs\/plugin-hook-middleware\.md 一\.6 \/ 接线 W1/u, "spec 互引缺失");
  assert.match(source, /resultType === "success" \? this\.closeShortCircuitedHookRows\(event\) : \[\]/u, "收口必须只在成功轮触发");
});
