import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import "./helpers/minimal-dom-shim.js";
import { MiniDocument, serializeDom } from "./helpers/minimal-dom-shim.js";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { createElement, type ReactNode } from "react";

register(new URL("./helpers/svg-load-hook.mjs", import.meta.url));
// toast 的懒挂载用 rAF 重试（toast.tsx 的 tryAdd 分支）；shim 不提供，按仓库既有 dom
// 测试补桩，否则首条提示的重试会抛 ReferenceError 把用例打挂。
(globalThis as Record<string, unknown>).requestAnimationFrame = (callback: FrameRequestCallback) =>
  setTimeout(callback, 0);
(globalThis as Record<string, unknown>).cancelAnimationFrame = (id: number) => clearTimeout(id);
const { TeamApprovalActions } = await import("../src/components/TeamApprovalActions.js");
const { TeamWorkflowCard } = await import("../src/components/TeamWorkflowCard.js");
const { ACodeIntlProvider } = await import("../src/i18n/IntlProvider.js");
// 目标仓库的 Provider 懒加载词典；客户端渲染前先完成 en-US 词典求值，
// 否则首次 createRoot 会抛出待决 promise 挂起，flushSync 返回时树还不存在。
const { getLocaleMessagesResource } = await import("../src/i18n/localeMessages.js");
const localeResource = getLocaleMessagesResource("en-US");
if (localeResource.state === "pending") await localeResource.promise;
type ConversationStatusPanelTeam =
  import("../src/v4/teamPanelModel.js").ConversationStatusPanelTeam;

/**
 * SPEC-012 卡片侧回归（docs/prd/fix-spec-012-implementation-gaps.md §1.2 与 §3）：
 * 1. 长任务清单必须有出口（「还有 N 项」）——修复前 onOpenAll 从不传，分组超过 5 项被静默截断；
 * 2. 剪贴板不可用时「复制批准语」必须给反馈——修复前直接 return，点击零反馈。
 *
 * shim 不做事件派发（见 minimal-dom-shim 头注），点击按 SkillSuggestionBlock.test 的
 * 手法读 React 挂载的 `__reactProps$` 后直接调用。
 */

function makeTeam(
  overrides: Partial<ConversationStatusPanelTeam> = {},
): ConversationStatusPanelTeam {
  const tasks = Array.from({ length: 8 }, (_, index) => ({
    taskId: `t-${index + 1}`,
    title: `任务 ${index + 1}`,
    status: "todo",
    kind: "build",
    dependencies: [],
  }));
  return {
    teamId: "team-cutoff",
    goal: "验证缺口",
    status: "draft",
    counts: { done: 0, inProgress: 0, todo: tasks.length, failed: 0, blocked: 0 },
    totalCount: tasks.length,
    members: [{ name: "dev-1", role: "implementer", status: "bound" }],
    tasks,
    readyTaskIds: tasks.map((task) => task.taskId),
    hasTaskDerivations: true,
    criticalPathDepth: 1,
    blockedByFailedQuality: [],
    mailboxes: [],
    unreadMessages: [],
    maxMembers: 4,
    ...overrides,
  };
}

type MiniNode = {
  tagName?: string;
  textContent?: string | null;
  childNodes?: MiniNode[];
  parentNode?: MiniNode | null;
  attributes?: Record<string, string>;
} & Record<string, unknown>;

/** 深度优先找第一个满足 testid 的节点（shim 无 querySelector）。 */
function findByTestId(root: MiniNode, testId: string): MiniNode {
  let found: MiniNode | null = null;
  const walk = (node: MiniNode) => {
    if (found) return;
    if (node.attributes?.["data-testid"] === testId) {
      found = node;
      return;
    }
    for (const child of node.childNodes ?? []) walk(child);
  };
  walk(root);
  assert.ok(found, `必须渲染 data-testid=${testId}`);
  return found as MiniNode;
}

function reactOnClick(node: MiniNode): () => void {
  const key = Object.getOwnPropertyNames(node).find((name) => name.startsWith("__reactProps$"));
  assert.ok(key, "节点上必须挂着 React props");
  const props = node[key] as { onClick?: () => void };
  assert.ok(props.onClick, "目标节点必须有 onClick");
  return props.onClick as () => void;
}

function renderDom(node: ReactNode): { container: MiniNode; unmount: () => void } {
  const doc = new MiniDocument();
  const container = doc.createElement("div");
  doc.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  flushSync(() => root.render(node));
  return {
    container: container as unknown as MiniNode,
    unmount: () => flushSync(() => root.unmount()),
  };
}

function withIntl(node: ReactNode): ReactNode {
  return createElement(ACodeIntlProvider, { initialLocale: "en-US", children: node });
}

function bodyText(): string {
  const body = (globalThis as unknown as { document: MiniDocument }).document
    .body as unknown as MiniNode;
  const collect = (node: MiniNode): string =>
    `${node.textContent ?? ""}${(node.childNodes ?? []).map(collect).join("")}`;
  return collect(body);
}

test("内联任务清单：分组超过 5 项时给出口，文案带折叠数", () => {
  const { container, unmount } = renderDom(
    withIntl(createElement(TeamWorkflowCard, { team: makeTeam(), onOpen: () => {} })),
  );
  try {
    // 8 个任务、每组上限 5 → 恰有 3 项被折叠。断言必须钉在任务清单自己的出口上：
    // 时间线名册另有一行同文案的「还有 N 项」（workflow-roster-more-row），只匹配文案会假绿。
    const more = findByTestId(container, "team-inline-more");
    assert.match(String(more.textContent ?? ""), /3 more/);
  } finally {
    unmount();
  }
});

test("内联任务清单：无落点时不渲染出口（不出现点不动的死按钮）", () => {
  const { container, unmount } = renderDom(
    withIntl(createElement(TeamWorkflowCard, { team: makeTeam() })),
  );
  try {
    // 同名出口在时间线名册另有实现（workflow-roster-more-row），这里只断言任务清单的出口缺席。
    assert.doesNotMatch(serializeDom(container as never), /data-testid="team-inline-more"/);
  } finally {
    unmount();
  }
});

test("复制批准语：剪贴板不可用时给出反馈（不再静默 return）", async () => {
  // Node 下 navigator.clipboard 本就是 undefined，覆盖「能力缺席」这一真实分支。
  assert.equal(
    (navigator as { clipboard?: unknown }).clipboard,
    undefined,
    "前置：本环境必须没有剪贴板能力，否则该用例失去意义",
  );
  const { container, unmount } = renderDom(
    withIntl(createElement(TeamApprovalActions, { team: makeTeam() })),
  );
  try {
    const copyButton = findByTestId(container, "team-approval-copy");
    flushSync(() => reactOnClick(copyButton)());
    // toast 的容器懒挂载：首条提示经 rAF 重试后才落 DOM，等一拍再断言。
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.match(bodyText(), /Copy failed; check clipboard permission/);
  } finally {
    unmount();
  }
});
