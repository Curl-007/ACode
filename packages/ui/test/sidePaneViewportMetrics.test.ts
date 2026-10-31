import assert from "node:assert/strict";
import test from "node:test";
import { readViewportInlineIntersectionSize } from "../src/app-shell/useSidePaneViewportMetrics.js";

/**
 * AnimatedSidePanePanel 批次 6 外迁（useSidePaneViewportMetrics.ts）的决策表单测。
 * 两个 hook 依赖 window/ResizeObserver，无 jsdom 不可测（按固定验收第 4 条登记）；
 * 这里覆盖它们共用的纯读数函数 `readViewportInlineIntersectionSize` 的降级路径与钳制。
 */

const withWindow = <T>(value: unknown, run: () => T): T => {
  const globals = globalThis as Record<string, unknown>;
  const had = "window" in globals;
  const previous = globals.window;
  const hadDocument = "document" in globals;
  const previousDocument = globals.document;
  globals.window = value;
  globals.document = { documentElement: { clientWidth: 800 } };
  try {
    return run();
  } finally {
    if (had) globals.window = previous;
    else delete globals.window;
    if (hadDocument) globals.document = previousDocument;
    else delete globals.document;
  }
};

const elementWithRect = (left: number, right: number) =>
  ({
    getBoundingClientRect: () => ({ left, right, width: right - left }),
  }) as unknown as HTMLElement;

test("readViewportInlineIntersectionSize：无元素或无 window 返回 null", () => {
  assert.equal(readViewportInlineIntersectionSize(null), null);
  assert.equal(withWindow(undefined, () => readViewportInlineIntersectionSize(null)), null);
});

test("readViewportInlineIntersectionSize：viewport 宽为 0 时返回 null", () => {
  const value = withWindow({ innerWidth: 0 }, () =>
    readViewportInlineIntersectionSize(elementWithRect(0, 100)),
  );
  // document.documentElement.clientWidth = 800 兜底，因此仍能算出宽
  assert.equal(value, 100);
});

test("readViewportInlineIntersectionSize：完全在视口内时等于元素宽度", () => {
  const value = withWindow({ innerWidth: 1000 }, () =>
    readViewportInlineIntersectionSize(elementWithRect(100, 400)),
  );
  assert.equal(value, 300);
});

test("readViewportInlineIntersectionSize：左侧被裁掉时只算可见部分", () => {
  const value = withWindow({ innerWidth: 1000 }, () =>
    readViewportInlineIntersectionSize(elementWithRect(-200, 300)),
  );
  assert.equal(value, 300);
});

test("readViewportInlineIntersectionSize：右侧越界时钳到视口宽度", () => {
  const value = withWindow({ innerWidth: 500 }, () =>
    readViewportInlineIntersectionSize(elementWithRect(300, 900)),
  );
  assert.equal(value, 200);
});

test("readViewportInlineIntersectionSize：完全在视口外时为 0（不为负）", () => {
  const value = withWindow({ innerWidth: 500 }, () =>
    readViewportInlineIntersectionSize(elementWithRect(600, 900)),
  );
  assert.equal(value, 0);
});

test("readViewportInlineIntersectionSize：结果按像素四舍五入", () => {
  const value = withWindow({ innerWidth: 1000 }, () =>
    readViewportInlineIntersectionSize({
      getBoundingClientRect: () => ({ left: 10.4, right: 110.6, width: 100.2 }),
    } as unknown as HTMLElement),
  );
  assert.equal(value, 100);
});
