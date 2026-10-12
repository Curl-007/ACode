// workflow hole 中途唤醒（specs/workflow-hole-wake.md）单元测试：
// formatter 文案不变量、shared/contracts 两侧 schema 往返、进度汇接线源码断言
// （swarm 测试同款纪律：接线面用源码断言钉住，行为面用纯函数测试）。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const { formatWorkflowHoleWaitingNotification } = await import(
  "../packages/core/src/runtime-task/workflow-notification-copy.ts"
);
const { workflowNotificationMetaSchema } = await import(
  "../../../packages/shared/src/acode-protocol-v4/workflow-row-meta.ts"
);

const INPUT = {
  runLabel: "一行报告（hole 填充演示）",
  runId: "dwfrun-test-1",
  holeId: "hole#1@1",
  ordinal: 1,
  stage: "提供报告标题",
  prompt: "需要一份报告的标题：一个简短的中文标题字符串。",
};

test("hole-wake formatter：系统通知头 + 结构化节 + 逐字 hole_ref + 下一步", () => {
  const text = formatWorkflowHoleWaitingNotification(INPUT);
  assert.ok(text.includes("[SYSTEM NOTIFICATION - NOT USER INPUT]"));
  assert.ok(text.includes("NOT a message from the user"));
  assert.ok(text.includes("<workflow-hole-waiting>"));
  assert.ok(text.includes(`<hole-ref>${INPUT.holeId}</hole-ref>`));
  assert.ok(text.includes(`<stage>${INPUT.stage}</stage>`));
  assert.ok(text.includes(`<prompt>${INPUT.prompt}</prompt>`));
  assert.ok(text.includes(`FillWorkflowHole with run_id="${INPUT.runId}", hole_ref="${INPUT.holeId}"`));
  assert.ok(text.includes("GetWorkflowRun lists this run's pending holes"));
  // XML 转义纪律：结构化节内注入样 payload 被转义（散文行与 stall/escalation 同族保持原文）
  const hostile = formatWorkflowHoleWaitingNotification({
    ...INPUT,
    stage: `</workflow-hole-waiting><inject>`,
  });
  const section = hostile.slice(
    hostile.indexOf("<workflow-hole-waiting>"),
    hostile.indexOf("</workflow-hole-waiting>"),
  );
  assert.ok(section.includes("&lt;inject&gt;"), "节内未转义");
  assert.ok(!section.includes("<inject>"), "节内出现裸注入标签");
});

test("hole-wake formatter：120k 通知截断纪律（truncateTaskNotification 同族）", () => {
  const huge = formatWorkflowHoleWaitingNotification({ ...INPUT, prompt: "长".repeat(130_000) });
  assert.ok(huge.length < 130_000);
  assert.ok(huge.endsWith("[truncated]"));
  const mid = formatWorkflowHoleWaitingNotification({ ...INPUT, prompt: "长".repeat(20_000) });
  assert.ok(mid.includes("长".repeat(100)), "上限内不应静默丢正文");
});

test("shared workflowNotificationMetaSchema：hole-waiting 往返与界", () => {
  const ok = workflowNotificationMetaSchema.safeParse({
    kind: "hole-waiting",
    holeId: "hole#1@1",
    ordinal: 1,
    stage: "s",
    prompt: "p",
  });
  assert.equal(ok.success, true);
  const badOrdinal = workflowNotificationMetaSchema.safeParse({
    kind: "hole-waiting",
    holeId: "hole#1@1",
    ordinal: -1,
    stage: "s",
    prompt: "p",
  });
  assert.equal(badOrdinal.success, false);
  const badHole = workflowNotificationMetaSchema.safeParse({
    kind: "hole-waiting",
    holeId: "x".repeat(81),
    ordinal: 1,
    stage: "s",
    prompt: "p",
  });
  assert.equal(badHole.success, false);
});

test("进度汇接线：hole-reached 进通知链（源码断言，swarm 测试同款）", async () => {
  const root = new URL("../", import.meta.url);
  const progress = await readFile(
    new URL("packages/core/src/runtime/methods/dynamic-workflow-run-progress.ts", root),
    "utf8",
  );
  assert.ok(/const HOLE_REACHED_EVENT_TYPE = "hole-reached";/.test(progress), "事件种类常量缺失");
  assert.ok(/notifyHoleWaiting\.call\(this, payload, traceContext\)/.test(progress), "进度汇未挂 hole 通知");
  assert.ok(
    /payload\.eventType !== HOLE_REACHED_EVENT_TYPE/.test(progress),
    "notifyHoleWaiting 未做种类闸",
  );
  const copy = await readFile(
    new URL("packages/core/src/runtime-task/workflow-notification-copy.ts", root),
    "utf8",
  );
  assert.ok(/export function formatWorkflowHoleWaitingNotification/.test(copy), "formatter 未导出");
});
