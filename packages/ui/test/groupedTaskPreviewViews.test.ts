import assert from "node:assert/strict";
import test from "node:test";
import type { DragOverEvent } from "@dnd-kit/core";
import type { ACodeGroupedTaskView, ACodeTaskListItem } from "@acode/services";
import {
  getGroupedGroupOverGroupPreviewView,
  getGroupedGroupOverTaskPreviewView,
  getGroupedTaskOverCollapsedGroupPreviewView,
  getGroupedTaskOverEmptyDropZonePreviewView,
  getGroupedTaskOverGroupFooterPreviewView,
  getGroupedTaskOverGroupHeaderPreviewView,
  getGroupedTaskOverTaskPreviewView,
  getGroupedTaskViewSignature,
} from "../src/workspace-grouped-tasks/groupedTaskPreviewViews.js";
import { taskKey } from "../src/workspace-grouped-tasks/shared.js";

/**
 * WorkspaceGroupedTasksSection 批次 4 helper 外迁（god-component-split-plan 登记行）的
 * 接缝内决策表单测：7 个 drag-over 预览视图构建器的（active data × over data × position）
 * 分支矩阵 + getGroupedTaskViewSignature 稳定性。
 * 夹具视图：根 task A、组 g1[B, C]、空组 g2；期望一律用签名钉死结构。
 */

function makeTask(taskId: string): ACodeTaskListItem {
  return {
    taskId,
    traceId: `trace-${taskId}`,
    title: `Task ${taskId}`,
    workspacePath: "/ws",
    createdAt: 0,
    updatedAt: 0,
    mode: "yolo",
  };
}

function makeGroup(id: string, tasks: ACodeTaskListItem[]) {
  return {
    type: "group" as const,
    group: { id, title: `Group ${id}`, color: "gray" as const, createdAt: 0, updatedAt: 0 },
    tasks,
  };
}

const taskA = makeTask("a");
const taskB = makeTask("b");
const taskC = makeTask("c");
const keyA = taskKey(taskA);
const keyB = taskKey(taskB);
const keyC = taskKey(taskC);

function makeView(): ACodeGroupedTaskView {
  return {
    nodes: [{ type: "task", task: taskA }, makeGroup("g1", [taskB, taskC]), makeGroup("g2", [])],
  };
}

function makeDragOverEvent(activeData: unknown, overData: unknown): DragOverEvent {
  return {
    active: { data: { current: activeData } },
    over: overData === null ? null : { data: { current: overData } },
  } as unknown as DragOverEvent;
}

const taskDrag = (key: string) => ({ type: "grouped-task", taskKey: key });
const groupDrag = (groupId: string) => ({ type: "grouped-group", groupId });

// ── getGroupedTaskOverTaskPreviewView ──

test("over task：根 task 拖到组内 task 前 → 插入该组对应位置", () => {
  const view = makeView();
  const result = getGroupedTaskOverTaskPreviewView(
    view,
    makeDragOverEvent(taskDrag(keyA), taskDrag(keyB)),
    "before",
  );
  assert.equal(getGroupedTaskViewSignature(result), `g:g1[${keyA},${keyB},${keyC}]|g:g2[]`);
});

test("over task：同组内向下拖 after → 移到目标之后", () => {
  const view = makeView();
  const result = getGroupedTaskOverTaskPreviewView(
    view,
    makeDragOverEvent(taskDrag(keyB), taskDrag(keyC)),
    "after",
  );
  assert.equal(getGroupedTaskViewSignature(result), `t:${keyA}|g:g1[${keyC},${keyB}]|g:g2[]`);
});

test("over task：active 缺失 / over 缺失 / 自拖 → 原视图引用不变", () => {
  const view = makeView();
  assert.equal(
    getGroupedTaskOverTaskPreviewView(view, makeDragOverEvent(null, taskDrag(keyB)), "before"),
    view,
  );
  assert.equal(
    getGroupedTaskOverTaskPreviewView(
      view,
      makeDragOverEvent(taskDrag(keyA), { type: "grouped-group", groupId: "g1" }),
      "before",
    ),
    view,
  );
  assert.equal(
    getGroupedTaskOverTaskPreviewView(view, makeDragOverEvent(taskDrag(keyA), null), "before"),
    view,
  );
  assert.equal(
    getGroupedTaskOverTaskPreviewView(
      view,
      makeDragOverEvent(taskDrag(keyA), taskDrag(keyA)),
      "before",
    ),
    view,
  );
});

// ── getGroupedTaskOverCollapsedGroupPreviewView ──

