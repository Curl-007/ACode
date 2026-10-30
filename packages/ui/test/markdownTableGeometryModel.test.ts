import assert from "node:assert/strict";
import test from "node:test";
import {
  isMarkdownTableObservedRectEqual,
  readCssPixelValue,
  readMarkdownTableBackToBottomClearance,
  readMarkdownTableDockHeight,
  readMarkdownTableObservedRect,
  resolveMarkdownTableFrameDistances,
  resolveMarkdownTableRoot,
  resolveMarkdownTableStickyScrollbarMode,
  resolveMarkdownTableStickyScrollbarOffset,
  resolveMarkdownTableVerticalViewport,
  resolveMarkdownTableVirtualScrollMax,
  resolveMarkdownTableVirtualScrollbarMetrics,
  shouldUseMarkdownTableStickyScrollbar,
} from "../src/markdown-table/markdownTableGeometryModel.js";

/**
 * markdown-table 批次 6 外迁（markdownTableGeometryModel.ts）的决策表单测。
 * 纯函数部分（吸底判定 / 偏移 / 帧距离 / 虚拟滚动 metrics / rect 签名）全覆盖；
 * DOM 读数函数用最小桩元素断言「有/无 window」两条降级路径（无 jsdom，按固定验收第 4 条）。
 */

const withWindow = <T>(value: unknown, run: () => T): T => {
  const globals = globalThis as Record<string, unknown>;
  const had = "window" in globals;
  const previous = globals.window;
  globals.window = value;
  try {
    return run();
  } finally {
    if (had) globals.window = previous;
    else delete globals.window;
  }
};

test("resolveMarkdownTableStickyScrollbarMode：显式 opt-out 永远关闭", () => {
  assert.equal(
    resolveMarkdownTableStickyScrollbarMode({
      stickyScrollbarDisabled: true,
      viewportHeight: 10_000,
      dockHeight: 0,
      tableHeight: 10_000,
    }),
    false,
  );
});

test("resolveMarkdownTableStickyScrollbarMode：可见高度为零时关闭", () => {
  assert.equal(
    resolveMarkdownTableStickyScrollbarMode({
      stickyScrollbarDisabled: false,
      viewportHeight: 400,
      dockHeight: 400,
      tableHeight: 10_000,
    }),
    false,
  );
});

test("resolveMarkdownTableStickyScrollbarMode：80% 阈值两侧", () => {
  // visible = 1000，阈值 800：800 不触发，801 触发。
  assert.equal(
    resolveMarkdownTableStickyScrollbarMode({
      stickyScrollbarDisabled: false,
      viewportHeight: 1000,
      dockHeight: 0,
      tableHeight: 800,
    }),
    false,
  );
  assert.equal(
    resolveMarkdownTableStickyScrollbarMode({
      stickyScrollbarDisabled: false,
      viewportHeight: 1000,
      dockHeight: 0,
      tableHeight: 801,
    }),
    true,
  );
});

test("resolveMarkdownTableStickyScrollbarMode：dock 高度从可视区里扣掉", () => {
  // visible = 1000 - 300 = 700，阈值 560。
  assert.equal(
    resolveMarkdownTableStickyScrollbarMode({
      stickyScrollbarDisabled: false,
      viewportHeight: 1000,
      dockHeight: 300,
      tableHeight: 561,
    }),
    true,
  );
  assert.equal(
    resolveMarkdownTableStickyScrollbarMode({
      stickyScrollbarDisabled: false,
      viewportHeight: 1000,
      dockHeight: 300,
      tableHeight: 560,
    }),
    false,
  );
});

test("resolveMarkdownTableStickyScrollbarOffset：viewport 高于 frame 底部时为 0", () => {
  assert.equal(
    resolveMarkdownTableStickyScrollbarOffset({
      frameTop: 0,
      frameBottom: 500,
      scrollbarHeight: 20,
      viewportBottom: 900,
    }),
    0,
  );
});

