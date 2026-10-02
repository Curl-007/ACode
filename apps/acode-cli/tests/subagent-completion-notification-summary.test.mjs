import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

/**
 * D3 审计「附带核验」（方案 A10 残留项）的证据测试：后台任务完成通知是否含
 * **自足的机器可读摘要**，以及三处终态表达之间是否存在不一致组合。
 *
 * 覆盖规格 apps/acode-cli/specs/command-terminal-state-audit.md 的 R1「附带核验」与 R2 E1/E2/E3。
 * 本项只记录、不修改产品代码。
 *
 * 结论：summary 满足约定（单行、含 status、failed 追加与 <error> 同文的原因）；
 * 三处终态表达之间**没有已确认可达**的不一致组合，但存在两处需要记录的非对称：
 *   (a) stopped 的 summary 不带原因，原因只在 registry 快照的 error 字段与输出文件里；
 *   (b) 同一次停止在四条通道上是四个不同的词（killed / stopped / stopped / cancelled），
 *       由 BACKGROUND_AGENT_STOPPED_STATE 常量表集中定义——跨通道一致性必须按表判。
 */

const root = new URL("../../../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const CLI = "apps/acode-cli/packages";

const { formatLocalAgentTaskNotification } = await import(
  "../packages/core/src/subagent/completion-notification.ts"
);
const { truncateTaskNotification, escapeXml } = await import(
  "../packages/core/src/runtime-task/notification.ts"
);

const BASE = {
  agentId: "agent_probe",
  agentType: "general-purpose",
  description: "collect evidence",
  outputFile: "/tmp/acode-agents/sess/agent_probe/output.txt",
  parentToolCallId: "toolu_probe",
};

function summaryOf(notification) {
  const match = /<summary>([\s\S]*?)<\/summary>/u.exec(notification);
  assert.ok(match, `通知缺 <summary> 节：\n${notification}`);
  return match[1];
}

function tagOf(notification, tag) {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "u").exec(notification);
  return match?.[1];
}

// ── 约定：单行 / 含 status / failed 含原因 ──────────────────────────

test("(1) summary 是单行、含 agentType + description + status", () => {
  for (const status of ["completed", "failed", "stopped"]) {
    const notification = formatLocalAgentTaskNotification({ ...BASE, status });
    const summary = summaryOf(notification);
    assert.equal(summary.includes("\n"), false, `${status} 的 summary 不是单行`);
    assert.equal(summary, `Agent general-purpose task &quot;collect evidence&quot; ${status}.`);
    // 机器可读：status 同时作为独立 XML 节出现，不必从散文里解析。
    assert.equal(tagOf(notification, "status"), status);
  }
});

test("(2) failed 的 summary 追加与 <error> 同文的失败原因（自足）", () => {
  const error = "provider 429: quota exhausted";
  const notification = formatLocalAgentTaskNotification({ ...BASE, error, status: "failed" });
  assert.equal(tagOf(notification, "error"), error);
  assert.equal(
    summaryOf(notification),
    `Agent general-purpose task &quot;collect evidence&quot; failed. ${escapeXml(error)}`,
  );
  // 读 summary 一行就能知道「失败了 + 为什么」，不需要再去开 outputFile。
  assert.match(summaryOf(notification), /quota exhausted/u);
});

test("(3) completed / stopped 不把 error 混进 summary；空白 error 也不追加", () => {
  const completed = formatLocalAgentTaskNotification({
    ...BASE,
    error: "should not leak",
    result: "the answer",
    status: "completed",
  });
  assert.equal(
    summaryOf(completed),
    'Agent general-purpose task &quot;collect evidence&quot; completed.',
  );
  assert.doesNotMatch(summaryOf(completed), /should not leak/u);
  assert.equal(tagOf(completed, "result"), "the answer");

  const blank = formatLocalAgentTaskNotification({ ...BASE, error: "   ", status: "failed" });
  assert.equal(
    summaryOf(blank),
    'Agent general-purpose task &quot;collect evidence&quot; failed.',
    "空白 error 不应追加成一个尾随空格",
  );
});

