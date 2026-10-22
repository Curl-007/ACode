// SessionPane 命令编排的**接缝内测试**（god-component-split-plan.md 第二批的硬前置）。
//
// 背景：SessionPane 命令组（订阅/发送/停止/fork/edit/retry/queue/slash）此前无组件级测试，
// 拆分计划第 23 行明确「拆命令组前必须先为命令编排建立接缝内测试」。ui 包无 jsdom 套件
// （node:test + renderToStaticMarkup 纯 .ts），命令编排的闭包族（dispatchCommand/snapshotRef/lease）
// 无法在无 DOM 下做行为渲染测试；因此按 plan 的可行替代——**把可纯化的决策逻辑抽成纯函数并测它们**
// （见 src/v4/session-pane/commandOrchestration.ts），闭包族整体保留、不引入 state 副本。
//
// 覆盖：submissionConfigFromCommand / resolveQueuedComposerRestore / shouldRestoreQueuedComposerFromAck /
// resolveEditUserQueryPayload / resolveSlashCommandDispatch 的现有行为，作为后续重构安全网。
import assert from "node:assert/strict";
import test from "node:test";
import type {
  AttachmentRef,
  CommandAck,
  ConversationSnapshot,
} from "@acode/shared/acode-protocol-v4";
import type { V4VisibleSlashCommand } from "../src/v4/slashCommands.js";
import {
  resolveEditUserQueryPayload,
  resolveQueuedComposerRestore,
  resolveSlashCommandDispatch,
  shouldRestoreQueuedComposerFromAck,
  submissionConfigFromCommand,
} from "../src/v4/session-pane/commandOrchestration.js";

// 纯函数只读取快照的少数字段（revision + queue.items[]），用最小 fixture 锁定决策分支，
// 不构造完整 strict 快照（那是投影层单测的职责）。
function snapshotWithQueue(
  revision: number,
  items: ReadonlyArray<Record<string, unknown>>,
): ConversationSnapshot {
  return { revision, queue: { items, autoDrain: true } } as unknown as ConversationSnapshot;
}

const SUBMISSION = {
  modelSelection: { providerId: "acode", modelId: "m1", options: {} },
  mode: "build",
  planEnabled: false,
} as const;

// ── submissionConfigFromCommand ──

test("submissionConfigFromCommand: sendText payload 直接提取；缺 modelSelection/mode 返回 null", () => {
  assert.deepEqual(
    submissionConfigFromCommand("sendText", { ...SUBMISSION }),
    {
      modelSelection: SUBMISSION.modelSelection,
      mode: "build",
      planEnabled: false,
    },
  );
  // 缺 modelSelection 或 mode → null（不写回推荐选择）。
  assert.equal(submissionConfigFromCommand("sendText", { mode: "build" }), null);
  assert.equal(
    submissionConfigFromCommand("sendText", { modelSelection: SUBMISSION.modelSelection }),
    null,
  );
});

test("submissionConfigFromCommand: createSession 从 firstInput 提取；planEnabled 缺省按 mode===plan 推导", () => {
  assert.deepEqual(
    submissionConfigFromCommand("createSession", {
      firstInput: { modelSelection: SUBMISSION.modelSelection, mode: "plan" },
    }),
    { modelSelection: SUBMISSION.modelSelection, mode: "plan", planEnabled: true },
  );
  // 非 submission 命令类型（如 forkAssistant）→ null。
  assert.equal(submissionConfigFromCommand("forkAssistant", { ...SUBMISSION }), null);
});

// ── shouldRestoreQueuedComposerFromAck ──

test("shouldRestoreQueuedComposerFromAck: 仅 accepted/duplicate 恢复草稿", () => {
  const statuses: CommandAck["status"][] = [
    "accepted",
    "duplicate",
    "rejected",
    "stale",
    "noop",
    "failed",
  ];
  const expected = [true, true, false, false, false, false];
  statuses.forEach((status, index) => {
    assert.equal(shouldRestoreQueuedComposerFromAck(status), expected[index], status);
  });
});

// ── resolveQueuedComposerRestore ──

test("resolveQueuedComposerRestore: sendText 项还原为草稿恢复目标（携带 revision/sourceCommandId/config）", () => {
  const attachments: AttachmentRef[] = [];
  const snapshot = snapshotWithQueue(7, [
    {
      queueItemId: "q1",
      sourceCommandId: "cmd1",
      kind: "sendText",
      text: "hello",
      attachments,
      mode: "build",
      planEnabled: true,
      modelSelection: SUBMISSION.modelSelection,
    },
  ]);
  const target = resolveQueuedComposerRestore(snapshot, "q1");
  assert.ok(target);
  assert.equal(target.baseRevision, 7);
  assert.equal(target.queueItemId, "q1");
  assert.equal(target.sourceCommandId, "cmd1");
  assert.equal(target.inputKind, "sendText");
  assert.equal(target.text, "hello");
  assert.deepEqual(target.config, {
    mode: "build",
    planEnabled: true,
    modelSelection: SUBMISSION.modelSelection,
  });
});

