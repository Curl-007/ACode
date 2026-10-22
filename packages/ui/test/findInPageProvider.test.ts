import assert from "node:assert/strict";
import test from "node:test";
import type { FindInPageCoordinatorEnv } from "../src/find-in-page/findInPageCoordinatorEnv.js";
import {
  createFindInPageCoordinator,
  mergeLegsInDocumentOrder,
  selectActiveIndex,
} from "../src/find-in-page/findInPageCoordinator.js";
import {
  collectSearchableText,
  findTextMatchIntervals,
  mapMatchesToRanges,
} from "../src/find-in-page/findInPageDomSearch.js";
import {
  getFindInPageProviders,
  registerFindInPageProvider,
  subscribeFindInPageProviderRegistry,
} from "../src/find-in-page/findInPageProvider.js";
import type { FindInPageScopeProvider } from "../src/find-in-page/findInPageProvider.js";

/**
 * 页内查找二期 renderer provider 体系单测
 * （specs: packages/desktop/specs/find-in-page.md 验收 18/19/21）。
 *
 * 协调器 DOM 触面全部经 env 注入——这里用最小 stub（假节点=文档序 pos、假 Range=
 * start 节点 + 高度），不依赖 jsdom。注册表是模块级单例，每个用例注册后必须 dispose。
 */

// ── 测试替身 ──

interface FakeNode {
  pos: number;
  connected: boolean;
}

interface FakeRange {
  id: string;
  start: FakeNode;
  height: number;
}

interface StubEnvOptions {
  rangesByText?: Record<string, FakeRange[]>;
}

function createStubEnv(options: StubEnvOptions = {}) {
  const calls = {
    search: [] as string[],
    match: [] as unknown[][],
    active: [] as unknown[],
    clear: 0,
    scroll: [] as unknown[],
    frames: [] as (() => void)[],
  };
  let rangesByText = options.rangesByText ?? {};
  let range = 0;
  const makeRange = (pos: number, id?: string): FakeRange => ({
    id: id ?? `r${range++}`,
    start: { pos, connected: true },
    height: 1,
  });
  const env: FindInPageCoordinatorEnv = {
    hasDocument: () => true,
    searchDocument: (text) => {
      calls.search.push(text);
      return rangesByText[text] ?? [];
    },
    rangeStartNode: (r) => (r as FakeRange).start,
    hostify: (node) => node,
    isConnected: (node) => (node as FakeNode | null)?.connected !== false,
    comparePosition: (a, b) => Math.sign((a as FakeNode).pos - (b as FakeNode).pos),
    sameRangeBoundaries: (a, b) => a === b,
    applyMatchHighlight: (ranges) => calls.match.push([...ranges]),
    applyActiveHighlight: (r) => calls.active.push(r),
    clearHighlights: () => {
      calls.clear += 1;
    },
    scrollRangeIntoView: (r) => calls.scroll.push(r),
    measureRangeHeight: (r) => (r as FakeRange | null)?.height ?? 0,
    scheduleFramePair: (cb) => calls.frames.push(cb),
  };
  return {
    env,
    calls,
    makeRange,
    setRangesByText(next: Record<string, FakeRange[]>) {
      rangesByText = next;
    },
  };
}

interface FakeProviderOptions {
  pos?: number;
  connected?: boolean;
  count?: number | (() => number);
  rendered?: boolean;
  unrendered?: boolean;
  loadRest?: () => Promise<void> | void;
}

function createFakeProvider(options: FakeProviderOptions = {}) {
  const el: FakeNode = { pos: options.pos ?? 0, connected: options.connected !== false };
  const calls = {
    show: [] as Array<{ text: string; index: number; epoch: number }>,
    clear: 0,
    count: 0,
    loadRest: 0,
  };
  const provider: FindInPageScopeProvider = {
    getScopeEl: () => el as unknown as Element,
    count: () => {
      calls.count += 1;
      const value = options.count;
      if (typeof value === "function") {
        return value();
      }
      return value ?? 0;
    },
    show: (text, index, epoch) => {
      calls.show.push({ text, index, epoch });
    },
    clear: () => {
      calls.clear += 1;
    },
  };
  if (options.rendered !== undefined) {
    provider.isMatchRendered = () => options.rendered === true;
  }
  if (options.unrendered !== undefined) {
    provider.hasUnrenderedContent = () => options.unrendered === true;
  }
  if (options.loadRest) {
    provider.loadRest = () => {
      calls.loadRest += 1;
      return options.loadRest?.();
    };
  }
  return { provider, calls, el };
}