test("over collapsed group：组内 task 拖出到折叠组前/后 → 提到根层级", () => {
  const view = makeView();
  const before = getGroupedTaskOverCollapsedGroupPreviewView(
    view,
    makeDragOverEvent(taskDrag(keyB), { type: "grouped-collapsed-group", groupId: "g2" }),
    "before",
  );
  assert.equal(getGroupedTaskViewSignature(before), `t:${keyA}|g:g1[${keyC}]|t:${keyB}|g:g2[]`);
  const after = getGroupedTaskOverCollapsedGroupPreviewView(
    view,
    makeDragOverEvent(taskDrag(keyB), { type: "grouped-collapsed-group", groupId: "g2" }),
    "after",
  );
  assert.equal(getGroupedTaskViewSignature(after), `t:${keyA}|g:g1[${keyC}]|g:g2[]|t:${keyB}`);
});

test("over collapsed group：active 非 task / over type 不符 → 原视图引用不变", () => {
  const view = makeView();
  assert.equal(
    getGroupedTaskOverCollapsedGroupPreviewView(
      view,
      makeDragOverEvent(groupDrag("g1"), { type: "grouped-collapsed-group", groupId: "g2" }),
      "before",
    ),
    view,
  );
  assert.equal(
    getGroupedTaskOverCollapsedGroupPreviewView(
      view,
      makeDragOverEvent(taskDrag(keyB), { type: "grouped-group-over", groupId: "g2" }),
      "before",
    ),
    view,
  );
});

// ── getGroupedTaskOverGroupHeaderPreviewView ──

test("over group header：before → 提到组前根层级；after → 进组首", () => {
  const view = makeView();
  const before = getGroupedTaskOverGroupHeaderPreviewView(
    view,
    makeDragOverEvent(taskDrag(keyB), { type: "grouped-expanded-group-header", groupId: "g2" }),
    "before",
  );
  assert.equal(getGroupedTaskViewSignature(before), `t:${keyA}|g:g1[${keyC}]|t:${keyB}|g:g2[]`);
  const after = getGroupedTaskOverGroupHeaderPreviewView(
    view,
    makeDragOverEvent(taskDrag(keyA), { type: "grouped-expanded-group-header", groupId: "g1" }),
    "after",
  );
  assert.equal(getGroupedTaskViewSignature(after), `g:g1[${keyA},${keyB},${keyC}]|g:g2[]`);
});

test("over group header：data 畸形 → 原视图引用不变", () => {
  const view = makeView();
  assert.equal(
    getGroupedTaskOverGroupHeaderPreviewView(view, makeDragOverEvent(taskDrag(keyA), null), "after"),
    view,
  );
  assert.equal(
    getGroupedTaskOverGroupHeaderPreviewView(
      view,
      makeDragOverEvent(taskDrag(keyA), { type: "grouped-expanded-group-header" }),
      "after",
    ),
    view,
  );
});

// ── getGroupedTaskOverGroupFooterPreviewView ──

test("over group footer：before → 进组尾；after → 提到组后根层级", () => {
  const view = makeView();
  const before = getGroupedTaskOverGroupFooterPreviewView(
    view,
    makeDragOverEvent(taskDrag(keyA), { type: "grouped-expanded-group-footer", groupId: "g1" }),
    "before",
  );
  assert.equal(getGroupedTaskViewSignature(before), `g:g1[${keyB},${keyC},${keyA}]|g:g2[]`);
  const after = getGroupedTaskOverGroupFooterPreviewView(
    view,
    makeDragOverEvent(taskDrag(keyA), { type: "grouped-expanded-group-footer", groupId: "g1" }),
    "after",
  );
  assert.equal(
    getGroupedTaskViewSignature(after),
    `g:g1[${keyB},${keyC}]|t:${keyA}|g:g2[]`,
  );
});

test("over group footer：active 非 task → 原视图引用不变", () => {
  const view = makeView();
  assert.equal(
    getGroupedTaskOverGroupFooterPreviewView(
      view,
      makeDragOverEvent({ type: "grouped-task" }, { type: "grouped-expanded-group-footer", groupId: "g1" }),
      "before",
    ),
    view,
  );
});

// ── getGroupedTaskOverEmptyDropZonePreviewView ──

test("over empty drop zone：根 task 拖入空组 → 进组首（无 position 参数）", () => {
  const view = makeView();
  const result = getGroupedTaskOverEmptyDropZonePreviewView(
    view,
    makeDragOverEvent(taskDrag(keyA), { type: "grouped-empty-drop-zone", groupId: "g2" }),
  );
  assert.equal(getGroupedTaskViewSignature(result), `g:g1[${keyB},${keyC}]|g:g2[${keyA}]`);
});