test("resolveQueuedComposerRestore: compact 项不可编辑 / 缺失项返回 null", () => {
  const compactSnapshot = snapshotWithQueue(3, [
    { queueItemId: "c1", sourceCommandId: "cmdC", kind: "compact", text: "", attachments: [] },
  ]);
  assert.equal(resolveQueuedComposerRestore(compactSnapshot, "c1"), null);
  assert.equal(resolveQueuedComposerRestore(compactSnapshot, "nope"), null);
});

test("resolveQueuedComposerRestore: sendGoalCommand 文本经 v4QueuedCommandText 补 /goal 前缀；无 config 字段时省略 config", () => {
  const snapshot = snapshotWithQueue(5, [
    { queueItemId: "g1", sourceCommandId: "cmdG", kind: "sendGoalCommand", text: "做报表", attachments: [] },
  ]);
  const target = resolveQueuedComposerRestore(snapshot, "g1");
  assert.ok(target);
  assert.equal(target.text, "/goal 做报表");
  assert.equal(target.config, undefined);
});

// ── resolveEditUserQueryPayload ──

const ROW_TARGET = { rowId: 12, entityId: "e1" } as const;

test("resolveEditUserQueryPayload: 空文本且无附件 → skip", () => {
  assert.deepEqual(
    resolveEditUserQueryPayload({
      target: ROW_TARGET,
      newText: "   ",
      workspaceMode: "preserve",
    }),
    { skip: true },
  );
  // 空文本但显式空附件数组仍 skip（无内容可提交）。
  assert.deepEqual(
    resolveEditUserQueryPayload({
      target: ROW_TARGET,
      newText: "",
      attachments: [],
      workspaceMode: "preserve",
    }),
    { skip: true },
  );
});

test("resolveEditUserQueryPayload: 保留 canonical 原附件语义（attachments 缺省不进 payload；显式 [] 进 payload）", () => {
  // 缺省 attachments → payload 不含 attachments 键（CLI 读作「未修改附件，保留 canonical」）。
  const preserve = resolveEditUserQueryPayload({
    target: ROW_TARGET,
    newText: "改一下",
    workspaceMode: "preserve",
  });
  assert.equal(preserve.skip, false);
  if (preserve.skip) throw new Error("unreachable");
  assert.equal("attachments" in preserve.payload, false);
  assert.deepEqual(preserve.payload, {
    target: ROW_TARGET,
    newText: "改一下",
    workspaceMode: "preserve",
  });

  // 显式空数组 → payload.attachments = []（CLI 读作「用户删除全部附件」）。
  const cleared = resolveEditUserQueryPayload({
    target: ROW_TARGET,
    newText: "有文本",
    attachments: [],
    workspaceMode: "rewind",
  });
  assert.equal(cleared.skip, false);
  if (cleared.skip) throw new Error("unreachable");
  assert.deepEqual(cleared.payload.attachments, []);
  assert.equal(cleared.payload.workspaceMode, "rewind");

  // 非空附件 → 浅拷贝进 payload（不共享原数组引用）。
  const attachment = { kind: "file", uri: "file:///a.txt" } as unknown as AttachmentRef;
  const withAttachment = resolveEditUserQueryPayload({
    target: ROW_TARGET,
    newText: "x",
    attachments: [attachment],
    workspaceMode: "preserve",
  });
  if (withAttachment.skip) throw new Error("unreachable");
  const payloadAttachments = withAttachment.payload.attachments as AttachmentRef[];
  assert.deepEqual(payloadAttachments, [attachment]);
});

// ── resolveSlashCommandDispatch ──

const dispatchBase = {
  submission: SUBMISSION,
  baseRevision: 9,
  usageTimeZone: "Asia/Shanghai",
} as const;

test("resolveSlashCommandDispatch: compact → dispatch(compact) 且不透传 baseRevision（不走 CAS）", () => {
  const plan = resolveSlashCommandDispatch({
    command: { kind: "compact", displayText: "/compact" } satisfies V4VisibleSlashCommand,
    ...dispatchBase,
  });
  assert.deepEqual(plan, {
    outcome: "dispatch",
    type: "compact",
    payload: {},
    baseRevision: undefined,
  });
});

test("resolveSlashCommandDispatch: sendGoalCommand 有 submission → dispatch 且 payload 冻结本次 Submission", () => {
  const plan = resolveSlashCommandDispatch({
    command: {
      kind: "sendGoalCommand",
      objective: "上线",
      displayText: "/goal 上线",
    } satisfies V4VisibleSlashCommand,
    heldQueueDisposition: "clearQueueAndSend",
    expectedHeldQueueItemIds: ["h1"],
    ...dispatchBase,
  });
  assert.equal(plan.outcome, "dispatch");
  if (plan.outcome !== "dispatch") throw new Error("unreachable");
  assert.equal(plan.type, "sendGoalCommand");
  assert.equal(plan.payload.text, "上线");
  assert.equal(plan.payload.displayText, "/goal 上线");
  assert.equal(plan.payload.heldQueueDisposition, "clearQueueAndSend");
  assert.deepEqual(plan.payload.expectedHeldQueueItemIds, ["h1"]);
  assert.equal(plan.payload.mode, "build");
});