function dispatchPayload(
  text: string,
  overrides: Partial<{ epoch: number; findNext: boolean; forward: boolean }> = {},
) {
  return {
    epoch: overrides.epoch ?? 1,
    text,
    findNext: overrides.findNext ?? true,
    forward: overrides.forward ?? true,
  };
}

// ── selectActiveIndex 纯规则（验收 18）──

test("selectActiveIndex：new 选首命中，step ±1 循环 wrap，incremental remap/clamp，grow 保持", () => {
  assert.equal(selectActiveIndex("new", 5, 3, true, -1), 0);
  assert.equal(selectActiveIndex("new", -1, 0, true, -1), -1);
  // step：prev 无效时 forward→首 / backward→尾。
  assert.equal(selectActiveIndex("step", -1, 4, true, -1), 0);
  assert.equal(selectActiveIndex("step", -1, 4, false, -1), 3);
  // step：循环 wrap。
  assert.equal(selectActiveIndex("step", 3, 4, true, -1), 0);
  assert.equal(selectActiveIndex("step", 0, 4, false, -1), 3);
  assert.equal(selectActiveIndex("step", 1, 4, true, -1), 2);
  // incremental：exact remap 优先；否则 clamp；prev 无效回首。
  assert.equal(selectActiveIndex("incremental", 1, 4, true, 3), 3);
  assert.equal(selectActiveIndex("incremental", 9, 4, true, -1), 3);
  assert.equal(selectActiveIndex("incremental", -1, 4, true, -1), 0);
  // grow：active 保持并 clamp 进 [0,total-1]。
  assert.equal(selectActiveIndex("grow", 2, 5, true, -1), 2);
  assert.equal(selectActiveIndex("grow", 7, 5, true, -1), 4);
  assert.equal(selectActiveIndex("grow", -1, 5, true, -1), 0);
  assert.equal(selectActiveIndex("grow", 1, 0, true, -1), -1);
});

// ── 文档序归并纯核心（验收 18）──

test("mergeLegsInDocumentOrder：dom 段按 scope 文档位置切分，provider 腿插位正确", () => {
  const domRanges = [
    { id: "a", pos: 1 },
    { id: "b", pos: 4 },
    { id: "c", pos: 9 },
  ];
  const scopes = [
    { provider: { name: "P1" }, el: { pos: 3 }, count: 2 },
    { provider: { name: "P2" }, el: { pos: 7 }, count: 1 },
  ];
  const legs = mergeLegsInDocumentOrder(
    domRanges as never,
    scopes as never,
    (range) => range as { pos: number },
    (a, b) => Math.sign((a as { pos: number }).pos - (b as { pos: number }).pos),
  );
  // 期望：dom[a] | P1 | dom[b] | P2 | dom[c]
  assert.deepEqual(
    legs.map((leg) =>
      leg.kind === "dom" ? leg.ranges.map((r) => (r as { id: string }).id) : leg.provider,
    ),
    [["a"], { name: "P1" }, ["b"], { name: "P2" }, ["c"]],
  );
});

test("mergeLegsInDocumentOrder：scope 在全部 range 前/后时 dom 空段被跳过", () => {
  const domRanges = [{ id: "a", pos: 5 }];
  const scopes = [
    { provider: { name: "before" }, el: { pos: 1 }, count: 1 },
    { provider: { name: "after" }, el: { pos: 9 }, count: 1 },
  ];
  const legs = mergeLegsInDocumentOrder(
    domRanges as never,
    scopes as never,
    (range) => range as { pos: number },
    (a, b) => Math.sign((a as { pos: number }).pos - (b as { pos: number }).pos),
  );
  assert.deepEqual(
    legs.map((leg) =>
      leg.kind === "dom" ? leg.ranges.map((r) => (r as { id: string }).id) : leg.provider,
    ),
    [{ name: "before" }, ["a"], { name: "after" }],
  );
});

