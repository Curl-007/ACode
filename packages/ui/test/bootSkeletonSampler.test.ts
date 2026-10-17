import assert from "node:assert/strict";
import test from "node:test";
import {
  BOOT_SKELETON_MAX_SHAPES,
  createBootSkeletonReporter,
  isBootSkeletonShapeValid,
  sampleBootSkeletonFrame,
  serializeBootSkeletonFrame,
  startBootSkeletonReporting,
  type BootSkeletonDocument,
  type BootSkeletonFrame,
  type BootSkeletonMutationObserverCtor,
  type BootSkeletonRect,
  type BootSkeletonVisibilityDocument,
  type BootSkeletonWindowLike,
} from "../src/app-shell/bootSkeletonSampler.js";

/**
 * boot placeholder 骨架采样器验收（packages/desktop/specs/boot-placeholder.md §8/§10.6）。
 * ui 测试无 jsdom 先例，DOM 用手搓结构化替身（desktop tests MemoryFs 同款纪律）。
 */

const VW = 1200;
const VH = 800;
const SHELL_SELECTOR = '[data-workspace-shell="true"]';
const ROWS_SELECTOR = '[data-testid="workspace-list"] > li';

function stubElement(rect: BootSkeletonRect) {
  return { getBoundingClientRect: () => rect };
}

function createDocumentStub(
  bySelector: Record<string, Array<{ getBoundingClientRect(): BootSkeletonRect }>>,
): BootSkeletonDocument {
  return {
    querySelector: (selector) => bySelector[selector]?.[0] ?? null,
    querySelectorAll: (selector) => bySelector[selector] ?? [],
  };
}

function createShellDocument(
  overrides: {
    sidebar?: BootSkeletonRect;
    rows?: BootSkeletonRect[];
    sections?: Record<string, BootSkeletonRect[]>;
  } = {},
): BootSkeletonDocument {
  const bySelector: Record<string, BootSkeletonRect[]> = {
    [SHELL_SELECTOR]: [{ top: 0, left: 0, width: VW, height: VH }],
    "#sidebar": [overrides.sidebar ?? { top: 0, left: 0, width: 264, height: VH }],
    [ROWS_SELECTOR]: overrides.rows ?? [],
    ...overrides.sections,
  };
  return createDocumentStub(
    Object.fromEntries(
      Object.entries(bySelector).map(([selector, rects]) => [selector, rects.map(stubElement)]),
    ),
  );
}

function sample(document: BootSkeletonDocument, zoomFactor = 1, now = () => 1_700_000_000_000) {
  return sampleBootSkeletonFrame({
    document,
    innerWidth: VW,
    innerHeight: VH,
    zoomFactor,
    now,
  });
}

test("非 workspace shell 页面不采样（保留上次持久化好数据）", () => {
  const doc = createDocumentStub({
    "#sidebar": [stubElement({ top: 0, left: 0, width: 264, height: VH })],
  });
  assert.equal(sample(doc), null);
  // 视口非法同样拒绝。
  assert.equal(
    sampleBootSkeletonFrame({
      document: createShellDocument(),
      innerWidth: 0,
      innerHeight: VH,
      zoomFactor: 1,
    }),
    null,
  );
});

test("展开态：侧栏宽度/行 + 主要分区按视口比值归一化", () => {
  const doc = createShellDocument({
    rows: [
      { top: 100, left: 12, width: 240, height: 36 },
      { top: 148, left: 12, width: 240, height: 36 },
    ],
    sections: {
      '[data-testid="workspace-header"]': [{ top: 16, left: 288, width: 888, height: 32 }],
      '[data-workspace-conversation-frame="true"]': [
        { top: 64, left: 288, width: 888, height: 596 },
      ],
      // 隐藏 side pane tab：rect 全 0，被最小尺寸过滤。
      "[data-side-pane-tab-id]": [
        { top: 64, left: 900, width: 276, height: 596 },
        { top: 0, left: 0, width: 0, height: 0 },
      ],
    },
  });
  const frame = sample(doc, 1.21);
  assert.ok(frame);
  assert.equal(frame.collapsed, false);
  assert.equal(frame.sidebarWidth, 0.22); // 264 / 1200
  assert.equal(frame.zoomFactor, 1.21);
  // 2 行 + header + conversation + 1 个可见 side pane tab。
  assert.equal(frame.shapes.length, 5);
  // 第一行：radius 提示 10px（< height/2=18），相对短边 800 归一。
  assert.deepEqual(frame.shapes[0], {
    top: 0.125,
    left: 0.01,
    width: 0.2,
    height: 0.045,
    radius: 0.0125,
  });
  for (const shape of frame.shapes) {
    assert.ok(isBootSkeletonShapeValid(shape));
  }
});

