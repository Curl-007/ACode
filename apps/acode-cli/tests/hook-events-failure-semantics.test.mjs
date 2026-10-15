// T1-6 hook 事件面扩展：失败语义守护（specs/hook-event-surface.md「失败语义」+ 验收场景 3）。
// 用假 ExecutionPort 驱动 createConfiguredHookCallback + InMemoryHookRunner：
// - 退出码 2 ⇒ 阻断类事件等同拒绝（preventContinuation），通知类只 blockRequested；
// - 起不来（非 0 非 2）/ 超时 / JSON 校验失败 ⇒ HookRunFailed + 默认放行（fail-open）；
// - stdout 非 JSON ⇒ 视为诊断文本，正常完成；
// - stdin 兼容别名：新事件 payload 的 snake_case 投影。
import assert from "node:assert/strict";
import { test } from "node:test";

const { InMemoryHookRunner } = await import("../packages/core/src/hooks/runner.ts");
const { createConfiguredHookCallback } =
  await import("../packages/core/src/hooks/configured-runner-callback.ts");
const { createCompatibleHookStdin } =
  await import("../packages/core/src/hooks/configured-runner-input.ts");
const { SessionEventType } = await import("../packages/contracts/src/events/session.events.ts");

function fakeExecutionPort(resultOrFn) {
  return {
    run: async (request, options) =>
      typeof resultOrFn === "function" ? resultOrFn(request, options) : resultOrFn,
  };
}

function completed(exitCode, stdout = "", stderr = "") {
  return {
    exitCode,
    status: "completed",
    stderr: { text: stderr },
    stdout: { text: stdout },
  };
}

function baseInput(hookEventName, extra = {}) {
  return {
    cwd: "/work",
    hookEventName,
    mode: "build",
    sessionId: "sess_failure_semantics",
    timestamp: new Date().toISOString(),
    traceId: "trace_failure_semantics",
    ...extra,
  };
}

function createHarness({ event, executionPort, timeoutMs = 1000, input }) {
  const events = [];
  const callback = createConfiguredHookCallback(
    { executionPort, getWorkingDirectory: () => "/work" },
    event,
    { command: "acode-hook", type: "command" },
    0,
    0,
    { maxOutputBytes: 32768, timeoutMs },
  );
  const runner = new InMemoryHookRunner({
    emitEvent: async (sessionEvent) => {
      events.push(sessionEvent);
    },
    hooks: [{ callback, event, timeoutMs }],
  });
  return { events, run: () => runner.run(input) };
}

test("退出码 2 + 阻断类事件（PreCompact）⇒ preventContinuation（等同拒绝）", async () => {
  const harness = createHarness({
    event: "PreCompact",
    executionPort: fakeExecutionPort(completed(2, "", "compact not allowed")),
    input: baseInput("PreCompact", { trigger: "manual" }),
  });
  const result = await harness.run();
  assert.equal(result.blockRequested, true);
  assert.equal(result.preventContinuation, true);
  assert.match(result.stopReason ?? "", /compact not allowed/u);
  const blocked = harness.events.filter((entry) => entry.type === SessionEventType.HookRunBlocked);
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].payload.hookEventName, "PreCompact");
  assert.equal(blocked[0].payload.outcome, "blocked");
});

test("退出码 2 + PreModelSwitch ⇒ preventContinuation；+ 通知类 PostToolBatch ⇒ 仅 blockRequested", async () => {
  const preSwitch = createHarness({
    event: "PreModelSwitch",
    executionPort: fakeExecutionPort(completed(2, "", "no switch")),
    input: baseInput("PreModelSwitch", { nextModel: "p/n" }),
  });
  const preResult = await preSwitch.run();
  assert.equal(preResult.preventContinuation, true);

  const batch = createHarness({
    event: "PostToolBatch",
    executionPort: fakeExecutionPort(completed(2, "", "noted")),
    input: baseInput("PostToolBatch", {
      errorCount: 0,
      successCount: 1,
      toolResults: [{ success: true, toolCallId: "tc", toolName: "Read" }],
    }),
  });
  const batchResult = await batch.run();
  assert.equal(batchResult.blockRequested, true);
  assert.notEqual(batchResult.preventContinuation, true);
});

test("退出码 0 + JSON decision:block + PreModelSwitch ⇒ preventContinuation", async () => {
  const harness = createHarness({
    event: "PreModelSwitch",
    executionPort: fakeExecutionPort(
      completed(0, JSON.stringify({ decision: "block", reason: "policy" })),
    ),
    input: baseInput("PreModelSwitch", { nextModel: "p/n" }),
  });
  const result = await harness.run();
  assert.equal(result.blockRequested, true);
  assert.equal(result.preventContinuation, true);
  assert.equal(result.stopReason, "policy");
});

test("非 0 非 2 退出码 ⇒ HookRunFailed + 默认放行（fail-open，阻断类同样放行）", async () => {
  const harness = createHarness({
    event: "PreCompact",
    executionPort: fakeExecutionPort(completed(1, "", "hook crashed")),
    input: baseInput("PreCompact", { trigger: "auto" }),
  });
  const result = await harness.run();
  assert.deepEqual(result.additionalContexts, []);
  assert.notEqual(result.blockRequested, true);
  assert.notEqual(result.preventContinuation, true);
  const failed = harness.events.filter((entry) => entry.type === SessionEventType.HookRunFailed);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].payload.outcome, "failed");
});

