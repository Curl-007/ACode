// 插件 hook 中间件语义守护（specs/plugin-hook-middleware.md 一，验收场景 1/2）。
// 一期最小洋葱：next() 续链、next(e') 改写下游所见、不调 next 短路自答、事件冻结
// 纯值、身份字段钉死、misuse 按失败语义 fail-open、legacy 链零破坏。
import assert from "node:assert/strict";
import { test } from "node:test";

const { InMemoryHookRunner } = await import("../packages/core/src/hooks/runner.ts");
const { SessionEventType } = await import("../packages/contracts/src/events/session.events.ts");

function baseInput(hookEventName, extra = {}) {
  return {
    cwd: "/work",
    hookEventName,
    mode: "build",
    sessionId: "sess_middleware",
    timestamp: new Date().toISOString(),
    traceId: "trace_middleware",
    turnId: "turn_middleware",
    ...extra,
  };
}

function recordingLogger() {
  const lines = [];
  return {
    lines,
    logger: {
      debug: (message, context) => lines.push({ level: "debug", message, context }),
      info: () => {},
      warn: (message, context) => lines.push({ level: "warn", message, context }),
      error: () => {},
      child: () => recordingLogger().logger,
    },
  };
}

function createHarness(hooks, { logger } = {}) {
  const events = [];
  const runner = new InMemoryHookRunner({
    emitEvent: async (sessionEvent) => {
      events.push(sessionEvent);
    },
    hooks,
    ...(logger ? { logger } : {}),
  });
  return { events, run: (input, options) => runner.run(input, options) };
}

function eventTypes(events) {
  return events.map((entry) => entry.type);
}

function contextHook(event, name, output, seen) {
  return {
    callback: async (input, context) => {
      seen?.push({ input, context, name });
      return output;
    },
    descriptor: {
      clientVisible: true,
      commandDisplay: name,
      executionMode: "foreground",
      executionType: "process",
      sourceKind: "internal",
      timeoutMs: 1000,
    },
    event,
    source: name,
  };
}

test("next() 续链：下游执行、结果合并、事件序为洋葱包裹序", async () => {
  const seen = [];
  const harness = createHarness([
    {
      ...contextHook("PostToolUse", "mw", { hookSpecificOutput: { additionalContext: "mw-ctx", hookEventName: "PostToolUse" } }, seen),
      middleware: true,
      callback: async (input, context) => {
        seen.push({ name: "mw", input, context });
        const downstream = await context.next();
        assert.ok(Array.isArray(downstream.additionalContexts));
        assert.deepEqual(downstream.additionalContexts, ["legacy-ctx"]);
        return { hookSpecificOutput: { additionalContext: "mw-ctx", hookEventName: "PostToolUse" } };
      },
    },
    contextHook("PostToolUse", "legacy", { hookSpecificOutput: { additionalContext: "legacy-ctx", hookEventName: "PostToolUse" } }, seen),
  ]);
  const result = await harness.run(baseInput("PostToolUse"));
  // 合并序：下游先并入，middleware 自身输出后并入（洋葱包裹序）。
  assert.deepEqual(result.additionalContexts, ["legacy-ctx", "mw-ctx"]);
  const types = eventTypes(harness.events);
  assert.deepEqual(types, [
    SessionEventType.HookRunStarted, // mw
    SessionEventType.HookRunStarted, // legacy
    SessionEventType.HookRunCompleted, // legacy
    SessionEventType.HookRunCompleted, // mw
  ]);
  // legacy callback 不感知 middleware：context 里没有 next。
  const legacyCall = seen.find((entry) => entry.name === "legacy");
  assert.equal(legacyCall.context.next, undefined);
});

test("next(e') 改写下游所见：下游 legacy 收到改写事件且为冻结对象", async () => {
  const seen = [];
  const harness = createHarness([
    {
      ...contextHook("UserPromptSubmit", "mw", undefined, undefined),
      middleware: true,
      callback: async (input, context) => {
        await context.next({ ...input, prompt: "rewritten-prompt" });
        return undefined;
      },
    },
    contextHook("UserPromptSubmit", "legacy", undefined, seen),
  ]);
  await harness.run(baseInput("UserPromptSubmit", { prompt: "original-prompt" }));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].input.prompt, "rewritten-prompt");
  assert.ok(Object.isFrozen(seen[0].input));
  // 身份字段不可改写：钉死为原值。
  assert.equal(seen[0].input.hookEventName, "UserPromptSubmit");
  assert.equal(seen[0].input.sessionId, "sess_middleware");
});