test("收起态：collapsed=true、sidebarWidth=0，被裁剪的侧栏行不进骨架", () => {
  const doc = createShellDocument({
    sidebar: { top: 0, left: 0, width: 4, height: VH },
    // 收起时 #sidebar overflow-hidden 但行布局宽度仍在——必须整组跳过。
    rows: [{ top: 100, left: 12, width: 240, height: 36 }],
    sections: {
      '[data-workspace-conversation-frame="true"]': [
        { top: 64, left: 16, width: 1168, height: 596 },
      ],
    },
  });
  const frame = sample(doc);
  assert.ok(frame);
  assert.equal(frame.collapsed, true);
  assert.equal(frame.sidebarWidth, 0);
  assert.equal(frame.shapes.length, 1);
});

test("退化/出视口矩形被过滤，比值 clamp 到 [0,1]", () => {
  const doc = createShellDocument({
    sections: {
      "[data-side-pane-tab-id]": [
        { top: 10, left: 10, width: 1, height: 100 }, // 宽 < 2px
        { top: 10, left: 10, width: 100, height: 1 }, // 高 < 2px
        { top: 0, left: -500, width: 400, height: 100 }, // 完全在视口左侧外
        { top: 0, left: VW, width: 100, height: 100 }, // 完全在视口右侧外
        { top: VH, left: 0, width: 100, height: 100 }, // 完全在视口下方外
        { top: -40, left: -40, width: 2000, height: 2000 }, // 越界：clamp 到 [0,1]
      ],
    },
  });
  const frame = sample(doc);
  assert.ok(frame);
  assert.equal(frame.shapes.length, 1);
  assert.deepEqual(frame.shapes[0], { top: 0, left: 0, width: 1, height: 1, radius: 0.015 });
});

test("shapes 硬顶 160、侧栏行硬顶 20、比值四舍五入 5 位", () => {
  const manyPanes = Array.from({ length: 200 }, (_unused, index) => ({
    top: 0,
    left: index * 2,
    width: 2,
    height: 100,
  }));
  const manyRows = Array.from({ length: 30 }, (_unused, index) => ({
    top: index * 20,
    left: 12,
    width: 240,
    height: 16,
  }));
  const doc = createShellDocument({
    rows: manyRows,
    sections: { "[data-side-pane-tab-id]": manyPanes },
  });
  const frame = sample(doc);
  assert.ok(frame);
  // 行封顶 20 + 分区补到总量 160。
  assert.equal(frame.shapes.length, BOOT_SKELETON_MAX_SHAPES);

  // 100/300 = 0.333333… → 5 位四舍五入。
  const repeating = sampleBootSkeletonFrame({
    document: createShellDocument({
      sections: {
        '[data-testid="workspace-header"]': [{ top: 100, left: 0, width: 100, height: 100 }],
      },
    }),
    innerWidth: 300,
    innerHeight: 300,
    zoomFactor: 1,
  });
  assert.ok(repeating);
  assert.equal(repeating.shapes[0].top, 0.33333);
  assert.equal(repeating.sidebarWidth, 0.88); // 264/300 = 0.88
});

test("zoomFactor 非法时回退 1（契约要求 >0 有限）", () => {
  const doc = createShellDocument();
  assert.equal(sample(doc, 0)?.zoomFactor, 1);
  assert.equal(sample(doc, Number.NaN)?.zoomFactor, 1);
  assert.equal(sample(doc, -1)?.zoomFactor, 1);
  assert.equal(sample(doc, 1.1)?.zoomFactor, 1.1);
});

test("serializeBootSkeletonFrame 忽略 sampledAt（去重只判几何）", () => {
  const base: BootSkeletonFrame = {
    shapes: [],
    sidebarWidth: 0.22,
    collapsed: false,
    zoomFactor: 1,
    sampledAt: 1,
  };
  assert.equal(
    serializeBootSkeletonFrame(base),
    serializeBootSkeletonFrame({ ...base, sampledAt: 2 }),
  );
  assert.notEqual(
    serializeBootSkeletonFrame(base),
    serializeBootSkeletonFrame({ ...base, collapsed: true }),
  );
});

