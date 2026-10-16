// Hook 失败可见性协议守护（specs/plugin-hook-middleware.md 二，验收场景 3）。
// 每个被拒执行（admission 拒绝 / 执行失败）都有：闭集 refusalReason + 注记行进
// payload（本会话 transcript 通道）+ debug 行（全部会话兜底）；显式 block 不属被拒；
// fail-open 裁决不变。
import assert from "node:assert/strict";
import { test } from "node:test";

const { InMemoryHookRunner } = await import("../packages/core/src/hooks/runner.ts");
const { createConfiguredHookCallback } =
  await import("../packages/core/src/hooks/configured-runner-callback.ts");
const {
  formatHookRefusalAnnotation,
  resolveHookRefusalReason,
} = await import("../packages/core/src/hooks/hook-refusal-visibility.ts");
const { SessionEventType } = await import("../packages/contracts/src/events/session.events.ts");

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

function baseInput(hookEventName, extra = {}) {
  return {
    cwd: "/work",
    hookEventName,
    mode: "build",
    sessionId: "sess_refusal",
    timestamp: new Date().toISOString(),
    traceId: "trace_refusal",
    turnId: "turn_refusal",
    ...extra,
  };
}

function fakeExecutionPort(resultOrFn) {
  return {
    run: async (request, options) =>
      typeof resultOrFn === "function" ? resultOrFn(request, options) : resultOrFn,
  };
}

function completed(exitCode, stdout = "", stderr = "") {
  return { exitCode, status: "completed", stderr: { text: stderr }, stdout: { text: stdout } };
}

function configuredHookRegistration({ event, executionPort, timeoutMs = 1000 }) {
  return {
    callback: createConfiguredHookCallback(
      { executionPort, getWorkingDirectory: () => "/work" },
      event,
      { command: "acode-hook", type: "command" },
      0,
      0,
      { maxOutputBytes: 32768, timeoutMs },
    ),
    descriptor: {
      clientVisible: true,
      commandDisplay: "acode-hook",
      executionMode: "foreground",
      executionType: "process",
      sourceKind: "project",
      timeoutMs,
    },
    event,
    source: `project.${event}.0.0`,
  };
}

function refusalLines(lines) {
  return lines.filter((line) => line.context?.event === "hook.refusal.annotation");
}

test("闭集归一：admission 词表透传，未知码收敛 hook_failed；失败按类型判别", async () => {
  assert.equal(
    resolveHookRefusalReason({ admissionReasonCode: "workspace_hooks_pending_trust" }),
    "workspace_hooks_pending_trust",
  );
  assert.equal(
    resolveHookRefusalReason({ admissionReasonCode: "workspace_hooks_blocked_by_policy" }),
    "workspace_hooks_blocked_by_policy",
  );
  assert.equal(resolveHookRefusalReason({ admissionReasonCode: "not_in_vocabulary" }), "hook_failed");
  assert.equal(resolveHookRefusalReason({}), "hook_failed");
  assert.equal(
    formatHookRefusalAnnotation({
      hookEventName: "PreToolUse",
      hookName: "acode-hook",
      reason: "hook_timeout",
    }),
    "acode-hook: PreToolUse 被拒: hook_timeout; 已用引擎默认行为",
  );
});

test("admission 拒绝：HookRunBlocked 携带闭集原因+注记行；debug 行在场；业务放行", async () => {
  const { logger, lines } = recordingLogger();
  const events = [];
  const runner = new InMemoryHookRunner({
    emitEvent: async (sessionEvent) => {
      events.push(sessionEvent);
    },
    hooks: [
      {
        admission: () => ({ allowed: false, reasonCode: "workspace_hooks_pending_trust" }),
        callback: async () => {
          throw new Error("must not run");
        },
        descriptor: {
          clientVisible: true,
          commandDisplay: "project-guard",
          executionMode: "foreground",
          executionType: "process",
          sourceKind: "project",
          timeoutMs: 1000,
        },
        event: "PreToolUse",
        source: "project.item_1",
      },
    ],
    logger,
  });
  const result = await runner.run(
    baseInput("PreToolUse", { riskLevel: "low", toolCallId: "call_1", toolInput: {}, toolName: "Bash" }),
  );
  const blocked = events.filter((entry) => entry.type === SessionEventType.HookRunBlocked);
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].payload.refusalReason, "workspace_hooks_pending_trust");
  assert.equal(
    blocked[0].payload.refusalAnnotation,
    "project-guard: PreToolUse 被拒: workspace_hooks_pending_trust; 已用引擎默认行为",
  );
  // fail-open：hook 未执行不阻断业务动作。
  assert.equal(result.permissionBehavior, undefined);
  assert.equal(result.preventContinuation, undefined);
  const refusals = refusalLines(lines);
  assert.equal(refusals.length, 1);
  assert.equal(refusals[0].level, "debug");
  assert.equal(refusals[0].context.refusalReason, "workspace_hooks_pending_trust");
  assert.equal(refusals[0].context.hookEventName, "PreToolUse");
  assert.equal(refusals[0].context.sessionId, "sess_refusal");
});