test("resolveMarkdownTableStickyScrollbarOffset：viewport 低于 frame 底部时上移", () => {
  assert.equal(
    resolveMarkdownTableStickyScrollbarOffset({
      frameTop: 0,
      frameBottom: 500,
      scrollbarHeight: 20,
      viewportBottom: 300,
    }),
    -200,
  );
});

test("resolveMarkdownTableStickyScrollbarOffset：不低于 frameTop + 滚动条高度", () => {
  assert.equal(
    resolveMarkdownTableStickyScrollbarOffset({
      frameTop: 100,
      frameBottom: 500,
      scrollbarHeight: 20,
      viewportBottom: 0,
    }),
    -380,
  );
});

test("resolveMarkdownTableFrameDistances：左右距离与 inset 扣减", () => {
  const distances = resolveMarkdownTableFrameDistances({
    frameWidth: 600,
    frameLeft: 100,
    frameRight: 700,
    rootLeft: 40,
    rootRight: 960,
    leftInset: 16,
    rightInset: 16,
  });
  assert.deepEqual(distances, {
    leftDistance: 60,
    maxLeftOffset: 44,
    scrollbarWidth: 844,
    rightDistance: 260,
    maxViewportWidth: 844,
  });
});

test("resolveMarkdownTableFrameDistances：frame 超出 root 时距离钳到 0", () => {
  const distances = resolveMarkdownTableFrameDistances({
    frameWidth: 600,
    frameLeft: 0,
    frameRight: 600,
    rootLeft: 100,
    rootRight: 500,
  });
  assert.equal(distances.leftDistance, 0);
  assert.equal(distances.rightDistance, 0);
  assert.equal(distances.maxLeftOffset, 0);
  assert.equal(distances.scrollbarWidth, 600);
});

test("resolveMarkdownTableFrameDistances：inset 超过左距离时 maxLeftOffset 为 0", () => {
  const distances = resolveMarkdownTableFrameDistances({
    frameWidth: 600,
    frameLeft: 10,
    frameRight: 610,
    rootLeft: 0,
    rootRight: 900,
    leftInset: 999,
    rightInset: 0,
  });
  assert.equal(distances.maxLeftOffset, 0);
});

test("resolveMarkdownTableVirtualScrollMax：钳到 0", () => {
  assert.equal(resolveMarkdownTableVirtualScrollMax({ tableWidth: 100, trackWidth: 300 }), 0);
  assert.equal(resolveMarkdownTableVirtualScrollMax({ tableWidth: 500, trackWidth: 300 }), 200);
});

test("resolveMarkdownTableVirtualScrollbarMetrics：track 宽为 0 或无溢出时给安全默认", () => {
  assert.deepEqual(
    resolveMarkdownTableVirtualScrollbarMetrics({
      scrollLeft: 0,
      scrollMax: 100,
      tableWidth: 500,
      trackWidth: 0,
    }),
    { contentWidth: 0, thumbLeft: 0, thumbWidth: 0 },
  );
  assert.deepEqual(
    resolveMarkdownTableVirtualScrollbarMetrics({
      scrollLeft: 0,
      scrollMax: 0,
      tableWidth: 900,
      trackWidth: 300,
    }),
    { contentWidth: 300, thumbLeft: 0, thumbWidth: 300 },
  );
  assert.deepEqual(
    resolveMarkdownTableVirtualScrollbarMetrics({
      scrollLeft: 0,
      scrollMax: 100,
      tableWidth: 200,
      trackWidth: 300,
    }),
    { contentWidth: 300, thumbLeft: 0, thumbWidth: 300 },
  );
});

