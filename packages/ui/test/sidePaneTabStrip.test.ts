import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveLockedContentWidthPx,
  resolveTabsScrollMaskEdges,
} from "../src/app-shell/useSidePaneTabStrip.js";

/**
 * AnimatedSidePanePanel 批次 7 外迁（useSidePaneTabStrip.ts）的纯决策单测。
 *
 * hook 本体依赖 window / ResizeObserver / requestAnimationFrame，无 jsdom 不测（固定验收第 4 条）；
 * 这里只覆盖从 effect 体内抽出的两个纯函数——它们承载的是「mask 何时显示」与
 * 「收起/展开时锁多宽」这两条**用户可见的动画语义**，原本埋在 effect 里无法单测。
 */

// ---- resolveTabsScrollMaskEdges ----

test("mask：不溢出时两侧都不显示（即使 scrollLeft 非零）", () => {
  assert.deepEqual(
    resolveTabsScrollMaskEdges({ isOverflowing: false, scrollLeft: 100, maxScrollLeft: 200 }),
    { left: false, right: false },
  );
});

test("mask：溢出且停在起点 → 只显示右侧（左边没有可滚内容）", () => {
  assert.deepEqual(
    resolveTabsScrollMaskEdges({ isOverflowing: true, scrollLeft: 0, maxScrollLeft: 200 }),
    { left: false, right: true },
  );
});

test("mask：溢出且滚到终点 → 只显示左侧（右边没有可滚内容）", () => {
  assert.deepEqual(
    resolveTabsScrollMaskEdges({ isOverflowing: true, scrollLeft: 200, maxScrollLeft: 200 }),
    { left: true, right: false },
  );
});

test("mask：溢出且停在中间 → 两侧都显示", () => {
  assert.deepEqual(
    resolveTabsScrollMaskEdges({ isOverflowing: true, scrollLeft: 100, maxScrollLeft: 200 }),
    { left: true, right: true },
  );
});

test("mask：1px 容差吸收亚像素滚动（0.5 / 199.6 仍视作端点）", () => {
  assert.deepEqual(
    resolveTabsScrollMaskEdges({ isOverflowing: true, scrollLeft: 0.5, maxScrollLeft: 200 }),
    { left: false, right: true },
  );
  assert.deepEqual(
    resolveTabsScrollMaskEdges({ isOverflowing: true, scrollLeft: 199.6, maxScrollLeft: 200 }),
    { left: true, right: false },
  );
});

test("mask：maxScrollLeft 为 0（内容恰好装下）时不出现左右假提示", () => {
  assert.deepEqual(
    resolveTabsScrollMaskEdges({ isOverflowing: true, scrollLeft: 0, maxScrollLeft: 0 }),
    { left: false, right: false },
  );
});

// ---- resolveLockedContentWidthPx ----

test("锁宽·收起：当前面板宽度 > 0 时锁成该像素值（避免先重排版再淡出）", () => {
  assert.equal(
    resolveLockedContentWidthPx({
      direction: "collapse",
      currentPanelWidthPx: 420,
      panelGroupWidthPx: 1200,
      previousLockedWidthPx: null,
      defaultExpandedRatio: 0.3,
    }),
    420,
  );
});

test("锁宽·收起：宽度读不到（0）时不锁（交回自适应布局，不写 0 宽度）", () => {
  assert.equal(
    resolveLockedContentWidthPx({
      direction: "collapse",
      currentPanelWidthPx: 0,
      panelGroupWidthPx: 1200,
      previousLockedWidthPx: null,
      defaultExpandedRatio: 0.3,
    }),
    null,
  );
});

test("锁宽·展开：没有历史锁宽时用分组宽度 × 默认展开比例", () => {
  assert.equal(
    resolveLockedContentWidthPx({
      direction: "expand",
      currentPanelWidthPx: 0,
      panelGroupWidthPx: 1200,
      previousLockedWidthPx: null,
      defaultExpandedRatio: 0.3,
    }),
    Math.round(1200 * 0.3),
  );
});

test("锁宽·展开：已有历史锁宽时沿用，不重算（首帧接近最终态）", () => {
  assert.equal(
    resolveLockedContentWidthPx({
      direction: "expand",
      currentPanelWidthPx: 0,
      panelGroupWidthPx: 1200,
      previousLockedWidthPx: 360,
      defaultExpandedRatio: 0.3,
    }),
    360,
  );
});

test("锁宽·展开：分组宽度为 0（尚未布局）时返回 null，不锁成 0", () => {
  assert.equal(
    resolveLockedContentWidthPx({
      direction: "expand",
      currentPanelWidthPx: 0,
      panelGroupWidthPx: 0,
      previousLockedWidthPx: null,
      defaultExpandedRatio: 0.3,
    }),
    null,
  );
});

test("锁宽·展开：分组宽度非有限值（NaN）时同样返回 null", () => {
  assert.equal(
    resolveLockedContentWidthPx({
      direction: "expand",
      currentPanelWidthPx: 0,
      panelGroupWidthPx: Number.NaN,
      previousLockedWidthPx: null,
      defaultExpandedRatio: 0.3,
    }),
    null,
  );
});

test("锁宽·展开：结果取整（像素布局不出现小数宽度）", () => {
  assert.equal(
    resolveLockedContentWidthPx({
      direction: "expand",
      currentPanelWidthPx: 0,
      panelGroupWidthPx: 1201,
      previousLockedWidthPx: null,
      defaultExpandedRatio: 0.3,
    }),
    Math.round(Math.round(1201) * 0.3),
  );
});
