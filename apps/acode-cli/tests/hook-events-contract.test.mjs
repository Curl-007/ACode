// T1-6 hook 事件面扩展：契约层守护（specs/hook-event-surface.md 验收场景 1）。
// 断言新事件进入唯一事实源（HookEventName / HookSpecificOutputSchema /
// HooksRuntimeConfigPatchSchema），且 workspace 信任 digest 面保持 7 事件不变（D1）。
import assert from "node:assert/strict";
import { test } from "node:test";

const { HookEventName, HookSpecificOutputSchema, HooksRuntimeConfigPatchSchema } =
  await import("../packages/contracts/src/hooks/index.ts");
const { WORKSPACE_HOOK_SCHEMA_FIELDS, workspaceHookEventNameSchema } =
  await import("../packages/contracts/src/hooks/workspace-hook-trust.ts");

const NEW_EVENTS = [
  "PostToolBatch",
  "PreCompact",
  "PostCompact",
  "PreModelSwitch",
  "PostModelSwitch",
  "SessionEnd",
  "StopFailure",
  "TaskCreated",
  "TaskCompleted",
  "CwdChanged",
];

const LEGACY_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
];

test("HookEventName 含全部存量 + 新增事件", () => {
  const values = Object.values(HookEventName);
  for (const event of [...LEGACY_EVENTS, ...NEW_EVENTS]) {
    assert.ok(values.includes(event), `missing hook event: ${event}`);
  }
});

test("HookSpecificOutputSchema 接受每个新事件的 additionalContext 输出", () => {
  for (const event of NEW_EVENTS) {
    const result = HookSpecificOutputSchema.safeParse({
      additionalContext: "ctx",
      hookEventName: event,
    });
    assert.ok(result.success, `${event} specific output rejected: ${result.error?.message}`);
    assert.equal(result.data.additionalContext, "ctx");
  }
});

test("HookSpecificOutputSchema 拒绝未知事件名（回归：存量行为不变）", () => {
  const result = HookSpecificOutputSchema.safeParse({
    additionalContext: "ctx",
    hookEventName: "NotAHookEvent",
  });
  assert.equal(result.success, false);
});

test("HookSpecificOutputSchema 存量 PreToolUse permissionDecision 形状不变（回归）", () => {
  const result = HookSpecificOutputSchema.safeParse({
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: "policy",
  });
  assert.ok(result.success);
  assert.equal(result.data.permissionDecision, "deny");
});

test("HooksRuntimeConfigPatchSchema.events 接受新事件键", () => {
  const events = {};
  for (const event of NEW_EVENTS) {
    events[event] = [{ hooks: [{ command: "echo ok", type: "command" }] }];
  }
  const result = HooksRuntimeConfigPatchSchema.safeParse({ enabled: true, events });
  assert.ok(result.success, result.error?.message);
});

test("HooksRuntimeConfigPatchSchema.events 仍拒绝未知事件键（strict 回归）", () => {
  const result = HooksRuntimeConfigPatchSchema.safeParse({
    events: { UnknownEvent: [{ hooks: [{ command: "echo", type: "command" }] }] },
  });
  assert.equal(result.success, false);
});

test("D1：workspace 信任 digest 面保持存量 7 事件（防止 invalidate 已信任 bundle）", () => {
  assert.deepEqual([...WORKSPACE_HOOK_SCHEMA_FIELDS.events].sort(), [...LEGACY_EVENTS].sort());
  for (const event of NEW_EVENTS) {
    assert.equal(
      workspaceHookEventNameSchema.safeParse(event).success,
      false,
      `${event} 不应进入 workspace trust 事件面（specs/hook-event-surface.md D1）`,
    );
  }
  for (const event of LEGACY_EVENTS) {
    assert.ok(workspaceHookEventNameSchema.safeParse(event).success);
  }
});
