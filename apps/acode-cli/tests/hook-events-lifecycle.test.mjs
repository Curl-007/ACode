// T1-6 hook 事件面扩展：新事件触发函数的 payload 形状与可控性分类
// （specs/hook-event-surface.md 验收场景 2/4）。用假 runtime / 假 deps +
// InMemoryHookRunner 直测触发函数；不构造完整 AgentRuntime。
import assert from "node:assert/strict";
import { test } from "node:test";

const { InMemoryHookRunner } = await import("../packages/core/src/hooks/runner.ts");
const {
  runPostToolBatchHooks,
  runPreCompactHooks,
  runPostCompactHooks,
  runPreModelSwitchHooks,
  runPostModelSwitchHooks,
  runStopFailureHooks,
  runCwdChangedHooksDetached,
} = await import("../packages/core/src/runtime/methods/hooks.ts");
const { runTaskCreatedHooks, runTaskCompletedHooks } =
  await import("../packages/core/src/tool/executor/hook-flow.ts");

const TRACE = { traceId: "trace_hook_events", turnId: "turn_hook_events" };

/**
 * @param {Array<{ event: string; matcher?: string; callback: Function; timeoutMs?: number }>} hooks
 */
function createFakeRuntime(hooks = []) {
  const runner = new InMemoryHookRunner({
    hooks: hooks.map((hook) => ({
      callback: hook.callback,
      event: hook.event,
      ...(hook.matcher !== undefined ? { matcher: hook.matcher } : {}),
      ...(hook.timeoutMs !== undefined ? { timeoutMs: hook.timeoutMs } : {}),
    })),
  });
  return {
    config: { agentName: "hook-events-agent" },
    getMode: () => "build",
    hookRunner: runner,
    logger: { debug() {}, info() {}, warn() {} },
    rootTraceContext: { traceId: "trace_root" },
    sessionId: "sess_hook_events",
    workingDirectory: "/work/root",
  };
}

function createFakeExecutorDeps(hooks = []) {
  const runner = new InMemoryHookRunner({
    hooks: hooks.map((hook) => ({
      callback: hook.callback,
      event: hook.event,
      ...(hook.matcher !== undefined ? { matcher: hook.matcher } : {}),
    })),
  });
  return {
    getMode: () => "build",
    getWorkingDirectory: () => "/work/executor",
    hookRunner: runner,
    sessionId: "sess_hook_events",
    turnId: "turn_executor",
  };
}

function recorder() {
  const inputs = [];
  return {
    inputs,
    callback: (input) => {
      inputs.push(input);
      return undefined;
    },
  };
}

test("PostToolBatch：payload 形状（toolResults/successCount/errorCount + base 字段）", async () => {
  const rec = recorder();
  const runtime = createFakeRuntime([{ callback: rec.callback, event: "PostToolBatch" }]);
  const result = await runPostToolBatchHooks(
    runtime,
    {
      errorCount: 1,
      successCount: 2,
      toolResults: [
        { durationMs: 12, success: true, toolCallId: "tc_1", toolName: "Read" },
        { success: true, toolCallId: "tc_2", toolName: "Bash" },
        { success: false, toolCallId: "tc_3", toolName: "Edit" },
      ],
    },
    TRACE,
  );
  assert.equal(rec.inputs.length, 1);
  const input = rec.inputs[0];
  assert.equal(input.hookEventName, "PostToolBatch");
  assert.equal(input.successCount, 2);
  assert.equal(input.errorCount, 1);
  assert.deepEqual(
    input.toolResults.map((entry) => entry.toolCallId),
    ["tc_1", "tc_2", "tc_3"],
  );
  assert.equal(input.cwd, "/work/root");
  assert.equal(input.sessionId, "sess_hook_events");
  assert.equal(input.agentName, "hook-events-agent");
  assert.equal(input.mode, "build");
  assert.equal(input.traceId, TRACE.traceId);
  assert.equal(input.turnId, TRACE.turnId);
  assert.equal(typeof input.timestamp, "string");
  assert.deepEqual(result.additionalContexts, []);
});