// ── DOM 搜索纯核心（内置腿算法）──

test("findTextMatchIntervals：大小写不敏感、非重叠、空查询/含哨兵查询无命中", () => {
  assert.deepEqual(findTextMatchIntervals("Hello hello HELLO", "hello"), [
    { start: 0, end: 5 },
    { start: 6, end: 11 },
    { start: 12, end: 17 },
  ]);
  assert.deepEqual(findTextMatchIntervals("aaa", "aa"), [{ start: 0, end: 2 }], "非重叠：不报 1-3");
  assert.deepEqual(findTextMatchIntervals("abc", ""), []);
  assert.deepEqual(findTextMatchIntervals("a\nbc", "a\nb"), [], "含 \\n 哨兵的查询不产生跨块命中");
  assert.deepEqual(findTextMatchIntervals("中文查找", "查找"), [{ start: 2, end: 4 }]);
});

test("mapMatchesToRanges：命中横跨相邻文本节点时 start/end 落在正确节点与偏移", () => {
  const nodeA = { data: "Hello " };
  const nodeB = { data: "world" };
  const entries = [
    { node: nodeA, start: 0 },
    { node: nodeB, start: 6 },
  ];
  const created: Array<{ start?: [unknown, number]; end?: [unknown, number] }> = [];
  const ranges = mapMatchesToRanges(entries, [{ start: 0, end: 11 }], {
    createRange: () => {
      const record: { start?: [unknown, number]; end?: [unknown, number] } = {};
      created.push(record);
      return {
        setStart: (node, offset) => {
          record.start = [node, offset];
        },
        setEnd: (node, offset) => {
          record.end = [node, offset];
        },
      };
    },
  });
  assert.equal(ranges.length, 1);
  assert.deepEqual(created[0]?.start, [nodeA, 0]);
  assert.deepEqual(created[0]?.end, [nodeB, 5]);
});

test("collectSearchableText：块级哨兵防跨块假命中，inline 边界可跨，排除子树/不可见/穿透 shadow", () => {
  const text = (data: string) => ({ kind: "text", data });
  const el = (
    tag: string,
    children: unknown[],
    extra: { rects?: number; shadow?: unknown[]; attrs?: string[] } = {},
  ) => ({
    kind: "el",
    tag,
    children,
    rects: extra.rects ?? 1,
    shadow: extra.shadow ?? null,
    attrs: extra.attrs ?? [],
  });

  const body = el("DIV", [
    text("foo"),
    el("P", [text("bar")]), // 块边界：foo|bar 不得拼接
    el("SPAN", [text("baz"), el("B", [text("qux")])]), // inline：bazqux 可跨
    el("DIV", [text("hidden")], { rects: 0 }), // 不可见子树跳过
    el("DIV", [text("scoped")], { attrs: ["data-find-provider-scope"] }), // provider scope 排除
    el("DIV", [text("shadowed")], { shadow: { children: [text("inside-shadow")] } }), // open shadow 穿透
  ]);
  const collectEnv = {
    getClientRects: (e: { rects?: number }) => e.rects ?? 1,
    isElement: (n: unknown): n is never => (n as { kind?: string })?.kind === "el",
    isText: (n: unknown): n is { data: string } => (n as { kind?: string })?.kind === "text",
    childNodes: (n: unknown) =>
      ((n as { children?: unknown[] }).children ?? []) as ReadonlyArray<unknown>,
    shadowRootOf: (e: { shadow?: unknown }) => e.shadow ?? null,
    tagNameOf: (e: { tag: string }) => e.tag,
    hasAttribute: (e: { attrs?: string[] }, name: string) => (e.attrs ?? []).includes(name),
  };
  const buffer = collectSearchableText(body, new Set(), collectEnv as never);
  assert.equal(findTextMatchIntervals(buffer.haystack, "foobar").length, 0, "块哨兵挡住跨块假命中");
  assert.equal(
    findTextMatchIntervals(buffer.haystack, "bazqux").length,
    1,
    "inline 拆分命中可跨节点",
  );
  assert.equal(
    findTextMatchIntervals(buffer.haystack, "hidden").length,
    0,
    "零 client rects 子树不可搜",
  );
  assert.equal(
    findTextMatchIntervals(buffer.haystack, "scoped").length,
    0,
    "scope 标记子树由内置腿排除",
  );
  assert.equal(
    findTextMatchIntervals(buffer.haystack, "inside-shadow").length,
    1,
    "open shadow root 穿透",
  );
  assert.equal(buffer.entries.length > 0, true);
});