/** 捕获式假定时器：schedule/settle 全部手动驱动，测试不依赖真实时间。 */
function createFakeTimers() {
  const pending: Array<{ fn: () => void; ms: number | undefined }> = [];
  const cleared: unknown[] = [];
  return {
    pending,
    cleared,
    setTimeoutImpl: ((fn: () => void, ms?: number) => {
      pending.push({ fn, ms });
      return pending.length - 1;
    }) as unknown as typeof setTimeout,
    clearTimeoutImpl: ((handle: unknown) => {
      cleared.push(handle);
    }) as unknown as typeof clearTimeout,
    fireLast() {
      const entry = pending[pending.length - 1];
      assert.ok(entry, "应有待触发的定时器");
      entry.fn();
    },
  };
}

test("reporter：防抖落盘、几何未变不重复写、非 shell 帧不覆盖", () => {
  const timers = createFakeTimers();
  const persisted: BootSkeletonFrame[] = [];
  let current: BootSkeletonFrame | null = {
    shapes: [],
    sidebarWidth: 0.22,
    collapsed: false,
    zoomFactor: 1,
    sampledAt: 1,
  };
  const reporter = createBootSkeletonReporter({
    sample: () => current,
    persist: (frame) => void persisted.push(frame),
    debounceMs: 2000,
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
  });

  reporter.schedule();
  reporter.schedule(); // 连续触发只保留一次防抖。
  assert.equal(persisted.length, 0);
  timers.fireLast();
  assert.equal(persisted.length, 1);
  assert.equal(timers.pending[0].ms, 2000);

  // 几何不变（仅 sampledAt 变）→ 不重复写。
  current = { ...(current as BootSkeletonFrame), sampledAt: 2 };
  reporter.schedule();
  timers.fireLast();
  assert.equal(persisted.length, 1);

  // 几何变化 → 再写一次。
  current = { ...(current as BootSkeletonFrame), collapsed: true, sidebarWidth: 0 };
  reporter.schedule();
  timers.fireLast();
  assert.equal(persisted.length, 2);

  // 非 shell 页面（sample null）→ 不覆盖。
  current = null;
  reporter.schedule();
  timers.fireLast();
  assert.equal(persisted.length, 2);

  const pendingBeforeDispose = timers.pending.length;
  reporter.dispose();
  reporter.schedule();
  assert.equal(timers.pending.length, pendingBeforeDispose, "dispose 后不再排新定时器");
});

test("reporter：persist 失败清去重键，下一触发源重试；异常经 onError 上抛", async () => {
  const timers = createFakeTimers();
  const errors: unknown[] = [];
  let attempts = 0;
  const frame: BootSkeletonFrame = {
    shapes: [],
    sidebarWidth: 0.22,
    collapsed: false,
    zoomFactor: 1,
    sampledAt: 1,
  };
  const reporter = createBootSkeletonReporter({
    sample: () => frame,
    persist: () => {
      attempts += 1;
      return attempts === 1 ? Promise.reject(new Error("write failed")) : Promise.resolve();
    },
    onError: (error) => errors.push(error),
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
  });

  reporter.schedule();
  timers.fireLast();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(errors.length, 1);

  reporter.schedule();
  timers.fireLast();
  await Promise.resolve();
  assert.equal(attempts, 2, "失败后同一帧应可重试");
  assert.equal(errors.length, 1);

  // sample 抛错也不外抛，走 onError。
  const throwing = createBootSkeletonReporter({
    sample: () => {
      throw new Error("sample boom");
    },
    persist: () => {},
    onError: (error) => errors.push(error),
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
  });
  assert.doesNotThrow(() => throwing.settle());
  assert.equal(errors.length, 2);
});