test("(4) 非对称记录：stopped 的 summary 不带原因，原因只在快照 error 与输出文件里", async () => {
  const notification = formatLocalAgentTaskNotification({ ...BASE, status: "stopped" });
  assert.equal(
    summaryOf(notification),
    'Agent general-purpose task &quot;collect evidence&quot; stopped.',
  );
  // finalizeBackgroundStopped 调用时不传 error 字段。
  const runner = await read(`${CLI}/core/src/subagent/runner.ts`);
  const stoppedCall = runner.slice(
    runner.indexOf("async function finalizeBackgroundStopped("),
    runner.indexOf("async function emitBackgroundTaskCompletedEvent("),
  );
  assert.match(stoppedCall, /status: BACKGROUND_AGENT_STOPPED_STATE\.notificationStatus/u);
  assert.doesNotMatch(stoppedCall, /error:/u, "stopped 通知开始携带 error：本非对称结论需复核");
  // 原因仍可从快照 error 字段读到（createBackgroundStoppedTask 写入）。
  const createState = runner.slice(
    runner.indexOf("function createBackgroundStoppedTask("),
    runner.indexOf("async function finalizeBackgroundStopped("),
  );
  assert.match(createState, /error: BACKGROUND_AGENT_STOPPED_STATE\.message/u);
  assert.match(
    createState,
    /status: BACKGROUND_AGENT_STOPPED_STATE\.registryStatus/u,
    "registry 侧的终态词不再是常量表里的 registryStatus",
  );
  // 输出文件也带同一句原因，所以「不带原因的 summary」不是信息丢失，只是不在通知里。
  const artifacts = runner.slice(
    runner.indexOf("async function writeStoppedAgentArtifacts("),
    runner.indexOf("async function writeAgentOutputFiles("),
  );
  assert.match(artifacts, /BACKGROUND_AGENT_STOPPED_STATE\.message/u);
  assert.match(artifacts, /status: BACKGROUND_AGENT_STOPPED_STATE\.subagentEventStatus/u);
});

test("(5) 四通道词表由一处常量集中定义（跨通道一致性按表判，不按字符串相等判）", async () => {
  const runner = await read(`${CLI}/core/src/subagent/runner.ts`);
  const table = runner.slice(
    runner.indexOf("const BACKGROUND_AGENT_STOPPED_STATE = {"),
    runner.indexOf("function createBackgroundStoppedTask("),
  );
  assert.match(table, /backgroundEventStatus: "cancelled"/u);
  assert.match(table, /notificationStatus: "stopped"/u);
  assert.match(table, /registryStatus: "killed"/u);
  assert.match(table, /subagentEventStatus: "stopped"/u);
});

// ── 三处终态表达之间是否存在不一致组合 ──────────────────────────────