test("resolveMarkdownTableVirtualScrollbarMetrics：thumb 宽高比与位置上限", () => {
  const metrics = resolveMarkdownTableVirtualScrollbarMetrics({
    scrollLeft: 200,
    scrollMax: 600,
    tableWidth: 900,
    trackWidth: 300,
  });
  // thumbWidth = 300 * (300/900) = 100；thumbLeft = 200 * (300/900) ≈ 66.67
  assert.equal(metrics.contentWidth, 900);
  assert.equal(Math.round(metrics.thumbWidth), 100);
  assert.equal(Math.round(metrics.thumbLeft), 67);

  const atEnd = resolveMarkdownTableVirtualScrollbarMetrics({
    scrollLeft: 10_000,
    scrollMax: 600,
    tableWidth: 900,
    trackWidth: 300,
  });
  assert.equal(Math.round(atEnd.thumbLeft), 200, "thumb 不得越过 track 右边界");
});

test("resolveMarkdownTableVirtualScrollbarMetrics：负输入全部钳到 0", () => {
  const metrics = resolveMarkdownTableVirtualScrollbarMetrics({
    scrollLeft: -50,
    scrollMax: -1,
    tableWidth: -100,
    trackWidth: -10,
  });
  assert.deepEqual(metrics, { contentWidth: 0, thumbLeft: 0, thumbWidth: 0 });
});

test("readMarkdownTableObservedRect：null 元素返回 null", () => {
  assert.equal(readMarkdownTableObservedRect(null), null);
});

test("readMarkdownTableObservedRect：四舍五入 left/right/width", () => {
  const element = {
    getBoundingClientRect: () => ({ left: 10.4, right: 60.6, width: 50.2 }),
  } as unknown as HTMLElement;
  assert.deepEqual(readMarkdownTableObservedRect(element), {
    left: 10,
    right: 61,
    width: 50,
  });
});

test("isMarkdownTableObservedRectEqual：三字段全等才算相同", () => {
  const a = { left: 1, right: 2, width: 3 };
  assert.equal(isMarkdownTableObservedRectEqual(a, { ...a }), true);
  assert.equal(isMarkdownTableObservedRectEqual(a, { ...a, width: 4 }), false);
  assert.equal(isMarkdownTableObservedRectEqual(null, null), true);
  assert.equal(isMarkdownTableObservedRectEqual(null, a), false);
});

test("readCssPixelValue：无 window 时返回 0", () => {
  const element = { } as unknown as HTMLElement;
  const value = withWindow(undefined, () => readCssPixelValue(element, "--x"));
  assert.equal(value, 0);
});

test("readCssPixelValue：非数字与负值钳到 0", () => {
  const elementWithStyle = {
    computed: "abc",
  } as unknown as HTMLElement;
  const windowStub = {
    getComputedStyle: () => ({
      getPropertyValue: () => (elementWithStyle as unknown as { computed: string }).computed,
    }),
  };
  assert.equal(
    withWindow(windowStub, () => readCssPixelValue(elementWithStyle, "--x")),
    0,
  );
  (elementWithStyle as unknown as { computed: string }).computed = "-12.5";
  assert.equal(
    withWindow(windowStub, () => readCssPixelValue(elementWithStyle, "--x")),
    0,
  );
  (elementWithStyle as unknown as { computed: string }).computed = "24.5";
  assert.equal(
    withWindow(windowStub, () => readCssPixelValue(elementWithStyle, "--x")),
    24.5,
  );
});

test("readMarkdownTableDockHeight：优先读 legacy CSS 变量", () => {
  const root = {} as unknown as HTMLElement;
  const windowStub = {
    getComputedStyle: () => ({ getPropertyValue: () => "48" }),
  };
  assert.equal(withWindow(windowStub, () => readMarkdownTableDockHeight(root)), 48);
});

test("readMarkdownTableDockHeight：无 legacy 变量时回退 composer dock 高度", () => {
  const dock = { getBoundingClientRect: () => ({ height: 72 }) };
  const root = {
    querySelector: (selector: string) =>
      selector === '[data-v4-composer-dock="true"]' ? dock : null,
  } as unknown as HTMLElement;
  const windowStub = {
    getComputedStyle: () => ({ getPropertyValue: () => "0" }),
  };
  assert.equal(withWindow(windowStub, () => readMarkdownTableDockHeight(root)), 72);
});