function createFakeWindow(): BootSkeletonWindowLike & {
  listeners: Map<string, Array<() => void>>;
  timers: Array<{ fn: () => void; ms: number | undefined; kind: string }>;
  cleared: Array<{ id: unknown; kind: string }>;
} {
  const listeners = new Map<string, Array<() => void>>();
  const timers: Array<{ fn: () => void; ms: number | undefined; kind: string }> = [];
  const cleared: Array<{ id: unknown; kind: string }> = [];
  return {
    listeners,
    timers,
    cleared,
    innerWidth: VW,
    innerHeight: VH,
    addEventListener: (type, listener) => {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    removeEventListener: (type, listener) => {
      listeners.set(
        type,
        (listeners.get(type) ?? []).filter((entry) => entry !== listener),
      );
    },
    setTimeout: ((fn: () => void, ms?: number) => {
      timers.push({ fn, ms, kind: "timeout" });
      return timers.length - 1;
    }) as unknown as typeof setTimeout,
    setInterval: ((fn: () => void, ms?: number) => {
      timers.push({ fn, ms, kind: "interval" });
      return timers.length - 1;
    }) as unknown as typeof setInterval,
    clearTimeout: ((id: unknown) => {
      cleared.push({ id, kind: "timeout" });
    }) as unknown as typeof clearTimeout,
    clearInterval: ((id: unknown) => {
      cleared.push({ id, kind: "interval" });
    }) as unknown as typeof clearInterval,
  };
}

type FakeVisibilityDocument = BootSkeletonVisibilityDocument & {
  fire(type: string): void;
  listeners: Map<string, Array<() => void>>;
};

function createFakeVisibilityDocument(inner: BootSkeletonDocument): FakeVisibilityDocument {
  const listeners = new Map<string, Array<() => void>>();
  return {
    hidden: false,
    listeners,
    querySelector: (selector) => inner.querySelector(selector),
    querySelectorAll: (selector) => inner.querySelectorAll(selector),
    addEventListener: (type, listener) => {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    removeEventListener: (type, listener) => {
      listeners.set(
        type,
        (listeners.get(type) ?? []).filter((entry) => entry !== listener),
      );
    },
    fire(type: string) {
      for (const listener of listeners.get(type) ?? []) {
        listener();
      }
    },
  };
}

test("startBootSkeletonReporting：触发源接线、观察 shell/侧栏属性、dispose 全清", () => {
  const doc = createFakeVisibilityDocument(
    createShellDocument({ rows: [{ top: 100, left: 12, width: 240, height: 36 }] }),
  );
  const win = createFakeWindow();
  const persisted: BootSkeletonFrame[] = [];
  const observers: Array<{
    callback: () => void;
    targets: unknown[];
    disconnected: boolean;
  }> = [];
  class FakeObserver {
    targets: unknown[] = [];
    disconnected = false;
    constructor(private callback: () => void) {
      observers.push(this);
    }
    observe(target: unknown) {
      this.targets.push(target);
    }
    disconnect() {
      this.disconnected = true;
    }
  }

  const dispose = startBootSkeletonReporting({
    persist: (frame) => void persisted.push(frame),
    readZoomFactor: () => 1.1,
    window: win,
    document: doc,
    debounceMs: 2000,
    initialDelayMs: 3000,
    intervalMs: 60_000,
    mutationObserverImpl: FakeObserver as unknown as BootSkeletonMutationObserverCtor,
  });

  // 初始延迟 + 兜底轮询 + resize/visibility 监听 + shell/#sidebar 两个观察目标。
  assert.ok(win.timers.some((entry) => entry.kind === "timeout" && entry.ms === 3000));
  assert.ok(win.timers.some((entry) => entry.kind === "interval" && entry.ms === 60_000));
  assert.equal(win.listeners.get("resize")?.length, 1);
  const observer = observers[0];
  assert.equal(observer.targets.length, 2);

  // resize → 防抖 → 采样落盘（zoomFactor 来自 readZoomFactor；本布局仅 1 个侧栏行）。
  win.listeners.get("resize")?.[0]();
  const debounceEntry = win.timers[win.timers.length - 1];
  assert.equal(debounceEntry.kind, "timeout");
  debounceEntry.fn();
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].zoomFactor, 1.1);
  assert.equal(persisted[0].shapes.length, 1);

  // 隐藏页不触发；恢复可见触发。
  const timersBeforeHidden = win.timers.length;
  doc.hidden = true;
  doc.fire("visibilitychange");
  assert.equal(win.timers.length, timersBeforeHidden);
  doc.hidden = false;
  doc.fire("visibilitychange");
  assert.ok(win.timers.length > timersBeforeHidden);

  // observer 回调触发采样链（几何未变 → 去重不落盘）。
  observer.callback();
  win.timers[win.timers.length - 1].fn();
  assert.equal(persisted.length, 1);

  dispose();
  assert.equal(win.listeners.get("resize")?.length, 0);
  assert.equal(doc.listeners.get("visibilitychange")?.length, 0);
  assert.ok(win.cleared.some((entry) => entry.kind === "interval"));
  assert.ok(observer.disconnected);
});

test("startBootSkeletonReporting：无浏览器环境返回 no-op disposer", () => {
  const dispose = startBootSkeletonReporting({ persist: () => {} });
  assert.equal(typeof dispose, "function");
  assert.doesNotThrow(() => dispose());
});