test("PreCompact：matchValue=trigger；continue:false ⇒ preventContinuation（阻断类）", async () => {
  const rec = recorder();
  const runtime = createFakeRuntime([
    { callback: rec.callback, event: "PreCompact", matcher: "manual" },
    {
      callback: () => ({ continue: false, reason: "compact denied" }),
      event: "PreCompact",
      matcher: "auto",
    },
  ]);
  // trigger=manual 命中记录 matcher，不命中 block matcher → 放行
  const allowed = await runPreCompactHooks(
    runtime,
    { preCompactTokenCount: 1234, trigger: "manual" },
    TRACE,
  );
  assert.equal(allowed.preventContinuation, undefined);
  assert.equal(rec.inputs.length, 1);
  assert.equal(rec.inputs[0].hookEventName, "PreCompact");
  assert.equal(rec.inputs[0].trigger, "manual");
  assert.equal(rec.inputs[0].preCompactTokenCount, 1234);

  // trigger=auto 命中 block matcher → 阻断
  const blocked = await runPreCompactHooks(runtime, { trigger: "auto" }, TRACE);
  assert.equal(blocked.blockRequested, true);
  assert.equal(blocked.preventContinuation, true);
  assert.equal(blocked.stopReason, "compact denied");
});

test("PostCompact：通知类——continue:false 只置 blockRequested，不 preventContinuation", async () => {
  const rec = recorder();
  const runtime = createFakeRuntime([
    { callback: rec.callback, event: "PostCompact", matcher: "auto" },
    { callback: () => ({ continue: false }), event: "PostCompact", matcher: "auto" },
  ]);
  const result = await runPostCompactHooks(
    runtime,
    { postCompactTokenCount: 42, preCompactTokenCount: 900, trigger: "auto" },
    TRACE,
  );
  assert.equal(rec.inputs.length, 1);
  assert.equal(rec.inputs[0].hookEventName, "PostCompact");
  assert.equal(rec.inputs[0].trigger, "auto");
  assert.equal(rec.inputs[0].postCompactTokenCount, 42);
  assert.equal(result.blockRequested, true);
  assert.notEqual(result.preventContinuation, true);
});

test("PreModelSwitch：payload previousModel/nextModel；block ⇒ preventContinuation", async () => {
  const rec = recorder();
  const runtime = createFakeRuntime([
    { callback: rec.callback, event: "PreModelSwitch", matcher: "prov/next" },
    {
      callback: () => ({ decision: "block", reason: "stay" }),
      event: "PreModelSwitch",
      matcher: "prov/next",
    },
  ]);
  const result = await runPreModelSwitchHooks(
    runtime,
    { nextModel: "prov/next", previousModel: "prov/prev" },
    TRACE,
  );
  assert.equal(rec.inputs.length, 1);
  assert.equal(rec.inputs[0].hookEventName, "PreModelSwitch");
  assert.equal(rec.inputs[0].previousModel, "prov/prev");
  assert.equal(rec.inputs[0].nextModel, "prov/next");
  assert.equal(result.blockRequested, true);
  assert.equal(result.preventContinuation, true);
});

test("PostModelSwitch：通知类 payload；无 previousModel 时字段缺席", async () => {
  const rec = recorder();
  const runtime = createFakeRuntime([{ callback: rec.callback, event: "PostModelSwitch" }]);
  await runPostModelSwitchHooks(runtime, { nextModel: "prov/next" }, TRACE);
  assert.equal(rec.inputs.length, 1);
  assert.equal(rec.inputs[0].hookEventName, "PostModelSwitch");
  assert.equal(rec.inputs[0].nextModel, "prov/next");
  assert.equal("previousModel" in rec.inputs[0], false);
});

test("StopFailure：matchValue failed/cancelled；hook 抛错不外溢（containment）", async () => {
  const rec = recorder();
  const runtime = createFakeRuntime([
    { callback: rec.callback, event: "StopFailure", matcher: "failed" },
    {
      callback: () => {
        throw new Error("hook exploded");
      },
      event: "StopFailure",
      matcher: "failed",
    },
  ]);
  await runStopFailureHooks(
    runtime,
    {
      cancelled: false,
      errorMessage: "boom",
      errorType: "tool_execution_failed",
      toolCallCount: 3,
    },
    TRACE,
  );
  assert.equal(rec.inputs.length, 1);
  assert.equal(rec.inputs[0].hookEventName, "StopFailure");
  assert.equal(rec.inputs[0].cancelled, false);
  assert.equal(rec.inputs[0].errorType, "tool_execution_failed");
  assert.equal(rec.inputs[0].errorMessage, "boom");
  assert.equal(rec.inputs[0].toolCallCount, 3);

  // cancelled ⇒ matchValue "cancelled"，不命中 "failed" matcher
  await runStopFailureHooks(
    runtime,
    { cancelled: true, errorMessage: "x", errorType: "turn_cancelled" },
    TRACE,
  );
  assert.equal(rec.inputs.length, 1);
});

