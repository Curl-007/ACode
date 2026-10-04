import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

/**
 * heartbeat 通知决策协议的跨包源码不变量守护
 *（packages/desktop/specs/automation-heartbeat-protocol.md，仿 no-telemetry.test.mjs 模式）。
 *
 * 协议横跨 desktop host / services syncer / services bots / scheduler / CLI 工具描述，
 * 任何一处被回退（未读重新无条件写、门被摘、注入被删、清理调用被删）都意味着
 * 「默认安静」承诺失效——刷屏回归。本测试钉住五个执行点的关键结构。
 */

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
// 仓库 .ts 文件行尾混合（部分 CRLF），统一归一化避免按检出环境误报。
const read = (rel) => readFileSync(`${repoRoot}/${rel}`, "utf8").replace(/\r\n/g, "\n");

test("R2 host 注入：dispatchCronRun 的 sendPrompt 后缀拼接指令常量", () => {
  const source = read("packages/desktop/src/host/index.ts");
  assert.ok(
    source.includes("content: request.prompt + AUTOMATION_NOTICE_INSTRUCTION"),
    "dispatchCronRun 必须在作者 prompt 后拼接 AUTOMATION_NOTICE_INSTRUCTION（Q3 裁决：后缀注入）",
  );
  assert.ok(
    source.includes("import {\n  HostMessageTypes") &&
      source.includes("AUTOMATION_NOTICE_INSTRUCTION,"),
    "指令常量必须来自 @acode/shared（协议词汇唯一家），不得在 host 内联第二份",
  );
});

test("R1/R2 host settle：流式累积 + 决策解析 + 条件未读（无条件 unread:true 不得回潮）", () => {
  const source = read("packages/desktop/src/host/index.ts");
  assert.ok(
    source.includes("appendAutomationNoticeTail(automationNoticeTail, event.content)"),
    "trackCronRunOutcome 必须在订阅窗内累积本 run 主 agent 正文尾部",
  );
  assert.ok(
    source.includes("parseAutomationNotice(automationNoticeTail)"),
    "终态必须经共享解析器判定（不得自写正则）",
  );
  assert.ok(
    source.includes('if (notifyDecision === "notify" || result.outcome === "failed") {'),
    "未读写入必须被 NOTIFY/failed 门控（R1：默认安静、失败恒通知）",
  );
  assert.ok(
    !source.includes("统一置为未读"),
    "旧的「终态统一置未读」语义注释不得回潮（已被 heartbeat 协议 R1 取代）",
  );
});

test("R1 syncer 门：automation 任务不再发 background_terminal 未读信号（第二写入方）", () => {
  const source = read("packages/services/src/acode-agent/acodeTaskIndexSyncer.ts");
  assert.ok(source.includes("isCronTask"), "syncer 必须引入 isCronTask 判定");
  assert.ok(
    source.includes("automationOwned") &&
      /const automationOwned = .*isCronTask\(meta\);/.test(source),
    "applyTerminalTransition 必须对 automation 任务抑制 unreadSignal（否则 UI 侧独立标未读，默认安静失效）",
  );
  assert.ok(
    source.includes("const effectiveUnreadSignal = automationOwned ? undefined : unreadSignal;"),
    "抑制必须发生在信号源头（广播与回源 fallback 同源使用 effectiveUnreadSignal）",
  );
});

test("R3 bots 门：automation 回推与桌面未读同源（共享解析器 + runId 透传）", () => {
  const bots = read("packages/services/src/bots/botsService.ts");
  assert.ok(
    bots.includes("appendAutomationNoticeTail(automationNoticeTail, event.content)"),
    "watchTaskStream 必须为 automation watch 累积决策尾部",
  );
  assert.ok(
    bots.includes(
      'if (automationNotice && parseAutomationNotice(automationNoticeTail) !== "notify") {',
    ),
    "task_complete 回推前必须过决策门（notify 才推；task_error 分支在此之前已恒推）",
  );
  const params = read("packages/services/src/bots/bots.ts");
  assert.ok(
    params.includes("runId: string;"),
    "BotAutomationRunWatchParams 必须携带 runId（诊断关联）",
  );
  const delivery = read("packages/desktop/src/host/cronBotDelivery.ts");
  assert.ok(
    delivery.includes("runId: params.runId,"),
    "watchCronRunBotDelivery 必须把 runId 透传给 botsService",
  );
  const lifecycle = read("packages/desktop/src/host/cronRunLifecycle.ts");
  assert.ok(
    lifecycle.includes("notifyDecision?: ACodeAutomationNotifyDecision") &&
      lifecycle.includes("params.notifyDecision,"),
    "settle 链路必须把决策写进 run 台账（R4）",
  );
});

test("R5 scheduler 启动清理：pruneRuns 有调用方 + 耗尽 automation 过窗删除", () => {
  const source = read("packages/desktop/src/scheduler/index.ts");
  assert.ok(
    source.includes("repo.pruneRuns(AUTOMATION_RUN_HISTORY_RETENTION_MS)"),
    "pruneRuns 死代码必须保持接线（R5a，30 天窗）",
  );
  assert.ok(
    source.includes("repo.pruneExhaustedAutomations(") &&
      source.includes("AUTOMATION_EXHAUSTED_RETENTION_MS"),
    "耗尽 automation 保留清理必须在 scheduler 启动序列（R5b，7 天窗，Q1 裁决）",
  );
});

test("R7 CLI 描述：注入协议说明在场，且旧的「不会自动删除」矛盾句已修正", () => {
  const source = read("apps/acode-cli/packages/core/src/tool/handlers/cron.ts");
  assert.ok(
    source.includes("notification-decision protocol"),
    "CronCreate 必须告知模型运行时自动追加通知决策协议（不要自带 NOTIFY 指令）",
  );
  assert.ok(
    !source.includes("they are not session-only or auto-deleted"),
    "与 R5b 矛盾的旧句不得回潮（耗尽 automation 现有 7 天保留窗自动清理）",
  );
});
