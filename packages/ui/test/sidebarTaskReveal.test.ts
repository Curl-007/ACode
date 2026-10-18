import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { useSidebarTaskRevealStore } from "../src/store/sidebarTaskRevealStore.js";
import {
  computeRevealScrollTop,
  isRowFullyVisible,
  SIDEBAR_TASK_REVEAL_HIGHLIGHT_CLASS,
  SIDEBAR_TASK_REVEAL_REQUEST_TIMEOUT_MS,
} from "../src/hooks/useSidebarTaskRevealScroll.js";

/**
 * 任务菜单侧栏定位契约验收（apps/acode-cli/specs/sidebar-task-reveal.md）。
 * ui 测试无 jsdom 先例（appearancePreferences.test.ts 头注）：store 与纯滚动数学
 * 直接单测；hook 接线、DOM 锚点格式与高亮双闸用源码契约断言钉住。
 */

// 用公开 consumeRequest 清槽，不引入生产面的 test-only reset API。
function resetRevealStore() {
  const pending = useSidebarTaskRevealStore.getState().pendingRequest;
  if (pending) {
    useSidebarTaskRevealStore.getState().consumeRequest(pending.requestId);
  }
}

test("reveal store：requestReveal 构造 workspaceKey 且 requestId 单调递增", () => {
  const store = useSidebarTaskRevealStore;
  resetRevealStore();
  assert.equal(store.getState().pendingRequest, null);

  store.getState().requestReveal({
    workspacePath: "C:/work/demo",
    workspaceIdentity: " remote-1 ",
    taskId: "task-a",
  });
  const first = store.getState().pendingRequest;
  // 身份 key 统一为 workspaceIdentity?.trim() || workspacePath（AGENTS.md Workspace Identity）。
  assert.equal(first?.workspaceKey, "remote-1");
  assert.equal(first?.workspacePath, "C:/work/demo");
  assert.equal(first?.taskId, "task-a");

  store.getState().requestReveal({
    workspacePath: "C:/work/demo",
    taskId: "task-b",
  });
  const second = store.getState().pendingRequest;
  assert.equal(second?.workspaceKey, "C:/work/demo");
  assert.ok(second && first && second.requestId > first.requestId);
});

test("reveal store：新请求替换单槽旧请求；consumeRequest 只清匹配 requestId", () => {
  const store = useSidebarTaskRevealStore;
  resetRevealStore();

  store.getState().requestReveal({ workspacePath: "/w", taskId: "t1" });
  const first = store.getState().pendingRequest;
  store.getState().requestReveal({ workspacePath: "/w", taskId: "t2" });
  const second = store.getState().pendingRequest;
  assert.equal(second?.taskId, "t2");

  // 陈旧 requestId 不能误清新请求（spec R1）。
  if (first) {
    store.getState().consumeRequest(first.requestId);
    assert.equal(store.getState().pendingRequest?.requestId, second?.requestId);
  }
  if (second) {
    store.getState().consumeRequest(second.requestId);
    assert.equal(store.getState().pendingRequest, null);
  }
  // 幂等：重复 consume 不报错也不影响空槽。
  if (second) {
    store.getState().consumeRequest(second.requestId);
  }
  assert.equal(store.getState().pendingRequest, null);
  resetRevealStore();
});

test("滚动数学：行居中且左边界钳制为 0（spec R2）", () => {
  // 容器 600 高，行 40 高在容器顶下方 1000px 处：居中 = scrollTop + 1000 - 280。
  assert.equal(
    computeRevealScrollTop({
      scrollTop: 100,
      containerTop: 0,
      containerClientHeight: 600,
      rowTop: 1100,
      rowHeight: 40,
    }),
    920,
  );
  // 目标已在顶部附近时钳到 0，不出现负滚动。
  assert.equal(
    computeRevealScrollTop({
      scrollTop: 50,
      containerTop: 0,
      containerClientHeight: 600,
      rowTop: 10,
      rowHeight: 40,
    }),
    0,
  );
});

test("可见性判定：行完整在容器视口内才免滚动（spec R2）", () => {
  assert.equal(
    isRowFullyVisible({ containerTop: 0, containerBottom: 600, rowTop: 10, rowBottom: 50 }),
    true,
  );
  // 上缘越出。
  assert.equal(
    isRowFullyVisible({ containerTop: 0, containerBottom: 600, rowTop: -5, rowBottom: 50 }),
    false,
  );
  // 下缘越出。
  assert.equal(
    isRowFullyVisible({ containerTop: 0, containerBottom: 600, rowTop: 500, rowBottom: 640 }),
    false,
  );
});