test("CwdChanged：同步返回、异步旁路送达 previousCwd/newCwd；cwd=newCwd", async () => {
  const rec = recorder();
  const runtime = createFakeRuntime([{ callback: rec.callback, event: "CwdChanged" }]);
  const returned = runCwdChangedHooksDetached(runtime, "/work/root", "/work/root/sub");
  assert.equal(returned, undefined);
  assert.equal(rec.inputs.length, 0, "detached hook 不应同步执行完成前登记输入");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(rec.inputs.length, 1);
  assert.equal(rec.inputs[0].hookEventName, "CwdChanged");
  assert.equal(rec.inputs[0].previousCwd, "/work/root");
  assert.equal(rec.inputs[0].newCwd, "/work/root/sub");
  assert.equal(rec.inputs[0].cwd, "/work/root/sub");
  assert.equal(rec.inputs[0].traceId, "trace_root");
});

test("TaskCreated/TaskCompleted：payload 形状与 toolName matcher", async () => {
  const created = recorder();
  const completed = recorder();
  const deps = createFakeExecutorDeps([
    { callback: created.callback, event: "TaskCreated", matcher: "Agent" },
    { callback: completed.callback, event: "TaskCompleted", matcher: "Bash" },
  ]);
  await runTaskCreatedHooks(
    deps,
    {
      description: "research",
      taskKind: "subagent",
      taskId: "task_1",
      toolCallId: "tc_9",
      toolName: "Agent",
    },
    TRACE,
  );
  await runTaskCompletedHooks(
    deps,
    { taskKind: "shell", taskId: "task_2", taskStatus: "completed", toolName: "Bash" },
    TRACE,
  );
  // TaskCompleted 的 Bash matcher 不应吃到 TaskCreated(Agent)
  assert.equal(created.inputs.length, 1);
  assert.equal(created.inputs[0].hookEventName, "TaskCreated");
  assert.equal(created.inputs[0].taskId, "task_1");
  assert.equal(created.inputs[0].taskKind, "subagent");
  assert.equal(created.inputs[0].description, "research");
  assert.equal(created.inputs[0].cwd, "/work/executor");
  assert.equal(created.inputs[0].turnId, TRACE.turnId);

  assert.equal(completed.inputs.length, 1);
  assert.equal(completed.inputs[0].hookEventName, "TaskCompleted");
  assert.equal(completed.inputs[0].taskId, "task_2");
  assert.equal(completed.inputs[0].taskStatus, "completed");
});

test("无 hookRunner 时全部新触发函数安全返回（不抛错、不产生输入）", async () => {
  const runtime = { ...createFakeRuntime([]), hookRunner: undefined };
  const deps = { ...createFakeExecutorDeps([]), hookRunner: undefined };
  const empty = { additionalContexts: [] };
  assert.deepEqual(
    await runPostToolBatchHooks(
      runtime,
      { errorCount: 0, successCount: 0, toolResults: [] },
      TRACE,
    ),
    empty,
  );
  assert.deepEqual(await runPreCompactHooks(runtime, { trigger: "manual" }, TRACE), empty);
  assert.deepEqual(await runPostCompactHooks(runtime, { trigger: "manual" }, TRACE), empty);
  assert.deepEqual(await runPreModelSwitchHooks(runtime, { nextModel: "a/b" }, TRACE), empty);
  assert.deepEqual(await runPostModelSwitchHooks(runtime, { nextModel: "a/b" }, TRACE), empty);
  await runStopFailureHooks(
    runtime,
    { cancelled: false, errorMessage: "e", errorType: "t" },
    TRACE,
  );
  runCwdChangedHooksDetached(runtime, "/a", "/b");
  assert.deepEqual(await runTaskCreatedHooks(deps, { taskId: "t" }, TRACE), empty);
  assert.deepEqual(
    await runTaskCompletedHooks(deps, { taskId: "t", taskStatus: "completed" }, TRACE),
    empty,
  );
});