test("readMarkdownTableDockHeight：root 为 null 时返回 0", () => {
  const windowStub = {
    getComputedStyle: () => ({ getPropertyValue: () => "0" }),
  };
  assert.equal(withWindow(windowStub, () => readMarkdownTableDockHeight(null)), 0);
});

test("readMarkdownTableBackToBottomClearance：无按钮为 0，有按钮为高度 + 8", () => {
  assert.equal(readMarkdownTableBackToBottomClearance(null), 0);
  const button = { getBoundingClientRect: () => ({ height: 32 }) };
  const root = { querySelector: () => button } as unknown as HTMLElement;
  assert.equal(readMarkdownTableBackToBottomClearance(root), 40);
});

test("resolveMarkdownTableVerticalViewport：无 window 时回退 root", () => {
  const fallback = {} as unknown as HTMLElement;
  const value = withWindow(undefined, () =>
    resolveMarkdownTableVerticalViewport(null, fallback),
  );
  assert.equal(value, fallback);
});

test("resolveMarkdownTableVerticalViewport：跳过无纵向滚动空间的祖先", () => {
  const fallback = { id: "fallback" } as unknown as HTMLElement;
  const scroller = {
    id: "scroller",
    parentElement: null,
    clientHeight: 200,
    scrollHeight: 500,
  };
  const shallow = {
    id: "shallow",
    parentElement: scroller,
    clientHeight: 200,
    scrollHeight: 200,
  };
  const element = { parentElement: shallow } as unknown as HTMLElement;
  const windowStub = {
    getComputedStyle: () => ({ overflowY: "auto" }),
  };
  const resolved = withWindow(windowStub, () =>
    resolveMarkdownTableVerticalViewport(element, fallback),
  );
  assert.equal(resolved, scroller);
});

test("resolveMarkdownTableVerticalViewport：overflow 非滚动时继续向上并最终回退", () => {
  const fallback = { id: "fallback" } as unknown as HTMLElement;
  const hidden = {
    parentElement: null,
    clientHeight: 200,
    scrollHeight: 500,
  };
  const element = { parentElement: hidden } as unknown as HTMLElement;
  const windowStub = {
    getComputedStyle: () => ({ overflowY: "hidden" }),
  };
  assert.equal(
    withWindow(windowStub, () => resolveMarkdownTableVerticalViewport(element, fallback)),
    fallback,
  );
});

test("resolveMarkdownTableRoot：优先最近的显式布局根，否则回退", () => {
  const fallback = { id: "fallback" } as unknown as HTMLElement;
  const layoutRoot = { id: "layout-root" };
  const frame = {
    closest: (selector: string) => (selector.includes("markdown-table-layout-root") ? layoutRoot : null),
  } as unknown as HTMLElement;
  assert.equal(resolveMarkdownTableRoot(frame, fallback), layoutRoot);
  assert.equal(resolveMarkdownTableRoot(null, fallback), fallback);
  const bareFrame = { closest: () => null } as unknown as HTMLElement;
  assert.equal(resolveMarkdownTableRoot(bareFrame, fallback), fallback);
});

test("shouldUseMarkdownTableStickyScrollbar：无表格即关闭", () => {
  assert.equal(shouldUseMarkdownTableStickyScrollbar({ root: null, table: null }), false);
});

test("shouldUseMarkdownTableStickyScrollbar：显式 opt-out 容器内的表格关闭", () => {
  const table = {
    closest: (selector: string) =>
      selector.includes("sticky-scrollbar") ? ({} as HTMLElement) : null,
    getBoundingClientRect: () => ({ height: 5000 }),
  } as unknown as HTMLTableElement;
  assert.equal(shouldUseMarkdownTableStickyScrollbar({ root: null, table }), false);
});