test("超时 ⇒ HookRunFailed(timed_out) + 放行", async () => {
  const harness = createHarness({
    event: "PostCompact",
    executionPort: fakeExecutionPort(
      () => new Promise(() => {}), // 永不 settle，由 runner 的超时预算收口
    ),
    timeoutMs: 30,
    input: baseInput("PostCompact", { trigger: "manual" }),
  });
  const result = await harness.run();
  assert.deepEqual(result.additionalContexts, []);
  const failed = harness.events.filter((entry) => entry.type === SessionEventType.HookRunFailed);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].payload.outcome, "timed_out");
});

test("stdout JSON schema 校验失败 ⇒ HookRunFailed + 放行；非 JSON stdout ⇒ 视为诊断正常完成", async () => {
  const invalid = createHarness({
    event: "StopFailure",
    executionPort: fakeExecutionPort(completed(0, JSON.stringify({ continue: "yes" }))),
    input: baseInput("StopFailure", {
      cancelled: false,
      errorMessage: "boom",
      errorType: "turn_failed",
    }),
  });
  const invalidResult = await invalid.run();
  assert.deepEqual(invalidResult.additionalContexts, []);
  assert.equal(
    invalid.events.filter((entry) => entry.type === SessionEventType.HookRunFailed).length,
    1,
  );

  const nonJson = createHarness({
    event: "TaskCompleted",
    executionPort: fakeExecutionPort(completed(0, "just some log text\n")),
    input: baseInput("TaskCompleted", { taskId: "t1", taskStatus: "completed" }),
  });
  const nonJsonResult = await nonJson.run();
  assert.deepEqual(nonJsonResult.additionalContexts, []);
  assert.equal(
    nonJson.events.filter((entry) => entry.type === SessionEventType.HookRunCompleted).length,
    1,
  );
  assert.equal(
    nonJson.events.filter((entry) => entry.type === SessionEventType.HookRunFailed).length,
    0,
  );
});

test("存量事件回归：退出码 2 + PreToolUse ⇒ permission deny（旧语义不变）", async () => {
  const harness = createHarness({
    event: "PreToolUse",
    executionPort: fakeExecutionPort(completed(2, "", "denied by policy")),
    input: baseInput("PreToolUse", {
      riskLevel: "low",
      toolCallId: "tc_1",
      toolInput: {},
      toolName: "Bash",
    }),
  });
  const result = await harness.run();
  assert.equal(result.permissionBehavior, "deny");
  assert.equal(result.preventContinuation, true);
});

test("stdin 兼容别名：新事件 payload 的 snake_case 投影", async () => {
  const cases = [
    {
      expect: (parsed) => {
        assert.equal(parsed.task_id, "t1");
        assert.equal(parsed.task_status, "failed");
        assert.equal(parsed.tool_name, "Bash");
        assert.equal(parsed.hook_event_name, "TaskCompleted");
        assert.equal(parsed.session_id, "sess_failure_semantics");
        assert.equal("tool_input" in parsed, false, "Task 事件没有 toolInput 事实，不得合成别名");
      },
      input: baseInput("TaskCompleted", {
        taskId: "t1",
        taskStatus: "failed",
        toolCallId: "tc_1",
        toolName: "Bash",
      }),
    },
    {
      expect: (parsed) => {
        assert.equal(parsed.previous_cwd, "/a");
        assert.equal(parsed.new_cwd, "/b");
      },
      input: baseInput("CwdChanged", { newCwd: "/b", previousCwd: "/a" }),
    },
    {
      expect: (parsed) => {
        assert.equal(parsed.previous_model, "p/old");
        assert.equal(parsed.next_model, "p/new");
      },
      input: baseInput("PreModelSwitch", { nextModel: "p/new", previousModel: "p/old" }),
    },
    {
      expect: (parsed) => {
        assert.equal(parsed.trigger, "auto");
        assert.equal(parsed.post_compact_token_count, 42);
      },
      input: baseInput("PostCompact", { postCompactTokenCount: 42, trigger: "auto" }),
    },
    {
      expect: (parsed) => {
        assert.equal(parsed.error, "boom");
        assert.deepEqual(parsed.error_details, { message: "boom", type: "turn_failed" });
        assert.equal(parsed.cancelled, false);
      },
      input: baseInput("StopFailure", {
        cancelled: false,
        errorMessage: "boom",
        errorType: "turn_failed",
      }),
    },
    {
      expect: (parsed) => {
        assert.equal(parsed.success_count, 1);
        assert.equal(parsed.error_count, 1);
        assert.equal(parsed.tool_results.length, 2);
      },
      input: baseInput("PostToolBatch", {
        errorCount: 1,
        successCount: 1,
        toolResults: [
          { success: true, toolCallId: "a", toolName: "Read" },
          { success: false, toolCallId: "b", toolName: "Edit" },
        ],
      }),
    },
  ];

  for (const testCase of cases) {
    const stdin = await createCompatibleHookStdin(testCase.input);
    try {
      testCase.expect(JSON.parse(stdin.value));
    } finally {
      await stdin.cleanup();
    }
  }
});
