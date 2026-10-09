import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

/**
 * W6 验收测试：运行时重启后的孤儿后台任务提醒。
 *
 * 覆盖规格 apps/acode-cli/specs/runtime-restart-task-reminder.md 的 R1–R5
 * 与验收场景 1–6：
 * - 场景 1：配对逻辑（launch/终态/registry 三判据 + 前台结果不误判 + Bash 三文案）；
 * - 场景 2：上限与去重；
 * - 场景 3：空列表 → null；
 * - 场景 4：分类归属（per-request 档、descriptor 四元组、跨包 persisted 名单零命中）；
 * - 场景 5：一次性接线（源码级钉住 flag 消费块与注入位置）；
 * - 场景 6：正文无 CJK。
 */

const {
  findOrphanedBackgroundTaskIds,
  buildRuntimeRestartReminderBody,
  RUNTIME_RESTART_REMINDER_MAX_IDS,
} = await import("../packages/core/src/runtime/helpers/runtime-reminders.ts");
const {
  SYSTEM_REMINDER_PER_REQUEST_SOURCES,
  SYSTEM_REMINDER_PERSISTED_SOURCES,
  SYSTEM_REMINDER_SOURCES,
  getSystemReminderDescriptor,
  isMidConversationSystemSource,
  wrapSystemReminderForSource,
} = await import("../packages/core/src/system-reminder/source.ts");

const CJK_PATTERN = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

/** 工具结果 message entry（launch 标记的载体形态）。 */
function toolResultEntry(content) {
  return { message: { role: "tool", content }, toolName: "Agent" };
}

/** 终态通知 attachment entry（persisted notice 冷恢复重建后的形态）。 */
function notificationEntry(taskId, extra = "") {
  return {
    kind: "attachment",
    content: `<task-notification>\n<task-id>${taskId}</task-id>\n<status>completed</status>${extra}\n</task-notification>`,
    metadata: { source: "queued_system_notification" },
  };
}

const AGENT_LAUNCH = (id) =>
  `Async agent launched successfully.\nagentId: ${id} (internal ID - do not mention to user.)\nThe agent is working in the background.`;
const AGENT_FOREGROUND_RESULT = (id) =>
  `Findings here.\nagentId: ${id} (use SendMessage with to: '${id}' to continue this agent)`;

const neverKnown = () => false;

test("(场景1/R1) 配对逻辑：launch 无终态且 registry 不认识 → 检出", () => {
  const entries = [toolResultEntry(AGENT_LAUNCH("agent-abc123"))];
  assert.deepEqual(
    findOrphanedBackgroundTaskIds({ entries, isTaskKnownToRuntime: neverKnown }),
    ["agent-abc123"],
  );
});

test("(场景1/R1) 有终态通知 → 不检出", () => {
  const entries = [
    toolResultEntry(AGENT_LAUNCH("agent-abc123")),
    notificationEntry("agent-abc123"),
  ];
  assert.deepEqual(
    findOrphanedBackgroundTaskIds({ entries, isTaskKnownToRuntime: neverKnown }),
    [],
  );
});

test("(场景1/R1) registry 在册（running 或 terminal）→ 不检出", () => {
  const entries = [toolResultEntry(AGENT_LAUNCH("agent-abc123"))];
  assert.deepEqual(
    findOrphanedBackgroundTaskIds({ entries, isTaskKnownToRuntime: (id) => id === "agent-abc123" }),
    [],
  );
});

test("(场景1/R1) 前台完成结果的 agentId 行不误判为后台 launch", () => {
  const entries = [toolResultEntry(AGENT_FOREGROUND_RESULT("agent-fg789"))];
  assert.deepEqual(
    findOrphanedBackgroundTaskIds({ entries, isTaskKnownToRuntime: neverKnown }),
    [],
  );
});

test("(场景1/R1) Bash 三种后台化文案都检出，终态 <task-id> 配对", () => {
  const entries = [
    toolResultEntry("Command running in background with ID: bash-t1. You will be notified when it completes."),
    toolResultEntry(
      "Command exceeded the assistant-mode blocking budget (30s) and was moved to the background with ID: bash-t2. It is still running.",
    ),
    toolResultEntry("Command was manually backgrounded by user with ID: bash-t3."),
    notificationEntry("bash-t2"),
  ];
  assert.deepEqual(
    findOrphanedBackgroundTaskIds({ entries, isTaskKnownToRuntime: neverKnown }),
    ["bash-t1", "bash-t3"],
  );
});

test("(场景1/R1) generic 通知的 <agent-id> 元素同样构成终态", () => {
  const entries = [
    toolResultEntry(AGENT_LAUNCH("agent-x1")),
    {
      kind: "attachment",
      content:
        "<task-notification>\n<task-id>task-99</task-id>\n<agent-id>agent-x1</agent-id>\n<status>completed</status>\n</task-notification>",
      metadata: { source: "task_status" },
    },
  ];
  assert.deepEqual(
    findOrphanedBackgroundTaskIds({ entries, isTaskKnownToRuntime: neverKnown }),
    [],
  );
});