test("over empty drop zone：over type 不符 / over 缺失 → 原视图引用不变", () => {
  const view = makeView();
  assert.equal(
    getGroupedTaskOverEmptyDropZonePreviewView(
      view,
      makeDragOverEvent(taskDrag(keyA), { type: "grouped-collapsed-group", groupId: "g2" }),
    ),
    view,
  );
  assert.equal(
    getGroupedTaskOverEmptyDropZonePreviewView(view, makeDragOverEvent(taskDrag(keyA), null)),
    view,
  );
});

// ── getGroupedGroupOverGroupPreviewView ──

test("group over group：g1 拖到 g2 之后 → 顶层顺序交换", () => {
  const view = makeView();
  const result = getGroupedGroupOverGroupPreviewView(
    view,
    makeDragOverEvent(groupDrag("g1"), { type: "grouped-group-over", groupId: "g2" }),
    "after",
  );
  assert.equal(
    getGroupedTaskViewSignature(result),
    `t:${keyA}|g:g2[]|g:g1[${keyB},${keyC}]`,
  );
});

test("group over group：自拖 / active 非 group / over 缺失 → 原视图引用不变", () => {
  const view = makeView();
  assert.equal(
    getGroupedGroupOverGroupPreviewView(
      view,
      makeDragOverEvent(groupDrag("g1"), { type: "grouped-group-over", groupId: "g1" }),
      "before",
    ),
    view,
  );
  assert.equal(
    getGroupedGroupOverGroupPreviewView(
      view,
      makeDragOverEvent(taskDrag(keyA), { type: "grouped-group-over", groupId: "g2" }),
      "before",
    ),
    view,
  );
  assert.equal(
    getGroupedGroupOverGroupPreviewView(view, makeDragOverEvent(groupDrag("g1"), null), "before"),
    view,
  );
});

// ── getGroupedGroupOverTaskPreviewView ──

test("group over task：拖到根 task 前 → 顶层插入；拖到别组组内 task → 归一化为该组", () => {
  const view = makeView();
  const overRootTask = getGroupedGroupOverTaskPreviewView(
    view,
    makeDragOverEvent(groupDrag("g2"), taskDrag(keyA)),
    "before",
  );
  assert.equal(
    getGroupedTaskViewSignature(overRootTask),
    `g:g2[]|t:${keyA}|g:g1[${keyB},${keyC}]`,
  );
  const overGroupedTask = getGroupedGroupOverTaskPreviewView(
    view,
    makeDragOverEvent(groupDrag("g2"), taskDrag(keyB)),
    "after",
  );
  assert.equal(
    getGroupedTaskViewSignature(overGroupedTask),
    `t:${keyA}|g:g1[${keyB},${keyC}]|g:g2[]`,
  );
});

test("group over task：拖到自身组内 task → 原视图引用不变；active 缺失 → 原视图引用不变", () => {
  const view = makeView();
  assert.equal(
    getGroupedGroupOverTaskPreviewView(view, makeDragOverEvent(groupDrag("g1"), taskDrag(keyB)), "before"),
    view,
  );
  assert.equal(
    getGroupedGroupOverTaskPreviewView(view, makeDragOverEvent(null, taskDrag(keyA)), "before"),
    view,
  );
});

// ── getGroupedTaskViewSignature 稳定性 ──

test("signature：同结构同签名；task 顺序/归属/group id 任一变化签名即变", () => {
  const view = makeView();
  const signature = getGroupedTaskViewSignature(view);
  assert.equal(signature, `t:${keyA}|g:g1[${keyB},${keyC}]|g:g2[]`);
  assert.equal(getGroupedTaskViewSignature(makeView()), signature);
  // task 顺序变化。
  const reordered: ACodeGroupedTaskView = {
    nodes: [makeGroup("g1", [taskC, taskB]), { type: "task", task: taskA }, makeGroup("g2", [])],
  };
  assert.notEqual(getGroupedTaskViewSignature(reordered), signature);
  // task 归属变化（根 ↔ 组）。
  const regrouped: ACodeGroupedTaskView = {
    nodes: [makeGroup("g1", [taskA, taskB, taskC]), makeGroup("g2", [])],
  };
  assert.notEqual(getGroupedTaskViewSignature(regrouped), signature);
  // group id 变化。
  const renamed: ACodeGroupedTaskView = {
    nodes: [{ type: "task", task: taskA }, makeGroup("g9", [taskB, taskC]), makeGroup("g2", [])],
  };
  assert.notEqual(getGroupedTaskViewSignature(renamed), signature);
  // 空视图签名稳定为空串。
  assert.equal(getGroupedTaskViewSignature({ nodes: [] }), "");
});
