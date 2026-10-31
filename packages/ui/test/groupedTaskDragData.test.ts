import assert from "node:assert/strict";
import test from "node:test";
import type { CollisionDetection, DroppableContainer } from "@dnd-kit/core";
import {
  areStringArraysEqual,
  areTaskGroupMenuItemsEqual,
  getGroupedGroupOverGroupId,
  getGroupedTaskCollapsedOverGroupId,
  getGroupedTaskDragGroupId,
  getGroupedTaskDragTaskKey,
  getGroupedTaskDragType,
  getGroupedTaskEmptyOverGroupId,
  getGroupedTaskFooterOverGroupId,
  getGroupedTaskHeaderOverGroupId,
  groupedTaskCollisionDetection,
} from "../src/workspace-grouped-tasks/groupedTaskDragData.js";

/**
 * WorkspaceGroupedTasksSection 批次 4 helper 外迁（god-component-split-plan 登记行）的
 * 接缝内决策表单测：8 个 drag data 读取器的 round-trip/畸形输入矩阵 ×
 * groupedTaskCollisionDetection 的 active 类型分支 × 菜单/字符串数组等价判定边界。
 * 布局/DOM 函数（collect/measure/animate/resolveSticky）依赖 DOM，不在 node:test 覆盖。
 */

// ── 8 个读取器：正确 type+id → 取出；type 不符/字段非 string/非对象 → null ──

test("getGroupedTaskDragTaskKey：grouped-task + string taskKey 取出，其余 null", () => {
  assert.equal(getGroupedTaskDragTaskKey({ type: "grouped-task", taskKey: "k1" }), "k1");
  assert.equal(getGroupedTaskDragTaskKey({ type: "grouped-group", taskKey: "k1" }), null);
  assert.equal(getGroupedTaskDragTaskKey({ type: "grouped-task", taskKey: 1 }), null);
  assert.equal(getGroupedTaskDragTaskKey({ type: "grouped-task" }), null);
  assert.equal(getGroupedTaskDragTaskKey(null), null);
  assert.equal(getGroupedTaskDragTaskKey(undefined), null);
  assert.equal(getGroupedTaskDragTaskKey("grouped-task"), null);
});

test("getGroupedTaskDragGroupId：grouped-group + string groupId 取出，其余 null", () => {
  assert.equal(getGroupedTaskDragGroupId({ type: "grouped-group", groupId: "g1" }), "g1");
  assert.equal(getGroupedTaskDragGroupId({ type: "grouped-task", groupId: "g1" }), null);
  assert.equal(getGroupedTaskDragGroupId({ type: "grouped-group", groupId: null }), null);
  assert.equal(getGroupedTaskDragGroupId({ type: "grouped-group" }), null);
  assert.equal(getGroupedTaskDragGroupId(null), null);
  assert.equal(getGroupedTaskDragGroupId(42), null);
});

test("getGroupedTaskDragType：任意 string type 取出（不限枚举），其余 null", () => {
  assert.equal(getGroupedTaskDragType({ type: "grouped-task" }), "grouped-task");
  assert.equal(getGroupedTaskDragType({ type: "whatever" }), "whatever");
  assert.equal(getGroupedTaskDragType({ type: 7 }), null);
  assert.equal(getGroupedTaskDragType({}), null);
  assert.equal(getGroupedTaskDragType(null), null);
});

test("getGroupedGroupOverGroupId：grouped-group-over 专属", () => {
  assert.equal(getGroupedGroupOverGroupId({ type: "grouped-group-over", groupId: "g2" }), "g2");
  assert.equal(getGroupedGroupOverGroupId({ type: "grouped-group", groupId: "g2" }), null);
  assert.equal(getGroupedGroupOverGroupId({ type: "grouped-group-over", groupId: {} }), null);
  assert.equal(getGroupedGroupOverGroupId(undefined), null);
});

