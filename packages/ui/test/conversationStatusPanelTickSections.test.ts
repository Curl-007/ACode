// ConversationStatusPanel 批次 7 第二阶段：四个秒级分区的渲染契约测试。
//
// 批次 6 的 `conversationStatusPanelSections.test.ts` 钉住了无 tick 分区（environment/plan/
// team/已结束页脚）。本文件补上**批次 7 外迁的四个带秒针分区**（Goal / Terminals /
// Workflows / Agents）的 renderToStaticMarkup 结构契约——它们是「行为保持的重构」
// （setInterval → useNowTicker）的对照基线：迁完后结构锚点必须逐字不变。
//
// 口径同前序：Radix Collapsible 在 SSR 下按 open 状态渲染，DropdownMenu/Tooltip 走 Portal
// 只钉 Trigger 侧。秒针本身（setInterval）不参与 SSR 断言——它的开启条件由
// `conversationStatusPanelTicks.test.ts` 的决策表覆盖（无 jsdom 时的固定验收第 4 条口径）。
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { BackgroundWorkSummary } from "@acode/shared/acode-protocol-v4";
import { ACodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { getLocaleMessagesResource } from "../src/i18n/localeMessages.js";
import { TooltipProvider } from "../src/components/ui/tooltip.js";
import { GoalStatusSection } from "../src/v4/conversation-status-panel/GoalStatusSection.js";
import { BackgroundWorkStatusSection } from "../src/v4/conversation-status-panel/BackgroundWorkStatusSection.js";
import { WorkflowStatusSection } from "../src/v4/conversation-status-panel/WorkflowStatusSection.js";
import { SubagentStatusSection } from "../src/v4/conversation-status-panel/SubagentStatusSection.js";
import type { ConversationStatusPanelModel } from "../src/v4/conversationStatusPanelModel.js";

test.before(async () => {
  await getLocaleMessagesResource("en-US").promise;
});

const render = (node: unknown): string =>
  renderToStaticMarkup(
    createElement(
      ACodeIntlProvider,
      { initialLocale: "en-US" },
      createElement(TooltipProvider, {}, node as React.ReactElement),
    ),
  );

const work = (overrides: Partial<BackgroundWorkSummary> = {}): BackgroundWorkSummary =>
  ({
    workId: "w-1",
    kind: "bash",
    title: "Running build",
    status: "running",
    startedAt: 1_000,
    cancellable: true,
    ...overrides,
  }) as unknown as BackgroundWorkSummary;

// ---- GoalStatusSection ----

test("Goal：无 goal 时整段缺席", () => {
  const html = render(
    createElement(GoalStatusSection, {
      model: { goal: null } as unknown as ConversationStatusPanelModel,
      separated: false,
    }),
  );
  assert.equal(html, "");
});

test("Goal：分区锚点、标题与秒级用时锚点在场", () => {
  const html = render(
    createElement(GoalStatusSection, {
      model: {
        goal: { status: "active", objective: "Ship it", activeRunStartedAtMs: Date.now(), verifications: [], iteration: 1 },
      } as unknown as ConversationStatusPanelModel,
      separated: false,
    }),
  );
  assert.match(html, /data-status-section="goal"/);
  assert.match(html, /data-goal-elapsed-seconds="\d+"/);
});

test("Goal：active 态出暂停按钮，paused 态出继续按钮，verified 态出完成图标", () => {
  const active = render(
    createElement(GoalStatusSection, {
      model: { goal: { status: "active", objective: "o", verifications: [], iteration: 1 } } as unknown as ConversationStatusPanelModel,
      separated: false,
      onPauseGoal: () => {},
    }),
  );
  assert.match(active, /data-goal-action="pause"/);

  const paused = render(
    createElement(GoalStatusSection, {
      model: { goal: { status: "paused", objective: "o", verifications: [], iteration: 1 } } as unknown as ConversationStatusPanelModel,
      separated: false,
      onResumeGoal: () => {},
    }),
  );
  assert.match(paused, /data-goal-action="resume"/);

  const verified = render(
    createElement(GoalStatusSection, {
      model: { goal: { status: "verified", objective: "o", verifications: [], iteration: 1 } } as unknown as ConversationStatusPanelModel,
      separated: false,
    }),
  );
  assert.match(verified, /lucide-circle-check-big/);
});

// ---- BackgroundWorkStatusSection (Terminals) ----

test("Terminals：空列表整段缺席（即使传了 title 也不渲染分区壳）", () => {
  const html = render(
    createElement(BackgroundWorkStatusSection, {
      section: "terminal",
      title: "Terminals",
      works: [],
      separated: false,
    }),
  );
  assert.equal(html, "");
});

test("Terminals：行带 work-id / status 锚点，默认收起不渲染行内容", () => {
  const html = render(
    createElement(BackgroundWorkStatusSection, {
      section: "terminal",
      title: "Terminals",
      works: [work()],
      separated: false,
    }),
  );
  assert.match(html, /data-status-section="terminal"/);
  // defaultOpen=false → 收起态，行内容不输出（CollapsibleContent 未展开）
  assert.doesNotMatch(html, /data-work-id="w-1"/);
});

test("Terminals：受控 open=true 时渲染行并带 work-id 锚点", () => {
  const html = render(
    createElement(BackgroundWorkStatusSection, {
      section: "terminal",
      title: "Terminals",
      works: [work()],
      open: true,
      separated: false,
    }),
  );
  assert.match(html, /data-work-id="w-1"/);
  assert.match(html, /Running build/);
});

test("Terminals：cancellable=false 的行不出 Stop 按钮", () => {
  const html = render(
    createElement(BackgroundWorkStatusSection, {
      section: "terminal",
      title: "Terminals",
      works: [work({ cancellable: false })],
      open: true,
      separated: false,
    }),
  );
  assert.doesNotMatch(html, /background-work-cancel|runningStop/i);
});

// ---- WorkflowStatusSection ----

test("Workflows：无活动 run 且无已结束计数时整段缺席", () => {
  const html = render(
    createElement(WorkflowStatusSection, {
      title: "Workflows",
      runs: [],
      endedRunCount: 0,
      separated: false,
    }),
  );
  assert.equal(html, "");
});

test("Workflows：只剩已结束 run 时仍渲染分区（保住目录入口）", () => {
  const html = render(
    createElement(WorkflowStatusSection, {
      title: "Workflows",
      runs: [],
      endedRunCount: 2,
      open: true,
      separated: false,
      parentSessionId: "s-1",
      onOpenDirectory: () => {},
    }),
  );
  assert.match(html, /data-status-section="workflow"/);
  assert.match(html, /workflow-run-directory-trigger/);
});

test("Workflows：偏斜降级行（无 status/无 startedAt）不输出状态点与步数", () => {
  const html = render(
    createElement(WorkflowStatusSection, {
      title: "Workflows",
      runs: [{ runId: "r-1", title: "run" }] as never,
      endedRunCount: 0,
      open: true,
      separated: false,
    }),
  );
  assert.match(html, /data-workflow-run-id="r-1"/);
  assert.doesNotMatch(html, /data-workflow-run-status-dot/);
});

test("Workflows：带 status 的行输出状态点与步数", () => {
  const html = render(
    createElement(WorkflowStatusSection, {
      title: "Workflows",
      runs: [
        {
          runId: "r-1",
          title: "run",
          status: "running",
          nodesSettled: 1,
          nodesTotal: 3,
        },
      ] as never,
      endedRunCount: 0,
      open: true,
      separated: false,
    }),
  );
  assert.match(html, /data-workflow-run-status-dot="running"/);
});

test("Workflows：未命名 run（title ≡ runId）回退到 fallback 名称", () => {
  const html = render(
    createElement(WorkflowStatusSection, {
      title: "Workflows",
      runs: [{ runId: "r-1", title: "r-1" }] as never,
      endedRunCount: 0,
      open: true,
      separated: false,
    }),
  );
  assert.doesNotMatch(html, />r-1</);
});

// ---- SubagentStatusSection ----

test("Agents：无活动 subagent 且无已结束计数时整段缺席", () => {
  const html = render(
    createElement(SubagentStatusSection, {
      title: "Agents",
      subagents: [],
      endedSubagentCount: 0,
      separated: false,
    }),
  );
  assert.equal(html, "");
});

test("Agents：只剩已结束 subagent 时仍渲染分区（保住目录入口）", () => {
  const html = render(
    createElement(SubagentStatusSection, {
      title: "Agents",
      subagents: [],
      endedSubagentCount: 1,
      open: true,
      separated: false,
      parentSessionId: "s-1",
      onOpenSubagentDirectory: () => {},
    }),
  );
  assert.match(html, /data-status-section="agent"/);
});

test("Agents：受控展开时行带 child-session-id 锚点", () => {
  const html = render(
    createElement(SubagentStatusSection, {
      title: "Agents",
      subagents: [
        {
          childSessionId: "c-1",
          title: "child",
          startedAt: 1_000,
          cancellable: true,
          controlWorkId: "w-1",
        },
      ] as never,
      endedSubagentCount: 0,
      open: true,
      separated: false,
    }),
  );
  assert.match(html, /data-child-session-id="c-1"/);
  assert.match(html, /data-background-task-kind="agent"/);
});

test("Agents：行按 startedAt 升序（投影无序，分区自己排）", () => {
  const html = render(
    createElement(SubagentStatusSection, {
      title: "Agents",
      subagents: [
        { childSessionId: "late", title: "late", startedAt: 2_000, cancellable: false },
        { childSessionId: "early", title: "early", startedAt: 1_000, cancellable: false },
      ] as never,
      endedSubagentCount: 0,
      open: true,
      separated: false,
    }),
  );
  assert.ok(html.indexOf('data-child-session-id="early"') < html.indexOf('data-child-session-id="late"'));
});
