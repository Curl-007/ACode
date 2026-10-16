/**
 * 嵌入内容可编辑焦点追踪（specs: packages/desktop/specs/embedded-content-focus-yield.md §1）单测。
 *
 * 组件渲染无 DOM 测试先例（包内测试全部是纯逻辑 node:test），这里守护同规格列出的
 * 可断言不变量：判定集（含 shadowRoot 穿透与 IFRAME/WEBVIEW 保守判定）、变化才上报、
 * trailing 去抖、多 surface 事件序终值正确、dispose 收口（补报 false + 摘监听 + 清定时器）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  createEmbeddedContentFocusTracker,
  isEmbeddedEditableFocusTarget,
  reportEmbeddedEditableFocus,
  resolveDeepActiveElement,
} from "../src/lib/embeddedContentFocus.js";

// ===== 纯判定 =====

function fakeElement(shape: Record<string, unknown>): Element {
  return shape as unknown as Element;
}

test("判定集：INPUT/TEXTAREA/SELECT 及不可穿透嵌入面一律保守视为可编辑", () => {
  for (const tagName of [
    "INPUT",
    "TEXTAREA",
    "SELECT",
    "IFRAME",
    "FRAME",
    "EMBED",
    "OBJECT",
    "WEBVIEW",
  ]) {
    assert.equal(
      isEmbeddedEditableFocusTarget(fakeElement({ tagName })),
      true,
      `${tagName} 应视为可编辑焦点`,
    );
  }
});

test("非可编辑元素（DIV/BUTTON/SPAN）不命中", () => {
  for (const tagName of ["DIV", "BUTTON", "SPAN", "ACODE-VIZ"]) {
    assert.equal(isEmbeddedEditableFocusTarget(fakeElement({ tagName })), false, tagName);
  }
});

test("contentEditable 宿主元素命中（结构判定，node 环境可测）", () => {
  assert.equal(
    isEmbeddedEditableFocusTarget(fakeElement({ tagName: "DIV", isContentEditable: true })),
    true,
  );
  assert.equal(
    isEmbeddedEditableFocusTarget(fakeElement({ tagName: "DIV", isContentEditable: false })),
    false,
  );
});

test("shadowRoot 穿透：焦点在 shadow DOM 内的输入框上时命中", () => {
  const inner = fakeElement({ tagName: "TEXTAREA" });
  const host = fakeElement({ tagName: "DIV", shadowRoot: { activeElement: inner } });
  assert.equal(resolveDeepActiveElement(host), inner);
  assert.equal(isEmbeddedEditableFocusTarget(host), true);
});

test("穿透链多层嵌套与空焦点", () => {
  const deep = fakeElement({ tagName: "INPUT" });
  const mid = fakeElement({ tagName: "DIV", shadowRoot: { activeElement: deep } });
  const host = fakeElement({ tagName: "DIV", shadowRoot: { activeElement: mid } });
  assert.equal(isEmbeddedEditableFocusTarget(host), true);
  assert.equal(isEmbeddedEditableFocusTarget(null), false);
  assert.equal(
    isEmbeddedEditableFocusTarget(
      fakeElement({ tagName: "DIV", shadowRoot: { activeElement: null } }),
    ),
    false,
  );
});

// ===== 上报桥 =====

test("reportEmbeddedEditableFocus：桥缺席静默 no-op，桥存在按布尔转发", () => {
  reportEmbeddedEditableFocus(null, true); // 不抛即通过
  reportEmbeddedEditableFocus({}, false); // 无方法对象不抛

  const calls: boolean[] = [];
  reportEmbeddedEditableFocus({ syncEmbeddedEditableFocus: (v: boolean) => calls.push(v) }, true);
  reportEmbeddedEditableFocus({ syncEmbeddedEditableFocus: (v: boolean) => calls.push(v) }, false);
  assert.deepEqual(calls, [true, false]);
});

// ===== tracker（假 root + 手动定时器） =====

interface FakeRoot {
  root: HTMLElement;
  contained: Set<unknown>;
  emit(type: string): void;
  listenerCount(type: string): number;
}

function createFakeRoot(): FakeRoot {
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  const contained = new Set<unknown>();
  const root = {
    addEventListener(type: string, listener: (event: unknown) => void) {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener(type: string, listener: (event: unknown) => void) {
      listeners.get(type)?.delete(listener);
    },
    contains(node: unknown) {
      return contained.has(node);
    },
  } as unknown as HTMLElement;
  return {
    root,
    contained,
    emit(type) {
      // Set 迭代器对迭代中删除安全（dispose 路径会边派发边摘监听）。
      for (const listener of listeners.get(type) ?? new Set<(event: unknown) => void>()) {
        listener({});
      }
    },
    listenerCount(type) {
      return listeners.get(type)?.size ?? 0;
    },
  };
}

interface ManualTimers {
  schedule(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  cancelSchedule(timer: ReturnType<typeof setTimeout>): void;
  flushAll(): void;
  pendingCount(): number;
}

function createManualTimers(): ManualTimers {
  let nextId = 1;
  const timers = new Map<number, () => void>();
  return {
    schedule(callback) {
      const id = nextId++;
      timers.set(id, callback);
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    cancelSchedule(timer) {
      timers.delete(timer as unknown as number);
    },
    flushAll() {
      // 按登记序执行（与 setTimeout 相同延时下的先到先跑一致）；Map 迭代器对迭代中 delete 安全。
      for (const [id, callback] of timers.entries()) {
        timers.delete(id);
        callback();
      }
    },
    pendingCount() {
      return timers.size;
    },
  };
}

function setupTracker() {
  const fake = createFakeRoot();
  const timers = createManualTimers();
  const reports: boolean[] = [];
  let active: Element | null = null;
  const iframe = fakeElement({ tagName: "IFRAME" });
  const tracker = createEmbeddedContentFocusTracker({
    root: fake.root,
    report: (focused) => reports.push(focused),
    schedule: timers.schedule,
    cancelSchedule: timers.cancelSchedule,
    getActiveElement: () => active,
  });
  return {
    fake,
    timers,
    reports,
    iframe,
    tracker,
    setActive(element: Element | null, inside = true) {
      active = element;
      if (element !== null) {
        if (inside) fake.contained.add(element);
        else fake.contained.delete(element);
      }
    },
  };
}

test("挂载时焦点不在容器内：零上报", () => {
  const ctx = setupTracker();
  ctx.timers.flushAll();
  assert.deepEqual(ctx.reports, [], "lastReported 缺省 false，无变化不发 IPC");
});

test("focusin → 去抖后上报 true；重复事件稳态零 IPC", () => {
  const ctx = setupTracker();
  ctx.setActive(ctx.iframe);
  ctx.fake.emit("focusin");
  assert.deepEqual(ctx.reports, [], "去抖窗口内不上报");
  ctx.timers.flushAll();
  assert.deepEqual(ctx.reports, [true]);

  ctx.fake.emit("keydown"); // 焦点未变的兜底同步
  ctx.timers.flushAll();
  assert.deepEqual(ctx.reports, [true], "变化才上报：重复 sync 不再发");
});

test("focusout → 去抖后上报 false", () => {
  const ctx = setupTracker();
  ctx.setActive(ctx.iframe);
  ctx.fake.emit("focusin");
  ctx.timers.flushAll();
  ctx.setActive(null);
  ctx.fake.emit("focusout");
  ctx.timers.flushAll();
  assert.deepEqual(ctx.reports, [true, false]);
});

test("去抖窗口内翻回原值：取消在途上报，稳态零 IPC", () => {
  const ctx = setupTracker();
  ctx.setActive(ctx.iframe);
  ctx.fake.emit("focusin");
  ctx.timers.flushAll();
  assert.deepEqual(ctx.reports, [true]);

  ctx.setActive(null);
  ctx.fake.emit("focusout"); // pending false
  ctx.setActive(ctx.iframe);
  ctx.fake.emit("focusin"); // 翻回 true === lastReported → 取消 pending
  assert.equal(ctx.timers.pendingCount(), 0, "在途定时器已取消");
  ctx.timers.flushAll();
  assert.deepEqual(ctx.reports, [true], "无新上报");
});

test("挂载时焦点已在容器内（虚拟列表复挂载）：首个上报即 true", () => {
  const fake = createFakeRoot();
  const timers = createManualTimers();
  const reports: boolean[] = [];
  const iframe = fakeElement({ tagName: "IFRAME" });
  fake.contained.add(iframe);
  createEmbeddedContentFocusTracker({
    root: fake.root,
    report: (focused) => reports.push(focused),
    schedule: timers.schedule,
    cancelSchedule: timers.cancelSchedule,
    getActiveElement: () => iframe,
  });
  timers.flushAll();
  assert.deepEqual(reports, [true]);
});

test("容器外元素获得焦点不算本 surface（contains 判定）", () => {
  const ctx = setupTracker();
  const outside = fakeElement({ tagName: "INPUT" });
  ctx.setActive(outside, false);
  ctx.fake.emit("focusin");
  ctx.timers.flushAll();
  assert.deepEqual(ctx.reports, []);
});

test("dispose：上报过 true 则同步补报 false，摘监听清定时器", () => {
  const ctx = setupTracker();
  ctx.setActive(ctx.iframe);
  ctx.fake.emit("focusin");
  ctx.timers.flushAll();
  assert.deepEqual(ctx.reports, [true]);

  ctx.tracker.dispose();
  assert.deepEqual(ctx.reports, [true, false], "surface 卸载后不再主张焦点");
  assert.equal(ctx.fake.listenerCount("focusin"), 0);
  assert.equal(ctx.fake.listenerCount("focusout"), 0);
  assert.equal(ctx.fake.listenerCount("keydown"), 0);
  assert.equal(ctx.timers.pendingCount(), 0);

  ctx.setActive(null);
  ctx.fake.emit("focusout"); // 监听已摘，无效果
  ctx.timers.flushAll();
  assert.deepEqual(ctx.reports, [true, false]);
});

test("dispose：pending true 未刷出即取消，不产生上报", () => {
  const ctx = setupTracker();
  ctx.setActive(ctx.iframe);
  ctx.fake.emit("focusin"); // pending true，未 flush
  ctx.tracker.dispose();
  assert.deepEqual(ctx.reports, [], "从未上报过 true，dispose 不补报");
  assert.equal(ctx.timers.pendingCount(), 0);
  ctx.timers.flushAll();
  assert.deepEqual(ctx.reports, []);
});

test("dispose 幂等", () => {
  const ctx = setupTracker();
  ctx.setActive(ctx.iframe);
  ctx.fake.emit("focusin");
  ctx.timers.flushAll();
  ctx.tracker.dispose();
  ctx.tracker.dispose();
  assert.deepEqual(ctx.reports, [true, false], "第二次 dispose 不重复补报");
});

test("双 surface 切换：focusout(A) 先于 focusin(B)，去抖后终值 true（spec 验收场景 5）", () => {
  const a = setupTracker();
  const b = setupTracker();
  const iframeA = a.iframe;
  const iframeB = b.iframe;

  // 焦点进入 A
  a.setActive(iframeA);
  a.fake.emit("focusin");
  a.timers.flushAll();
  b.timers.flushAll();
  assert.deepEqual(a.reports, [true]);
  assert.deepEqual(b.reports, []);

  // A → B 直接切换：DOM 事件序 focusout(A) 先于 focusin(B)
  a.setActive(null); // focusout 时 activeElement 已离开 A（body）
  a.fake.emit("focusout");
  b.setActive(iframeB);
  b.fake.emit("focusin");

  // 真实世界里两个 tracker 的去抖定时器同延时、按 schedule 先后触发（focusout(A)
  // 先于 focusin(B)），经同一条 IPC FIFO 到达 main：false → true，终值 true。
  a.timers.flushAll();
  b.timers.flushAll();
  assert.deepEqual(a.reports, [true, false]);
  assert.deepEqual(b.reports, [true]);
});
