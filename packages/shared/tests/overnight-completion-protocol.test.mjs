// Overnight（K3）完成信号的 shared 协议边界测试（specs/overnight-completion-notify.md §7）。
// 覆盖两个 schema 面：
//   ① v4 agent→host 通知（v4OvernightCompletionNotificationSchema）；
//   ② host→main 反馈（hostOvernightCompletionNotifyResponseSchema）及其在
//      hostResponseMessageSchema 判别联合里的注册——未注册会被 Main 边界 safeParse 静默丢弃。
// house style：直接 import 真实 .ts 源，zod 断言，无 IO。
import assert from "node:assert/strict";
import test from "node:test";

const v4 = await import("../src/acode-protocol-v4/overnight-completion.ts");
const validation = await import("../src/validation.ts");
const channels = await import("../src/channels.ts");

const {
  v4OvernightCompletionNotificationSchema,
  V4_OVERNIGHT_COMPLETION_METHOD,
} = v4;
const { hostOvernightCompletionNotifyResponseSchema, hostResponseMessageSchema } = validation;
const { HostResponseTypes } = channels;

const validSignal = {
  runId: "overnight-m1abc-x9y2z3",
  parentTaskId: "sess-visible-parent",
  outcome: "completed",
  morningReportReady: true,
};

// ── ① v4 agent→host 通知 schema ──────────────────────────────────────
test("v4 通知 schema：合法三态各通过", () => {
  for (const outcome of ["completed", "failed", "cancelled"]) {
    const parsed = v4OvernightCompletionNotificationSchema.safeParse({
      ...validSignal,
      outcome,
    });
    assert.equal(parsed.success, true, `outcome=${outcome} 应通过`);
    assert.equal(parsed.data.outcome, outcome);
  }
});

test("v4 通知 schema：strict——未知字段被拒", () => {
  const parsed = v4OvernightCompletionNotificationSchema.safeParse({
    ...validSignal,
    coordinatorTaskId: "sess-hidden-coordinator",
  });
  assert.equal(parsed.success, false, "多余字段必须被 .strict() 拒绝");
});

test("v4 通知 schema：非法 outcome 被拒", () => {
  assert.equal(
    v4OvernightCompletionNotificationSchema.safeParse({ ...validSignal, outcome: "running" })
      .success,
    false,
  );
});

test("v4 通知 schema：缺 morningReportReady / 空 runId / 空 parentTaskId 各被拒", () => {
  const { morningReportReady: _omit, ...noFlag } = validSignal;
  assert.equal(v4OvernightCompletionNotificationSchema.safeParse(noFlag).success, false);
  assert.equal(
    v4OvernightCompletionNotificationSchema.safeParse({ ...validSignal, runId: "" }).success,
    false,
  );
  assert.equal(
    v4OvernightCompletionNotificationSchema.safeParse({ ...validSignal, parentTaskId: "  " })
      .success,
    false,
  );
});

test("v4 通知 schema：morningReportReady 必须是布尔（不接受 truthy 替身）", () => {
  assert.equal(
    v4OvernightCompletionNotificationSchema.safeParse({ ...validSignal, morningReportReady: 1 })
      .success,
    false,
  );
});

test("v4 方法常量：v4/ 前缀、独立叶子（不进 legacy barrel / V4_NOTIFICATIONS）", () => {
  assert.equal(V4_OVERNIGHT_COMPLETION_METHOD, "v4/overnight/completion");
  assert.match(V4_OVERNIGHT_COMPLETION_METHOD, /^v4\//);
});

// ── ② host→main 反馈 schema ──────────────────────────────────────────
test("host→main schema：合法载荷通过并原样保留四字段", () => {
  const message = {
    type: HostResponseTypes.OvernightCompletionNotify,
    ...validSignal,
  };
  const parsed = hostOvernightCompletionNotifyResponseSchema.safeParse(message);
  assert.equal(parsed.success, true);
  assert.equal(parsed.data.type, "overnight-completion-notify");
  assert.equal(parsed.data.runId, validSignal.runId);
  assert.equal(parsed.data.parentTaskId, validSignal.parentTaskId);
  assert.equal(parsed.data.morningReportReady, true);
});

test("host→main schema：type 字面量与 HostResponseTypes 常量一致", () => {
  assert.equal(HostResponseTypes.OvernightCompletionNotify, "overnight-completion-notify");
});

test("host→main schema：strict——未知字段被拒", () => {
  assert.equal(
    hostOvernightCompletionNotifyResponseSchema.safeParse({
      type: HostResponseTypes.OvernightCompletionNotify,
      ...validSignal,
      coordinatorTaskId: "sess-hidden",
    }).success,
    false,
  );
});

// ── 判别联合注册（否则 Main 边界 safeParse 静默丢弃）───────────────────
test("hostResponseMessageSchema 判别联合已注册 OvernightCompletionNotify（不被静默丢弃）", () => {
  const message = {
    type: HostResponseTypes.OvernightCompletionNotify,
    ...validSignal,
  };
  // Main 侧 desktopHostProcess.ts 顶部就是 hostResponseMessageSchema.safeParse(message)；
  // 未注册进判别联合 → success:false → 消息在解析阶段被静默 return，永远到不了派发分支。
  const parsed = hostResponseMessageSchema.safeParse(message);
  assert.equal(parsed.success, true, "合法完成信号必须通过 Main 边界的联合校验");
  assert.equal(parsed.data.type, "overnight-completion-notify");
});

test("hostResponseMessageSchema：畸形完成信号在 Main 边界被拒（fail-closed，不静默透传）", () => {
  // 负向：outcome 非法 → 联合校验失败。证明守卫真实生效（畸形信号不会被当成合法消息派发）。
  const malformed = {
    type: HostResponseTypes.OvernightCompletionNotify,
    runId: "run-1",
    parentTaskId: "sess-parent",
    outcome: "succeeded", // 非法枚举值
    morningReportReady: true,
  };
  assert.equal(hostResponseMessageSchema.safeParse(malformed).success, false);
});

test("hostResponseMessageSchema：缺 morningReportReady 的完成信号被拒", () => {
  const { morningReportReady: _omit, ...noFlag } = validSignal;
  const message = { type: HostResponseTypes.OvernightCompletionNotify, ...noFlag };
  assert.equal(hostResponseMessageSchema.safeParse(message).success, false);
});