// ── 协调器：归并 / 虚拟化感知 / loadRest / epoch（验收 18/19/21）──

test("协调器：内置 DOM 腿独立工作——total/activeIndex/高亮调用面", async (t) => {
  const stub = createStubEnv();
  const r0 = stub.makeRange(1);
  const r1 = stub.makeRange(5);
  stub.setRangesByText({ abc: [r0, r1] });
  const coordinator = createFindInPageCoordinator({ env: stub.env });
  t.after(() => coordinator.clear());

  const result = await coordinator.dispatchFind(dispatchPayload("abc"));
  assert.deepEqual(result, { activeIndex: 1, total: 2, activeInRenderedWindow: true });
  assert.deepEqual(stub.calls.match.at(-1), [r0, r1], "全部命中层收到文档序 ranges");
  assert.equal(stub.calls.active.at(-1), r0, "active 层收到首命中");
  assert.deepEqual(stub.calls.scroll.at(-1), r0, "active 命中滚动到视口");
});

test("协调器：provider 腿按文档序归并，show 收到腿内序号/-1，失联 scope 排尾", async (t) => {
  const stub = createStubEnv();
  const domRange = stub.makeRange(1);
  stub.setRangesByText({ abc: [domRange] });
  const connected = createFakeProvider({ pos: 5, count: 2 });
  const disconnected = createFakeProvider({ pos: 0, connected: false, count: 1 });
  const disposeA = registerFindInPageProvider(connected.provider);
  const disposeB = registerFindInPageProvider(disconnected.provider);
  t.after(() => {
    disposeA();
    disposeB();
  });
  const coordinator = createFindInPageCoordinator({ env: stub.env });
  t.after(() => coordinator.clear());

  const result = await coordinator.dispatchFind(dispatchPayload("abc"));
  // 归并序：dom(1) | connected(2) | disconnected 排尾(1) → total=4，active=dom 首命中。
  assert.equal(result.total, 4);
  assert.equal(result.activeIndex, 1);
  assert.deepEqual(
    connected.calls.show.at(-1),
    { text: "abc", index: -1, epoch: 0 },
    "active 不在本腿 → -1",
  );
  assert.deepEqual(disconnected.calls.show.at(-1), { text: "abc", index: -1, epoch: 0 });

  // 步进 2 次：active 移入 connected 腿（全局序号 1 → 腿内 0）。
  await coordinator.dispatchFind(dispatchPayload("abc", { findNext: false, forward: true }));
  assert.deepEqual(connected.calls.show.at(-1), { text: "abc", index: 0, epoch: 0 });
  await coordinator.dispatchFind(dispatchPayload("abc", { findNext: false, forward: true }));
  const third = await coordinator.dispatchFind(
    dispatchPayload("abc", { findNext: false, forward: true }),
  );
  assert.equal(third.activeIndex, 4, "第 4 命中落在失联腿（排尾）");
  assert.deepEqual(disconnected.calls.show.at(-1), { text: "abc", index: 0, epoch: 0 });
});

