// 脚本工作流 run 记录 → run 目录摘要的映射。
// 依据：apps/acode-cli/specs/script-workflow-revival.md R15.3 与验收场景 41。
//
// 纯函数，行为级断言。这里钉的三件事各自都有一个「错了会怎样」的具体后果：
//   - 状态词翻译错 → 目录页把「你停的」显示成「崩了」，或把还活着的 paused 说成已结束；
//   - resumable 报 true → 目录/侧栏亮出一个按下去必被拒的 Resume（那是 dwf 专属命令）；
//   - toolCallId 丢了 → 目录页的 hasDetailAnchor 把整行剔除，脚本 run 一条都显示不出来。

import assert from "node:assert/strict";
import test from "node:test";
import { toScriptWorkflowRunSummary } from "../packages/bootstrap/src/app/script-workflow-run-summary.ts";

/** 最小合法的 run 记录；只有 status 与各用例关心的字段在变。 */
function row(overrides = {}) {
  return {
    budgetSpent: 0,
    createdAt: 1_000,
    cwd: "/tmp/project",
    id: "wf_summary-test",
    kind: "script",
    name: "review-changes",
    parentSessionId: "sess_parent-1",
    scriptHash: "abc123",
    status: "completed",
    updatedAt: 2_000,
    ...overrides,
  };
}

test("状态词按 dwf 的五值词汇翻译，一个都不许错", () => {
  const cases = [
    ["completed", "completed", undefined],
    ["failed", "errored", undefined],
    // 用户停下不是脚本崩了：与实时投影的 workflow_cancelled 同一笔语义。
    ["cancelled", "stopped", "user"],
    ["pending", "running", undefined],
    ["running", "running", undefined],
    // paused 的 run 确实还活着；说成 stopped 会让读者以为可以不管了。
    ["paused", "running", undefined],
  ];
  for (const [from, to, stopReason] of cases) {
    const summary = toScriptWorkflowRunSummary(row({ status: from }));
    assert.equal(summary.status, to, `${from} 必须翻成 ${to}`);
    assert.equal(summary.stopReason, stopReason, `${from} 的 stopReason`);
  }
});

test("resumable 恒 false——这是同一条裁决的第三处，三处必须同结论", () => {
  // 脚本工作流确实能按 resumeFromRunId 续跑，但那是模型经 RunWorkflow 走的路，
  // 用户面前没有对应命令（/dwf resume 打到 dwf 的 run service，对 wf_ 前缀必然失败）。
  for (const status of ["completed", "failed", "cancelled", "running", "stopped"]) {
    assert.equal(
      toScriptWorkflowRunSummary(row({ status })).resumable,
      false,
      `${status} 的脚本 run 不得报可恢复`,
    );
  }
});

test("dialect 恒为 script，且 toolCallId 在场时必须带上", () => {
  const withId = toScriptWorkflowRunSummary(row({ toolCallId: "call_abc123" }));
  assert.equal(withId.dialect, "script");
  assert.equal(
    withId.toolCallId,
    "call_abc123",
    "目录页的 hasDetailAnchor 把缺 toolCallId 的摘要整条剔除——丢了这一位，行就不出现",
  );

  // 存量行（migration 0027 之前）没有这个事实：缺席即缺席，不用空串顶替。
  const withoutId = toScriptWorkflowRunSummary(row());
  assert.equal("toolCallId" in withoutId, false, "缺席时键本身不该出现");
});

test("label 用 run 名，updatedAt 原样透传（读侧不重排，序由服务端负责）", () => {
  const summary = toScriptWorkflowRunSummary(row({ name: "audit-deps", updatedAt: 12_345 }));
  assert.equal(summary.label, "audit-deps");
  assert.equal(summary.updatedAt, 12_345);
  assert.equal(summary.runId, "wf_summary-test");
});

test("失败原文只在有话可说时带上，且受 2048 上限约束", () => {
  // 摘要 schema 的 failureMessage 上限是 2048；超了会被 strict schema 整页拒掉，
  // 表现为桌面端「读取 run 摘要失败」——目录页与任务列表计数一起空白。
  const long = "x".repeat(5_000);
  const fromObject = toScriptWorkflowRunSummary(
    row({ failure: { message: long }, status: "failed" }),
  );
  assert.equal(fromObject.failureMessage?.length, 2048);

  const fromString = toScriptWorkflowRunSummary(row({ failure: "boom", status: "failed" }));
  assert.equal(fromString.failureMessage, "boom");

  // 没有失败就不带这个键：一个空的 failureMessage 会让每条 run 都挂一个噪音字段。
  const clean = toScriptWorkflowRunSummary(row());
  assert.equal("failureMessage" in clean, false);

  // 形状认不出的 failure 不编造文案。
  const odd = toScriptWorkflowRunSummary(row({ failure: { code: 42 }, status: "failed" }));
  assert.equal("failureMessage" in odd, false);
});