test("(场景2/R1) 上限 10 + 「and N more」收尾；同 id 多次 launch 去重", () => {
  const entries = [];
  for (let i = 0; i < 12; i++) {
    entries.push(toolResultEntry(AGENT_LAUNCH(`agent-orphan-${i}`)));
  }
  entries.push(toolResultEntry(AGENT_LAUNCH("agent-orphan-0")));
  const orphans = findOrphanedBackgroundTaskIds({ entries, isTaskKnownToRuntime: neverKnown });
  assert.equal(orphans.length, 12); // 去重后 12 个唯一 id（agent-orphan-0 只计一次）
  assert.equal(orphans[0], "agent-orphan-0"); // 首次出现顺序

  const body = buildRuntimeRestartReminderBody(orphans);
  assert.ok(body);
  assert.equal(RUNTIME_RESTART_REMINDER_MAX_IDS, 10);
  for (let i = 0; i < 10; i++) {
    assert.ok(body.includes(`- agent-orphan-${i}`), `missing id line ${i}`);
  }
  assert.ok(!body.includes("- agent-orphan-10"));
  assert.ok(!body.includes("- agent-orphan-11"));
  assert.ok(body.includes("(and 2 more)"));
});

test("(场景3/R3) 空列表 → null（不注入空提醒）", () => {
  assert.equal(buildRuntimeRestartReminderBody([]), null);
});

test("(场景4/R2) 分类归属：per-request 档 + descriptor 四元组 + mid-conversation", () => {
  assert.ok(SYSTEM_REMINDER_PER_REQUEST_SOURCES.includes("runtime_restart_tasks"));
  assert.ok(!SYSTEM_REMINDER_PERSISTED_SOURCES.includes("runtime_restart_tasks"));
  assert.ok(SYSTEM_REMINDER_SOURCES.includes("runtime_restart_tasks"));
  assert.deepEqual(getSystemReminderDescriptor("runtime_restart_tasks"), {
    source: "runtime_restart_tasks",
    channel: "current_turn",
    lifecycle: "runtime_local",
    isMeta: true,
    providerVisibility: "provider_visible",
    evidenceLabel: "sr.runtime_restart_tasks",
  });
  assert.equal(isMidConversationSystemSource("runtime_restart_tasks"), true);
  const wrapped = wrapSystemReminderForSource("runtime_restart_tasks", "body");
  assert.equal(wrapped, "<system-reminder>\nbody\n</system-reminder>");
});

test("(场景4/R2) 跨包 persisted 名单零命中（防日后挪档漏改分类）", async () => {
  const files = [
    new URL("../packages/contracts/src/interfaces/session-store.port.ts", import.meta.url),
    new URL(
      "../../../packages/shared/src/conversation-message-projection-policy.ts",
      import.meta.url,
    ),
    new URL(
      "../packages/bootstrap/src/acode-protocol-v4/event-normalizer.ts",
      import.meta.url,
    ),
  ];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    assert.ok(
      !source.includes("runtime_restart_tasks"),
      `${file.pathname} 不得出现 runtime_restart_tasks（per-request 档不落盘，跨包分类不应知道它）`,
    );
  }
});

test("(场景5/R3) turn-loop 一次性接线：flag 消费块 + 注入位置（源码级钉住）", async () => {
  const turnLoop = await readFile(
    new URL("../packages/core/src/runtime/methods/turn-loop.ts", import.meta.url),
    "utf8",
  );
  assert.ok(turnLoop.includes("getRuntimeLifecyclePort(this).consumeRuntimeRestartReminder()"));
  assert.ok(turnLoop.includes('systemReminderAttachmentEntry("runtime_restart_tasks"'));
  assert.ok(turnLoop.includes("findOrphanedBackgroundTaskIds"));
  assert.ok(turnLoop.includes("this.runtimeTaskRegistry.get(taskId) !== undefined"));
  // 注入位置：runtime_mode commit 块之后、todo_reminder 门控之前（R3 顺序）。
  const modeIdx = turnLoop.indexOf('systemReminderAttachmentEntry("runtime_mode"');
  const restartIdx = turnLoop.indexOf('systemReminderAttachmentEntry("runtime_restart_tasks"');
  const todoIdx = turnLoop.indexOf("shouldBuildTodoReminder(");
  assert.ok(modeIdx > 0 && restartIdx > modeIdx && todoIdx > restartIdx);
  // 不落 session：注入块内不得调用 persistSyntheticUserNoticeForSession。
  const restartBlock = turnLoop.slice(restartIdx - 800, restartIdx + 200);
  assert.ok(!restartBlock.includes("persistSyntheticUserNoticeForSession"));

  const internal = await readFile(
    new URL("../packages/core/src/runtime/internal.ts", import.meta.url),
    "utf8",
  );
  assert.ok(internal.includes("extends RuntimeLifecycleView"));
});

test("(场景6/R4) 正文要素齐备且无 CJK", () => {
  const body = buildRuntimeRestartReminderBody(["agent-a1", "bash-b2"]);
  assert.ok(body);
  assert.ok(!CJK_PATTERN.test(body));
  // 事实句：不再运行 + 通知永不到达：
  assert.ok(body.includes("restarted ACode runtime"));
  assert.ok(body.includes("no longer running"));
  assert.ok(body.includes("completion notifications will never arrive"));
  // 行为要求：别等 + 核实实际状态 + 只重建仍需要的：
  assert.ok(body.includes("Do not wait on them."));
  assert.ok(body.includes("verify the actual state"));
  assert.ok(body.includes("relaunch only the work that is still needed"));
  // id 列表逐行：
  assert.ok(body.includes("- agent-a1"));
  assert.ok(body.includes("- bash-b2"));
});