test("虚拟化感知：active 在 provider 未渲染窗口 → activeInRenderedWindow=false；无 loadRest+未渲染 → hasUnsearchableRegions", async (t) => {
  const stub = createStubEnv();
  stub.setRangesByText({}); // 内置腿零命中
  const virtualized = createFakeProvider({ pos: 1, count: 3, rendered: false, unrendered: true });
  const dispose = registerFindInPageProvider(virtualized.provider);
  t.after(() => dispose());
  const coordinator = createFindInPageCoordinator({ env: stub.env });
  t.after(() => coordinator.clear());

  const result = await coordinator.dispatchFind(dispatchPayload("abc"));
  // count=3 > 0 → 不触发 loadRest；active 落在 provider 腿且 isMatchRendered=false。
  assert.equal(result.total, 3);
  assert.equal(result.activeIndex, 1);
  assert.equal(result.activeInRenderedWindow, false);
  assert.equal(
    result.hasUnsearchableRegions,
    true,
    "无 loadRest 能力 + 有未渲染内容 → 不可搜标记，不作假命中",
  );
  assert.equal(virtualized.calls.loadRest, 0, "有命中时不触发 loadRest");
});

test("loadRest grow：total=0 触发全部 loadRest（4s 封顶可注入），物化后 grow 重搜一次 active 保持", async (t) => {
  const stub = createStubEnv();
  stub.setRangesByText({});
  let materialized = false;
  const grower = createFakeProvider({
    pos: 1,
    count: () => (materialized ? 2 : 0),
    loadRest: () => {
      materialized = true;
      return Promise.resolve();
    },
  });
  const dispose = registerFindInPageProvider(grower.provider);
  t.after(() => dispose());
  const coordinator = createFindInPageCoordinator({ env: stub.env, loadRestTimeoutMs: 50 });
  t.after(() => coordinator.clear());

  const result = await coordinator.dispatchFind(dispatchPayload("abc"));
  assert.equal(grower.calls.loadRest, 1, "零命中触发 loadRest");
  assert.equal(result.total, 2, "grow 重搜看到物化后的命中");
  assert.equal(result.activeIndex, 1);
  assert.equal(stub.calls.search.length, 2, "搜索恰好两轮（首搜 + grow）");
});

test("loadRest 超时封顶：永不 settle 的 loadRest 被超时放行，结果 fail-soft 收口 {0,0}", async (t) => {
  const stub = createStubEnv();
  stub.setRangesByText({});
  const stalled = createFakeProvider({
    pos: 1,
    count: 0,
    loadRest: () => new Promise<void>(() => {}), // 永不 settle
  });
  const dispose = registerFindInPageProvider(stalled.provider);
  t.after(() => dispose());
  const coordinator = createFindInPageCoordinator({ env: stub.env, loadRestTimeoutMs: 15 });
  t.after(() => coordinator.clear());

  const started = Date.now();
  const result = await coordinator.dispatchFind(dispatchPayload("abc"));
  assert.deepEqual(result, { activeIndex: 0, total: 0 });
  assert.ok(Date.now() - started < 2000, "超时封顶生效，不悬挂");
});