test("getGroupedTaskCollapsedOverGroupId：grouped-collapsed-group 专属", () => {
  assert.equal(
    getGroupedTaskCollapsedOverGroupId({ type: "grouped-collapsed-group", groupId: "g3" }),
    "g3",
  );
  assert.equal(
    getGroupedTaskCollapsedOverGroupId({ type: "grouped-empty-drop-zone", groupId: "g3" }),
    null,
  );
  assert.equal(getGroupedTaskCollapsedOverGroupId({ type: "grouped-collapsed-group" }), null);
  assert.equal(getGroupedTaskCollapsedOverGroupId(null), null);
});

test("getGroupedTaskHeaderOverGroupId：grouped-expanded-group-header 专属", () => {
  assert.equal(
    getGroupedTaskHeaderOverGroupId({ type: "grouped-expanded-group-header", groupId: "g4" }),
    "g4",
  );
  assert.equal(
    getGroupedTaskHeaderOverGroupId({ type: "grouped-expanded-group-footer", groupId: "g4" }),
    null,
  );
  assert.equal(
    getGroupedTaskHeaderOverGroupId({ type: "grouped-expanded-group-header", groupId: 0 }),
    null,
  );
  assert.equal(getGroupedTaskHeaderOverGroupId("x"), null);
});

test("getGroupedTaskFooterOverGroupId：grouped-expanded-group-footer 专属", () => {
  assert.equal(
    getGroupedTaskFooterOverGroupId({ type: "grouped-expanded-group-footer", groupId: "g5" }),
    "g5",
  );
  assert.equal(
    getGroupedTaskFooterOverGroupId({ type: "grouped-expanded-group-header", groupId: "g5" }),
    null,
  );
  assert.equal(getGroupedTaskFooterOverGroupId({ type: "grouped-expanded-group-footer" }), null);
  assert.equal(getGroupedTaskFooterOverGroupId(false), null);
});

test("getGroupedTaskEmptyOverGroupId：grouped-empty-drop-zone 专属", () => {
  assert.equal(
    getGroupedTaskEmptyOverGroupId({ type: "grouped-empty-drop-zone", groupId: "g6" }),
    "g6",
  );
  assert.equal(
    getGroupedTaskEmptyOverGroupId({ type: "grouped-collapsed-group", groupId: "g6" }),
    null,
  );
  assert.equal(
    getGroupedTaskEmptyOverGroupId({ type: "grouped-empty-drop-zone", groupId: undefined }),
    null,
  );
  assert.equal(getGroupedTaskEmptyOverGroupId([]), null);
});

// ── groupedTaskCollisionDetection：active 类型决定 droppable 过滤分支 ──

function makeContainer(id: string, data: unknown): DroppableContainer {
  return { id, data: { current: data } } as unknown as DroppableContainer;
}

function makeCollisionArgs(
  activeData: unknown,
  containers: readonly DroppableContainer[],
): Parameters<CollisionDetection>[0] {
  const rect = { width: 10, height: 10, top: 100, left: 0, right: 10, bottom: 110 };
  return {
    active: { id: "active", data: { current: activeData } },
    collisionRect: { width: 10, height: 10, top: 0, left: 0, right: 10, bottom: 10 },
    droppableContainers: [...containers],
    droppableRects: new Map(containers.map((container) => [container.id, rect])),
    pointerCoordinates: null,
    scrollingRegion: { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 },
  } as unknown as Parameters<CollisionDetection>[0];
}

function collisionIds(args: Parameters<CollisionDetection>[0]): string[] {
  return groupedTaskCollisionDetection(args).map((collision) => String(collision.id));
}