test("进程失败（非 0 非 2）⇒ hook_process_failed + 注记；超时 ⇒ hook_timeout", async () => {
  const { logger, lines } = recordingLogger();
  const failureHarness = new InMemoryHookRunner({
    emitEvent: async () => {},
    hooks: [configuredHookRegistration({ event: "PostToolUse", executionPort: fakeExecutionPort(completed(1, "", "boom")) })],
    logger,
  });
  await failureHarness.run(baseInput("PostToolUse", { toolName: "Bash" }));
  let refusals = refusalLines(lines);
  assert.equal(refusals.length, 1);
  assert.equal(refusals[0].context.refusalReason, "hook_process_failed");
  assert.equal(
    refusals[0].context.refusalAnnotation,
    "acode-hook: PostToolUse 被拒: hook_process_failed; 已用引擎默认行为",
  );

  const { logger: timeoutLogger, lines: timeoutLines } = recordingLogger();
  const events = [];
  const timeoutHarness = new InMemoryHookRunner({
    emitEvent: async (sessionEvent) => {
      events.push(sessionEvent);
    },
    hooks: [
      {
        callback: async () => {
          await new Promise((resolve) => setTimeout(resolve, 200));
          return undefined;
        },
        descriptor: {
          clientVisible: true,
          commandDisplay: "slow-hook",
          executionMode: "foreground",
          executionType: "process",
          sourceKind: "internal",
          timeoutMs: 10,
        },
        event: "PostToolUse",
        source: "builtin.slow",
        timeoutMs: 10,
      },
    ],
    logger: timeoutLogger,
  });
  const result = await timeoutHarness.run(baseInput("PostToolUse", { toolName: "Bash" }));
  const failed = events.filter((entry) => entry.type === SessionEventType.HookRunFailed);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].payload.refusalReason, "hook_timeout");
  assert.equal(failed[0].payload.outcome, "timed_out");
  assert.equal(failed[0].payload.refusalAnnotation, "slow-hook: PostToolUse 被拒: hook_timeout; 已用引擎默认行为");
  // fail-open 不回归：失败 hook 不产生任何阻断。
  assert.equal(result.blockRequested, undefined);
  assert.equal(refusalLines(timeoutLines).length, 1);
});

test("stdout schema 校验失败 ⇒ hook_output_invalid；非 JSON stdout 是诊断文本不算被拒", async () => {
  const { logger, lines } = recordingLogger();
  const runner = new InMemoryHookRunner({
    emitEvent: async () => {},
    hooks: [
      configuredHookRegistration({
        event: "PostToolUse",
        executionPort: fakeExecutionPort(completed(0, '{"continue":"not-a-boolean"}', "")),
      }),
    ],
    logger,
  });
  await runner.run(baseInput("PostToolUse", { toolName: "Bash" }));
  const refusals = refusalLines(lines);
  assert.equal(refusals.length, 1);
  assert.equal(refusals[0].context.refusalReason, "hook_output_invalid");

  const { logger: diagLogger, lines: diagLines } = recordingLogger();
  const diagRunner = new InMemoryHookRunner({
    emitEvent: async () => {},
    hooks: [
      configuredHookRegistration({
        event: "PostToolUse",
        executionPort: fakeExecutionPort(completed(0, "just diagnostic text", "")),
      }),
    ],
    logger: diagLogger,
  });
  await diagRunner.run(baseInput("PostToolUse", { toolName: "Bash" }));
  assert.equal(refusalLines(diagLines).length, 0);
});

test("显式 block（退出码 2）是 hook 决策生效：blockReason 走既有链路，无 refusal 注记", async () => {
  const { logger, lines } = recordingLogger();
  const events = [];
  const runner = new InMemoryHookRunner({
    emitEvent: async (sessionEvent) => {
      events.push(sessionEvent);
    },
    hooks: [
      configuredHookRegistration({
        event: "PreCompact",
        executionPort: fakeExecutionPort(completed(2, "", "compact not allowed")),
      }),
    ],
    logger,
  });
  const result = await runner.run(baseInput("PreCompact", { trigger: "manual" }));
  assert.equal(result.preventContinuation, true);
  const blocked = events.filter((entry) => entry.type === SessionEventType.HookRunBlocked);
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].payload.refusalReason, undefined);
  assert.equal(blocked[0].payload.refusalAnnotation, undefined);
  assert.match(blocked[0].payload.blockReason ?? "", /compact not allowed/u);
  assert.equal(refusalLines(lines).length, 0);
});

test("async 后台环节失败与前台同规：注记 payload + debug 行带 async 标记", async () => {
  const { logger, lines } = recordingLogger();
  const events = [];
  const runner = new InMemoryHookRunner({
    emitEvent: async (sessionEvent) => {
      events.push(sessionEvent);
    },
    hooks: [
      {
        async: true,
        callback: async () => {
          throw new Error("background boom");
        },
        descriptor: {
          clientVisible: true,
          commandDisplay: "bg-hook",
          executionMode: "background",
          executionType: "process",
          sourceKind: "internal",
          timeoutMs: 1000,
        },
        event: "PostToolUse",
        source: "builtin.bg",
      },
    ],
    logger,
  });
  await runner.run(baseInput("PostToolUse", { toolName: "Bash" }));
  // 后台环节独立结算：等生命周期事件落地。
  await new Promise((resolve) => setTimeout(resolve, 20));
  const failed = events.filter((entry) => entry.type === SessionEventType.HookRunFailed);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].payload.refusalReason, "hook_failed");
  assert.equal(failed[0].payload.refusalAnnotation, "bg-hook: PostToolUse 被拒: hook_failed; 已用引擎默认行为");
  const refusals = refusalLines(lines);
  assert.equal(refusals.length, 1);
  assert.equal(refusals[0].context.async, true);
});