test("resolveSlashCommandDispatch: sendGoalCommand 无 submission → notConsumed（原 return false）", () => {
  const plan = resolveSlashCommandDispatch({
    command: {
      kind: "sendGoalCommand",
      objective: "x",
      displayText: "/goal x",
    } satisfies V4VisibleSlashCommand,
    submission: undefined,
    baseRevision: 9,
    usageTimeZone: undefined,
  });
  assert.deepEqual(plan, { outcome: "notConsumed" });
});

test("resolveSlashCommandDispatch: resumeGoal 带/缺 baseRevision（CAS 命令）", () => {
  const withRev = resolveSlashCommandDispatch({
    command: { kind: "resumeGoal", displayText: "/goal resume" } satisfies V4VisibleSlashCommand,
    ...dispatchBase,
  });
  assert.deepEqual(withRev, {
    outcome: "dispatch",
    type: "resumeGoal",
    payload: {},
    baseRevision: 9,
  });
  const withoutRev = resolveSlashCommandDispatch({
    command: { kind: "resumeGoal", displayText: "/goal resume" } satisfies V4VisibleSlashCommand,
    submission: SUBMISSION,
    baseRevision: undefined,
    usageTimeZone: undefined,
  });
  assert.equal(withoutRev.outcome, "consumedWithoutDispatch");
  if (withoutRev.outcome !== "consumedWithoutDispatch") throw new Error("unreachable");
  assert.match(withoutRev.warn, /缺少 baseRevision/);
});

test("resolveSlashCommandDispatch: usage 注入 args + timeZone；无 timeZone 时省略", () => {
  const withTz = resolveSlashCommandDispatch({
    command: { kind: "usage", args: "week", displayText: "/usage week" } satisfies V4VisibleSlashCommand,
    submission: SUBMISSION,
    baseRevision: undefined,
    usageTimeZone: "UTC",
  });
  assert.equal(withTz.outcome, "dispatch");
  if (withTz.outcome !== "dispatch") throw new Error("unreachable");
  assert.deepEqual(withTz.payload, { args: "week", timeZone: "UTC" });

  const noTz = resolveSlashCommandDispatch({
    command: { kind: "usage", args: "", displayText: "/usage" } satisfies V4VisibleSlashCommand,
    submission: SUBMISSION,
    baseRevision: undefined,
    usageTimeZone: undefined,
  });
  if (noTz.outcome !== "dispatch") throw new Error("unreachable");
  assert.deepEqual(noTz.payload, {});
});

test("resolveSlashCommandDispatch: autoResume → autoResumeCommand（args 透传）", () => {
  const plan = resolveSlashCommandDispatch({
    command: { kind: "autoResume", args: "on 2h", displayText: "/auto-resume on 2h" } satisfies V4VisibleSlashCommand,
    ...dispatchBase,
  });
  assert.equal(plan.outcome, "dispatch");
  if (plan.outcome !== "dispatch") throw new Error("unreachable");
  assert.equal(plan.type, "autoResumeCommand");
  assert.deepEqual(plan.payload, { args: "on 2h" });
});

test("resolveSlashCommandDispatch: emptyGoal / unsupportedGoal → consumedWithoutDispatch（warn + return true）", () => {
  const empty = resolveSlashCommandDispatch({
    command: { kind: "emptyGoal", displayText: "/goal" } satisfies V4VisibleSlashCommand,
    ...dispatchBase,
  });
  assert.equal(empty.outcome, "consumedWithoutDispatch");
  if (empty.outcome !== "consumedWithoutDispatch") throw new Error("unreachable");
  assert.match(empty.warn, /需要目标文本/);

  const unsupported = resolveSlashCommandDispatch({
    command: { kind: "unsupportedGoal", action: "delete", displayText: "/goal delete" } satisfies V4VisibleSlashCommand,
    ...dispatchBase,
  });
  if (unsupported.outcome !== "consumedWithoutDispatch") throw new Error("unreachable");
  assert.match(unsupported.warn, /暂不支持 \/goal delete/);
});

test("resolveSlashCommandDispatch: planShortcut 等未处理 kind → notConsumed（交发送流程上游）", () => {
  const plan = resolveSlashCommandDispatch({
    command: { kind: "planShortcut", task: "t", displayText: "/plan t" } satisfies V4VisibleSlashCommand,
    ...dispatchBase,
  });
  assert.deepEqual(plan, { outcome: "notConsumed" });
});