test("active=grouped-group：仅保留 grouped-task 与 grouped-group-over 容器", () => {
  const containers = [
    makeContainer("task-1", { type: "grouped-task", taskKey: "k1" }),
    makeContainer("group-over-1", { type: "grouped-group-over", groupId: "g1" }),
    makeContainer("header-1", { type: "grouped-expanded-group-header", groupId: "g1" }),
    makeContainer("footer-1", { type: "grouped-expanded-group-footer", groupId: "g1" }),
    makeContainer("collapsed-1", { type: "grouped-collapsed-group", groupId: "g2" }),
    makeContainer("empty-1", { type: "grouped-empty-drop-zone", groupId: "g3" }),
  ];
  assert.deepEqual(collisionIds(makeCollisionArgs({ type: "grouped-group", groupId: "g9" }, containers)), [
    "task-1",
    "group-over-1",
  ]);
});

test("active=grouped-task：剔除 grouped-group-over，保留其余全部", () => {
  const containers = [
    makeContainer("task-1", { type: "grouped-task", taskKey: "k1" }),
    makeContainer("group-over-1", { type: "grouped-group-over", groupId: "g1" }),
    makeContainer("group-over-2", { type: "grouped-group-over", groupId: "g2" }),
    makeContainer("header-1", { type: "grouped-expanded-group-header", groupId: "g1" }),
    makeContainer("collapsed-1", { type: "grouped-collapsed-group", groupId: "g2" }),
    makeContainer("empty-1", { type: "grouped-empty-drop-zone", groupId: "g3" }),
  ];
  assert.deepEqual(collisionIds(makeCollisionArgs({ type: "grouped-task", taskKey: "k9" }, containers)), [
    "task-1",
    "header-1",
    "collapsed-1",
    "empty-1",
  ]);
});

test("active data 畸形（无 string type）：走非 group 分支，仅按容器 type 过滤", () => {
  const containers = [
    makeContainer("task-1", { type: "grouped-task", taskKey: "k1" }),
    makeContainer("group-over-1", { type: "grouped-group-over", groupId: "g1" }),
  ];
  assert.deepEqual(collisionIds(makeCollisionArgs(null, containers)), ["task-1"]);
  assert.deepEqual(collisionIds(makeCollisionArgs({ type: 1 }, containers)), ["task-1"]);
});

test("过滤后为空容器集：返回空碰撞数组", () => {
  const containers = [makeContainer("group-over-1", { type: "grouped-group-over", groupId: "g1" })];
  assert.deepEqual(collisionIds(makeCollisionArgs({ type: "grouped-task", taskKey: "k9" }, containers)), []);
});

// ── areTaskGroupMenuItemsEqual / areStringArraysEqual 等价边界 ──

test("areTaskGroupMenuItemsEqual：id+title+color 逐位相等才等价", () => {
  const left = [
    { id: "g1", title: "一", color: "gray" as const },
    { id: "g2", title: "二", color: "red" as const },
  ];
  assert.equal(areTaskGroupMenuItemsEqual(left, [...left]), true);
  assert.equal(areTaskGroupMenuItemsEqual(left, [left[1]!, left[0]!]), false);
  assert.equal(
    areTaskGroupMenuItemsEqual(left, [left[0]!, { id: "g2", title: "二", color: "blue" }]),
    false,
  );
  assert.equal(
    areTaskGroupMenuItemsEqual(left, [left[0]!, { id: "g2", title: "改", color: "red" }]),
    false,
  );
  assert.equal(
    areTaskGroupMenuItemsEqual(left, [{ id: "g9", title: "一", color: "gray" }, left[1]!]),
    false,
  );
  assert.equal(areTaskGroupMenuItemsEqual(left, left.slice(0, 1)), false);
  assert.equal(areTaskGroupMenuItemsEqual([], []), true);
});

test("areStringArraysEqual：长度+逐位引用相等才等价", () => {
  assert.equal(areStringArraysEqual(["a", "b"], ["a", "b"]), true);
  assert.equal(areStringArraysEqual(["a", "b"], ["b", "a"]), false);
  assert.equal(areStringArraysEqual(["a"], ["a", "b"]), false);
  assert.equal(areStringArraysEqual(["a", "b"], ["a"]), false);
  assert.equal(areStringArraysEqual([], []), true);
});