test("epoch 守卫：loadRest 等待期间 clear() → 本轮作废收口 {0,0}，不再 grow 重搜", async (t) => {
  const stub = createStubEnv();
  stub.setRangesByText({});
  let releaseLoadRest: (() => void) | null = null;
  let materialized = false;
  const grower = createFakeProvider({
    pos: 1,
    count: () => (materialized ? 5 : 0),
    loadRest: () =>
      new Promise<void>((resolve) => {
        releaseLoadRest = () => {
          materialized = true;
          resolve();
        };
      }),
  });
  const dispose = registerFindInPageProvider(grower.provider);
  t.after(() => dispose());
  const coordinator = createFindInPageCoordinator({ env: stub.env, loadRestTimeoutMs: 500 });

  const pending = coordinator.dispatchFind(dispatchPayload("abc"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stub.calls.search.length, 1, "首搜已跑，等待 loadRest");
  coordinator.clear(); // 用户关闭查找栏 / main 下发 clear
  releaseLoadRest?.();
  const result = await pending;
  assert.deepEqual(result, { activeIndex: 0, total: 0 });
  assert.equal(stub.calls.search.length, 1, "epoch 失配：grow 重搜被作废");
});

test("provider 抛错 safe-call：count 抛错按 0 命中，show 抛错不拖垮整轮（验收 21）", async (t) => {
  const stub = createStubEnv();
  const domRange = stub.makeRange(1);
  stub.setRangesByText({ abc: [domRange] });
  const hostile: FindInPageScopeProvider = {
    getScopeEl: () => {
      throw new Error("scope exploded");
    },
    count: () => {
      throw new Error("count exploded");
    },
    show: () => {
      throw new Error("show exploded");
    },
    clear: () => {
      throw new Error("clear exploded");
    },
  };
  const dispose = registerFindInPageProvider(hostile);
  t.after(() => dispose());
  const coordinator = createFindInPageCoordinator({ env: stub.env });

  // getScopeEl 抛错 → 失联腿排尾；count 抛错 → 0 命中；show 抛错 → 吞掉。
  const result = await coordinator.dispatchFind(dispatchPayload("abc"));
  assert.deepEqual(result, { activeIndex: 1, total: 1, activeInRenderedWindow: true });
  coordinator.clear(); // clear 抛错也不得冒泡
});

test("重绘重试预算：active 高度 0 → double-rAF 重绘，预算封顶后停止（验收 13/R13）", async (t) => {
  const stub = createStubEnv();
  const flat = stub.makeRange(1);
  flat.height = 0; // 布局未就绪
  stub.setRangesByText({ abc: [flat] });
  const coordinator = createFindInPageCoordinator({ env: stub.env, repaintRetryBudget: 3 });
  t.after(() => coordinator.clear());

  await coordinator.dispatchFind(dispatchPayload("abc"));
  const initialActiveCalls = stub.calls.active.length;
  assert.equal(initialActiveCalls, 1);
  // 泵帧：每次 check 高度仍 0 → 重绘一次并再调度，直到预算耗尽。
  for (let i = 0; i < 10; i += 1) {
    const frame = stub.calls.frames.shift();
    if (!frame) {
      break;
    }
    frame();
  }
  assert.equal(stub.calls.active.length - initialActiveCalls, 3, "重绘恰好预算次数后停止");
  assert.equal(stub.calls.frames.length, 0, "预算耗尽后不再调度");
});

test("clear：本地 epoch 递增、查询态重置、provider.clear 广播、高亮清空", async (t) => {
  const stub = createStubEnv();
  stub.setRangesByText({ abc: [stub.makeRange(1)] });
  const provider = createFakeProvider({ pos: 5, count: 1 });
  const dispose = registerFindInPageProvider(provider.provider);
  t.after(() => dispose());
  const coordinator = createFindInPageCoordinator({ env: stub.env });

  await coordinator.dispatchFind(dispatchPayload("abc"));
  const epochBefore = coordinator.localEpoch;
  coordinator.clear();
  assert.equal(coordinator.localEpoch, epochBefore + 1);
  assert.equal(coordinator.currentQuery, "");
  assert.equal(provider.calls.clear, 1);
  assert.ok(stub.calls.clear >= 1);

  // clear 后同文本重搜 = 新查询（active 回首命中而非步进）。
  const result = await coordinator.dispatchFind(dispatchPayload("abc"));
  assert.equal(result.activeIndex, 1);
});

// ── 注册表（验收 18 前置） ──

test("注册表：注册/注销/订阅通知，dispose 幂等", () => {
  const before = getFindInPageProviders().length;
  let notifications = 0;
  const unsubscribe = subscribeFindInPageProviderRegistry(() => {
    notifications += 1;
  });
  const provider = createFakeProvider({ pos: 1, count: 0 });
  const dispose = registerFindInPageProvider(provider.provider);
  assert.equal(getFindInPageProviders().length, before + 1);
  assert.equal(notifications, 1);
  dispose();
  assert.equal(getFindInPageProviders().length, before);
  assert.equal(notifications, 2);
  dispose(); // 幂等
  assert.equal(notifications, 2);
  unsubscribe();
});