test("(6) 快照 lost 不会产出 completed 通知：通知入口自己守了 task_missing", async () => {
  const runner = await read(`${CLI}/core/src/subagent/runner.ts`);
  // enqueueBackgroundNotification 在 registry 条目缺失时拒发（reason: task_missing）。
  const enqueue = runner.slice(
    runner.indexOf("function enqueueBackgroundNotification("),
    runner.indexOf("function traceContextFromRuntimeTask("),
  );
  assert.match(enqueue, /if \(!task \|\| task\.notified\) \{/u);
  assert.match(enqueue, /reason: task \? "already_notified" : "task_missing"/u);
  // `lost` 在 runner.ts 里只作为**读取兜底**出现，从不被写进 registry。
  const lostOccurrences = runner.match(/"lost"/gu) ?? [];
  assert.equal(lostOccurrences.length, 1, "runner.ts 出现新的 lost 字面量：本结论需复核");
  assert.match(
    runner,
    /isTerminalRuntimeTask\(registry\.get\(lifecycle\.agentId\) \?\? \{ status: "lost" \}\)/u,
  );
});

test("(6b) 未确认项：条目缺失时 SubagentStopped(completed) 事件仍会发出（无可达产出方）", async () => {
  // finalizeBackgroundCompletion 的守卫是 `current && isTerminalRuntimeTask(current)`：
  // 条目**缺失**时守卫不触发，随后 registry.update 返回 undefined（不写快照）、
  // enqueueBackgroundNotification 拒发（task_missing）、BackgroundTaskCompleted 被 `if (task)` 挡掉，
  // 但 emitSubagentEvent(SubagentStopped, status:"completed") 是无条件的。
  const runner = await read(`${CLI}/core/src/subagent/runner.ts`);
  const completion = runner.slice(
    runner.indexOf("async function finalizeBackgroundCompletion("),
    runner.indexOf("async function finalizeBackgroundFailure("),
  );
  assert.match(completion, /if \(current && isTerminalRuntimeTask\(current\)\) return;/u);
  assert.match(completion, /if \(task\) \{/u);
  const afterGuard = completion.slice(
    completion.indexOf("if (task) {"),
    completion.indexOf("options.logger?.info("),
  );
  assert.match(afterGuard, /SessionEventType\.SubagentStopped/u);
  assert.match(afterGuard, /status: "completed"/u);
  // 审计未找到可达产出方：runner.ts 的四处 registry.remove 全是 setup 失败即 throw 的路径，
  // 都发生在 completionPromise 之前。故此条登记为「未确认」，不写成已确认缺口。
  assert.equal(runner.match(/registry\.remove\(lifecycle\.agentId\);/gu)?.length, 4);
});

// ── 机器可读性与边界 ────────────────────────────────────────────────

test("(7) 通知是结构化 XML：status/summary/result/error/usage 各成节，usage 四项可机读", () => {
  const notification = formatLocalAgentTaskNotification({
    ...BASE,
    result: "the answer",
    status: "completed",
    totalDurationMs: 1234,
    totalTokens: 900,
    totalToolUseCount: 7,
    usage: { inputTokens: 100, outputTokens: 200, totalTokens: 900 },
  });
  assert.equal(tagOf(notification, "task-id"), "agent_probe");
  assert.equal(tagOf(notification, "tool-use-id"), "toolu_probe");
  assert.equal(tagOf(notification, "task-type") ?? "local_agent", "local_agent");
  assert.equal(tagOf(notification, "output-file"), BASE.outputFile);
  const usage = tagOf(notification, "usage");
  assert.match(usage, /<subagent_tokens>900<\/subagent_tokens>/u);
  assert.match(usage, /<tool_uses>7<\/tool_uses>/u);
  assert.match(usage, /<duration_ms>1234<\/duration_ms>/u);
});

test("(8) 转义与截断：summary 里的引号/尖括号被转义，超长通知在 120k 处截断", () => {
  const notification = formatLocalAgentTaskNotification({
    ...BASE,
    description: 'say "hi" <b>now</b> & go',
    status: "completed",
  });
  const summary = summaryOf(notification);
  assert.doesNotMatch(summary, /<b>/u);
  assert.match(summary, /&lt;b&gt;now&lt;\/b&gt;/u);
  assert.match(summary, /&amp;/u);
  // 单行性在含换行的 description 下**不**成立——记录为已知边界，不是本次判定的约定项。
  const multiline = formatLocalAgentTaskNotification({
    ...BASE,
    description: "line1\nline2",
    status: "completed",
  });
  assert.match(summaryOf(multiline), /line1\nline2/u);

  assert.equal(truncateTaskNotification("x".repeat(120_000)).length, 120_000);
  const truncated = truncateTaskNotification("x".repeat(120_001));
  assert.match(truncated, /\[truncated\]$/u);
});
