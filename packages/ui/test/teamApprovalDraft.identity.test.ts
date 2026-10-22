import assert from "node:assert/strict";
import test from "node:test";
import "./helpers/minimal-dom-shim.js";
import { MiniDocument } from "./helpers/minimal-dom-shim.js";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { createElement, type ReactNode } from "react";
import { useTeamApprovalDraft } from "../src/hooks/useTeamApprovalDraft.js";
import { TabStoreProvider, useTabStoreApi } from "../src/store/TabStoreProvider.js";
import type { TabStore } from "../src/store/tabStore.js";
import { useACodeSessionStore } from "../src/store/acodeSessionStore.js";

/**
 * 「填入批准语」的身份回归测试（docs/prd/fix-spec-012-implementation-gaps.md §1.1）。
 *
 * 判据只取一件事：请求落进了哪个 workspace 桶。composer 按 `resolveWorkspaceStateKey`
 * 读（`workspaceIdentity?.trim() || workspacePath`），请求只要没落进身份桶，用户在
 * 远程/隔离工作区点按钮就毫无反应——这正是修复前的缺陷形态（第三参传 undefined）。
 *
 * 渲染路径与生产一致：TabStoreProvider → 消费组件 → useTeamApprovalDraft。
 * 必须用 createRoot + flushSync：SSR 的 useSyncExternalStore 在单次渲染里不重读
 * 渲染中途的 setState，seed 拿不到（仓库既有 dom 测试同一形态）。
 */

const PATH = "/w";
const IDENTITY = "remote:/w";

type InsertFn = (text: string) => void;

function storeState() {
  return useACodeSessionStore.getState() as unknown as {
    workspaces: Record<string, { composerTextInsertRequest?: { text: string; mode?: string } }>;
  };
}

function renderInsert(tab: { path: string | null; identity: string | null }): InsertFn {
  const doc = new MiniDocument();
  const container = doc.createElement("div");
  doc.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  const tabRef: { current: TabStore | null } = { current: null };
  let insert: InsertFn | null = null;

  function StoreProbe() {
    tabRef.current = useTabStoreApi();
    return null;
  }
  function InsertProbe() {
    insert = useTeamApprovalDraft().insertApprovalText;
    return null;
  }

  const tree = (): ReactNode =>
    createElement(TabStoreProvider, {
      children: createElement("div", null, createElement(StoreProbe), createElement(InsertProbe)),
    });

  try {
    // 第一遍：拿 provider 内的 store 引用。
    flushSync(() => root.render(tree()));
    assert.ok(tabRef.current, "TabStoreProvider 必须提供 store");
    // 造数据后再渲染一遍：这一次 hook 读到的就是目标 tab 状态。
    tabRef.current.setState({
      activeWorkspacePath: tab.path,
      activeWorkspaceIdentity: tab.identity,
    });
    flushSync(() => root.render(tree()));
    assert.ok(insert, "hook 必须交出 insertApprovalText");
    return insert as InsertFn;
  } finally {
    flushSync(() => root.unmount());
  }
}

test("远程/隔离工作区：批准语写进身份桶，且不污染 path 桶", () => {
  useACodeSessionStore.setState({ workspaces: {} });
  const insert = renderInsert({ path: PATH, identity: IDENTITY });
  insert("批准团队 team-1 的计划");
  const workspaces = storeState().workspaces;
  assert.equal(workspaces[IDENTITY]?.composerTextInsertRequest?.text, "批准团队 team-1 的计划");
  // mode 必须是 append（不覆盖用户已经打了一半的草稿）。
  assert.equal(workspaces[IDENTITY]?.composerTextInsertRequest?.mode, "append");
  assert.equal(workspaces[PATH], undefined);
});

test("本地工作区（identity 为 null）：退回 path 桶，行为与修复前一致", () => {
  useACodeSessionStore.setState({ workspaces: {} });
  const insert = renderInsert({ path: PATH, identity: null });
  insert("批准团队 team-2 的计划");
  const workspaces = storeState().workspaces;
  assert.equal(workspaces[PATH]?.composerTextInsertRequest?.text, "批准团队 team-2 的计划");
  assert.equal(workspaces[PATH]?.composerTextInsertRequest?.mode, "append");
  assert.equal(workspaces[IDENTITY], undefined);
});

test("无活跃工作区：不写入任何桶（warn 分支）", () => {
  useACodeSessionStore.setState({ workspaces: {} });
  const insert = renderInsert({ path: null, identity: null });
  insert("批准团队 team-3 的计划");
  assert.deepEqual(storeState().workspaces, {});
});