test("hook 源码契约：容器内滚动、双锚点匹配、aria-hidden 跳过、请求有界", async () => {
  const hookSource = await readFile(
    fileURLToPath(new URL("../src/hooks/useSidebarTaskRevealScroll.ts", import.meta.url)),
    "utf8",
  );
  // 只滚容器，禁止 scrollIntoView 连带移动会话区与页面（spec R2）。
  assert.ok(hookSource.includes("container.scrollTo("));
  assert.ok(!/\.scrollIntoView\(/.test(hookSource));
  // 行匹配重建 TaskListItem / grouped 行的两种 DOM 锚点格式。
  assert.ok(hookSource.includes("[data-task-item-key], [data-grouped-task-key]"));
  assert.ok(hookSource.includes("`${request.workspaceKey}:${request.taskId}`"));
  // 文件树覆盖（aria-hidden）跳过本轮，请求保持 pending。
  assert.ok(hookSource.includes("row.closest('[aria-hidden=\"true\"]')"));
  // 请求有界：超时静默 consume，且过期清理绑定 requestId。
  assert.ok(hookSource.includes("SIDEBAR_TASK_REVEAL_REQUEST_TIMEOUT_MS"));
  assert.ok(
    hookSource.includes("useSidebarTaskRevealStore.getState().consumeRequest(request.requestId)"),
  );
  // 新鲜度检查：陈旧请求的 rAF 回调直接放弃。
  assert.ok(hookSource.includes("pendingRequest?.requestId !== request.requestId"));
  // 定位成功后注入高亮 class。
  assert.ok(hookSource.includes("SIDEBAR_TASK_REVEAL_HIGHLIGHT_CLASS"));
  assert.equal(SIDEBAR_TASK_REVEAL_REQUEST_TIMEOUT_MS, 15_000);
  assert.equal(SIDEBAR_TASK_REVEAL_HIGHLIGHT_CLASS, "sidebar-task-reveal-highlight");
});

test("接线源码契约：setActiveTaskId 是唯一写入者，WorkspaceSidebar 是唯一消费者", async () => {
  const sliceSource = await readFile(
    fileURLToPath(new URL("../src/store/acodeSessionStoreWorkspaceSlice.ts", import.meta.url)),
    "utf8",
  );
  // 写入发生在 setActiveTaskId 内、且只在 id 非空（打开会话）时（spec R1）。
  const setActiveStart = sliceSource.indexOf("setActiveTaskId: (workspacePath");
  assert.ok(setActiveStart >= 0);
  const setActiveBody = sliceSource.slice(
    setActiveStart,
    sliceSource.indexOf("promoteGroupedDraftTask:", setActiveStart),
  );
  assert.ok(setActiveBody.includes("if (id)"));
  assert.ok(
    setActiveBody.includes("requestReveal({ workspacePath, workspaceIdentity, taskId: id })"),
  );
  // 全仓唯一写入点：requestReveal 只应出现在 store 定义与该 slice。
  const sidebarSource = await readFile(
    fileURLToPath(new URL("../src/WorkspaceSidebar.tsx", import.meta.url)),
    "utf8",
  );
  assert.ok(sidebarSource.includes("useSidebarTaskRevealScroll(workspaceScrollRef,"));
  assert.ok(sidebarSource.includes("(state) => state.pendingRequest"));
  // 消费端用侧栏面板可见性 gate：面板隐藏期间请求保持 pending（spec R2）。
  assert.ok(
    /useSidebarTaskRevealScroll\(\s*workspaceScrollRef,\s*sidebarTaskRevealRequest,\s*isSidebarVisible\s*\)/.test(
      sidebarSource,
    ),
  );
});

test("DOM 锚点格式契约：行键与 workspaceKey 构造保持 lockstep（spec R1/R2）", async () => {
  const taskListItemSource = await readFile(
    fileURLToPath(new URL("../src/TaskListItem.tsx", import.meta.url)),
    "utf8",
  );
  // TaskListItem 渲染 data-task-item-key=`${workspaceKey}:${taskId}`；
  // hook 以同一格式重建 itemKey，两处模板必须一致。
  assert.ok(
    taskListItemSource.includes(
      "`${buildTaskWorkspaceKey(task.workspacePath, task.workspaceIdentity)}:${task.taskId}`",
    ),
  );
  assert.ok(taskListItemSource.includes("data-task-item-key={taskItemKey}"));
});

test("高亮动效双闸：styles.css 同时带 prefers-reduced-motion 与 data-acode-reduce-motion（spec R3）", async () => {
  const stylesSource = await readFile(
    fileURLToPath(new URL("../src/styles.css", import.meta.url)),
    "utf8",
  );
  assert.ok(stylesSource.includes("@keyframes sidebar-task-reveal-highlight"));
  const classRule = stylesSource.indexOf(".sidebar-task-reveal-highlight {");
  assert.ok(classRule > stylesSource.indexOf("@keyframes sidebar-task-reveal-highlight"));
  // 全文件存在多个 reduce-motion 闸；这里只认本 class 自己的双闸（在 class 规则之后）。
  const mediaGate = stylesSource.indexOf("@media (prefers-reduced-motion: reduce)", classRule);
  const attributeGate = stylesSource.indexOf(
    '[data-acode-reduce-motion="reduce"] .sidebar-task-reveal-highlight',
    classRule,
  );
  assert.ok(mediaGate > classRule);
  assert.ok(attributeGate > mediaGate);
  // 双闸都收敛到 animation: none。
  const afterMedia = stylesSource.slice(mediaGate, mediaGate + 300);
  assert.ok(/\.sidebar-task-reveal-highlight\s*\{\s*animation:\s*none;/.test(afterMedia));
  const afterAttribute = stylesSource.slice(attributeGate, attributeGate + 200);
  assert.ok(/animation:\s*none;/.test(afterAttribute));
});