test("不调 next = 自答短路：下游零执行零事件，链结果即 middleware 输出（block 对齐）", async () => {
  const seen = [];
  const harness = createHarness([
    {
      ...contextHook("PreCompact", "mw", undefined, undefined),
      middleware: true,
      callback: async () => ({ continue: false, reason: "compact refused by middleware" }),
    },
    contextHook("PreCompact", "legacy", undefined, seen),
  ]);
  const result = await harness.run(baseInput("PreCompact", { trigger: "manual" }));
  // 阻断语义与现有 block 输出对齐：PreCompact 是阻断类 ⇒ preventContinuation。
  assert.equal(result.blockRequested, true);
  assert.equal(result.preventContinuation, true);
  assert.match(result.stopReason ?? "", /compact refused by middleware/u);
  assert.equal(seen.length, 0);
  // 只有 mw 的生命周期事件；被短路的 hook 从未启动、不发任何事件。
  assert.deepEqual(eventTypes(harness.events), [
    SessionEventType.HookRunStarted,
    SessionEventType.HookRunBlocked,
  ]);
});

test("middleware 收到的事件是冻结纯值（顶层不可写）", async () => {
  const harness = createHarness([
    {
      ...contextHook("PostToolUse", "mw", undefined, undefined),
      middleware: true,
      callback: async (input, context) => {
        assert.ok(Object.isFrozen(input));
        assert.throws(() => {
          input.cwd = "/mutated";
        }, TypeError);
        return context.next();
      },
    },
  ]);
  await harness.run(baseInput("PostToolUse"));
});

test("misuse：改写身份字段 ⇒ hook_middleware_misuse 失败 + fail-open + 链继续", async () => {
  const { logger, lines } = recordingLogger();
  const seen = [];
  const harness = createHarness(
    [
      {
        ...contextHook("PreCompact", "mw", undefined, undefined),
        middleware: true,
        callback: async (input, context) => {
          await context.next({ ...input, hookEventName: "Stop" });
          return undefined;
        },
      },
      contextHook("PreCompact", "legacy", undefined, seen),
    ],
    { logger },
  );
  const result = await harness.run(baseInput("PreCompact", { trigger: "manual" }));
  const failed = harness.events.filter((entry) => entry.type === SessionEventType.HookRunFailed);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].payload.refusalReason, "hook_middleware_misuse");
  assert.match(failed[0].payload.refusalAnnotation, /^mw: PreCompact 被拒: hook_middleware_misuse; 已用引擎默认行为$/u);
  // fail-open：业务动作放行；改写校验失败下游未启动 ⇒ 环节缺席，链继续。
  assert.equal(result.preventContinuation, undefined);
  assert.equal(seen.length, 1);
  assert.ok(lines.some((line) => line.context?.event === "hook.refusal.annotation"));
});

test("misuse：double next ⇒ 失败结算；已真实完成的下游结果照常并入（不被吞掉）", async () => {
  const { logger } = recordingLogger();
  const harness = createHarness(
    [
      {
        ...contextHook("PostToolUse", "mw", undefined, undefined),
        middleware: true,
        callback: async (input, context) => {
          await context.next();
          await context.next();
          return undefined;
        },
      },
      contextHook("PostToolUse", "legacy", {
        hookSpecificOutput: { additionalContext: "legacy-ctx", hookEventName: "PostToolUse" },
      }, undefined),
    ],
    { logger },
  );
  const result = await harness.run(baseInput("PostToolUse"));
  const failed = harness.events.filter((entry) => entry.type === SessionEventType.HookRunFailed);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].payload.refusalReason, "hook_middleware_misuse");
  // 下游 legacy 已真实完成：其结果并入最终结果，事件完整。
  assert.deepEqual(result.additionalContexts, ["legacy-ctx"]);
  assert.ok(harness.events.some((entry) => entry.type === SessionEventType.HookRunCompleted));
});

test("middleware 超时：下游段等完、结果照常并入，本环节按 hook_timeout 失败", async () => {
  const { logger } = recordingLogger();
  const harness = createHarness(
    [
      {
        ...contextHook("PostToolUse", "mw", undefined, undefined),
        middleware: true,
        timeoutMs: 20,
        callback: async (input, context) => {
          await context.next();
          return undefined;
        },
      },
      {
        ...contextHook("PostToolUse", "slow", undefined, undefined),
        callback: async () => {
          await new Promise((resolve) => setTimeout(resolve, 60));
          return { hookSpecificOutput: { additionalContext: "slow-ctx", hookEventName: "PostToolUse" } };
        },
        timeoutMs: 2000,
      },
    ],
    { logger },
  );
  const result = await harness.run(baseInput("PostToolUse"));
  const failed = harness.events.filter((entry) => entry.type === SessionEventType.HookRunFailed);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].payload.refusalReason, "hook_timeout");
  assert.equal(failed[0].payload.outcome, "timed_out");
  // 下游在飞段等完并结算：Completed 事件在场、结果并入。
  assert.deepEqual(result.additionalContexts, ["slow-ctx"]);
  assert.ok(harness.events.some((entry) => entry.type === SessionEventType.HookRunCompleted));
});

test("兼容回归：legacy 链（无 middleware）行为、事件序、合并结果不变；context 无 next", async () => {
  const seen = [];
  const harness = createHarness([
    contextHook("PostToolUse", "a", { hookSpecificOutput: { additionalContext: "a-ctx", hookEventName: "PostToolUse" } }, seen),
    contextHook("PostToolUse", "b", { hookSpecificOutput: { additionalContext: "b-ctx", hookEventName: "PostToolUse" } }, seen),
  ]);
  const result = await harness.run(baseInput("PostToolUse"));
  assert.deepEqual(result.additionalContexts, ["a-ctx", "b-ctx"]);
  assert.deepEqual(eventTypes(harness.events), [
    SessionEventType.HookRunStarted,
    SessionEventType.HookRunCompleted,
    SessionEventType.HookRunStarted,
    SessionEventType.HookRunCompleted,
  ]);
  assert.equal(seen[0].context.next, undefined);
  assert.equal(seen[1].context.next, undefined);
  // legacy 收到的 input 保持现状（不冻结）——存量行为零变化。
  assert.ok(!Object.isFrozen(seen[0].input));
});

test("async 与 middleware 互斥：async 胜出（后台派发），middleware 标志忽略 + debug 行", async () => {
  const { logger, lines } = recordingLogger();
  let receivedNext = "unset";
  const harness = createHarness(
    [
      {
        ...contextHook("PostToolUse", "async-mw", undefined, undefined),
        async: true,
        middleware: true,
        callback: async (input, context) => {
          receivedNext = context.next;
          return undefined;
        },
      },
      contextHook("PostToolUse", "legacy", undefined, undefined),
    ],
    { logger },
  );
  const result = await harness.run(baseInput("PostToolUse"));
  // async 环节后台派发：给一个宏任务窗口让其 callback 实际执行后再断言。
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(receivedNext, undefined);
  assert.ok(lines.some((line) => line.context?.event === "hook.middleware.ignored_async"));
  // 链立即推进到 legacy（async 不阻塞）。
  assert.deepEqual(result.additionalContexts, []);
  assert.ok(harness.events.some((entry) => entry.type === SessionEventType.HookRunStarted));
});

test("middleware 显式 block 输出走既有裁决（PreToolUse deny），非 refusal 注记", async () => {
  const harness = createHarness([
    {
      ...contextHook("PreToolUse", "mw", undefined, undefined),
      middleware: true,
      callback: async () => ({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: "middleware denied",
        },
      }),
    },
  ]);
  const result = await harness.run(
    baseInput("PreToolUse", { riskLevel: "low", toolCallId: "call_1", toolInput: {}, toolName: "Bash" }),
  );
  assert.equal(result.permissionBehavior, "deny");
  const blocked = harness.events.filter((entry) => entry.type === SessionEventType.HookRunBlocked);
  assert.equal(blocked.length, 1);
  // 显式 block 是 hook 决策生效，不属被拒：无 refusal 注记字段，blockReason 走既有链路。
  assert.equal(blocked[0].payload.refusalReason, undefined);
  assert.equal(blocked[0].payload.refusalAnnotation, undefined);
  assert.match(blocked[0].payload.blockReason ?? "", /middleware denied/u);
});
