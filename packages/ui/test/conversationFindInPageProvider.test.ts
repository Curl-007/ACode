import assert from "node:assert/strict";
import test from "node:test";
import type { FindInPageCoordinatorEnv } from "../src/find-in-page/findInPageCoordinatorEnv.js";
import { createFindInPageCoordinator } from "../src/find-in-page/findInPageCoordinator.js";
import { FIND_HIGHLIGHT_NAME } from "../src/find-in-page/findInPageHighlight.js";
import {
  getFindInPageProviders,
  registerFindInPageProvider,
} from "../src/find-in-page/findInPageProvider.js";
import type { FindInPageScopeProvider } from "../src/find-in-page/findInPageProvider.js";
import {
  createConversationFindInPageProvider,
  FIND_TIMELINE_FULL_MOUNT_CAP,
  type ConversationFindInPageProviderDeps,
} from "../src/v4/conversationFindInPageProvider.js";

/**
 * WI-E2b：ConversationTimeline 虚拟化列表 provider 接线单测
 * （specs: packages/desktop/specs/find-in-page.md R11/R15，验收 22-24）。
 *
 * 虚拟器 stub：requestExpandedMount(target) 模拟「窗口 ±target 全挂载」
 * （rendered = min(windowSize + 2*target, total)）；DOM 搜索腿由
 * searchScopeRanges stub 替身（纯核心 findInPageDomSearch 已有独立测试）。
 * 注册表是模块级单例，每个用例注册后必须 dispose。
 */

// ── 测试替身 ──

interface FakeNode {
  pos: number;
  connected: boolean;
}

function makeFakeRange(id: string, scrollCalls?: unknown[]) {
  return {
    id,
    startContainer: {
      getRootNode: () => ({}),
      parentElement:
        scrollCalls === undefined
          ? null
          : { scrollIntoView: (options: unknown) => scrollCalls.push(options) },
    },
  };
}

interface StubVirtualizerOptions {
  total: number;
  rendered?: number;
  windowSize?: number;
  batchSize?: number;
  cap?: number;
  rangesFor?: (rendered: number, total: number) => readonly unknown[];
  scopeEl?: Element | null;
  /** awaitCommitted 手动泵：true 时 commit 需测试显式放行。 */
  manualCommits?: boolean;
}

function createStubDeps(options: StubVirtualizerOptions) {
  let rendered = options.rendered ?? 10;
  const total = options.total;
  const windowSize = options.windowSize ?? 10;
  const calls = {
    requests: [] as number[],
    resets: 0,
    searches: [] as string[],
    commitWaiters: [] as Array<() => void>,
  };
  const deps: ConversationFindInPageProviderDeps = {
    getScopeEl: () => options.scopeEl ?? null,
    searchScopeRanges: (text) => {
      calls.searches.push(text);
      return options.rangesFor?.(rendered, total) ?? [];
    },
    getRenderedUnitCount: () => rendered,
    getTotalUnitCount: () => total,
    requestExpandedMount: (target) => {
      calls.requests.push(target);
      rendered = Math.min(windowSize + 2 * target, total);
    },
    resetExpandedMount: () => {
      calls.resets += 1;
      for (const resolve of calls.commitWaiters.splice(0)) {
        resolve();
      }
    },
    awaitCommitted: () =>
      options.manualCommits === true
        ? new Promise<void>((resolve) => {
            calls.commitWaiters.push(resolve);
          })
        : Promise.resolve(),
    mountBatchSize: options.batchSize,
    fullMountCap: options.cap,
  };
  return { deps, calls };
}

function createStubCoordinatorEnv() {
  const calls = { search: 0, clear: 0 };
  const env: FindInPageCoordinatorEnv = {
    hasDocument: () => true,
    searchDocument: () => {
      calls.search += 1;
      return [];
    },
    rangeStartNode: (range) => (range as { start: FakeNode }).start,
    hostify: (node) => node,
    isConnected: (node) => (node as FakeNode | null)?.connected !== false,
    comparePosition: (a, b) => Math.sign((a as FakeNode).pos - (b as FakeNode).pos),
    sameRangeBoundaries: (a, b) => a === b,
    applyMatchHighlight: () => {},
    applyActiveHighlight: () => {},
    clearHighlights: () => {
      calls.clear += 1;
    },
    scrollRangeIntoView: () => {},
    measureRangeHeight: () => 1,
    scheduleFramePair: () => {},
  };
  return { env, calls };
}

function dispatchPayload(text: string) {
  return { epoch: 1, text, findNext: true, forward: true };
}

const SCOPE_EL = { pos: 5, connected: true } as unknown as Element;

// ── 纯核心：批增长 / 封顶 / clear 作废（验收 22）──

test("loadRest 批增长：overscan 目标按批步进直到全量挂载，hasUnrenderedContent 收敛为 false", async () => {
  const { deps, calls } = createStubDeps({ total: 1000, rendered: 10, batchSize: 400 });
  const provider = createConversationFindInPageProvider(deps);
  assert.equal(typeof provider.loadRest, "function");
  assert.equal(provider.hasUnrenderedContent?.(), true);

  await provider.loadRest?.();
  assert.deepEqual(calls.requests, [410, 1000], "每批推进 batchSize，封顶于 unit 总数");
  assert.equal(provider.hasUnrenderedContent?.(), false, "全量挂载后无未渲染内容");

  await provider.loadRest?.();
  assert.deepEqual(calls.requests, [410, 1000], "已全量时 loadRest 立即返回，不重复请求");
});

test("loadRest 封顶：unit 总数超过全挂载帽 → 不提供 loadRest，未渲染区诚实申报", () => {
  const overCap = createConversationFindInPageProvider(
    createStubDeps({ total: 101, rendered: 10, cap: 100 }).deps,
  );
  assert.equal(overCap.loadRest, undefined, "超帽不提供加载能力（协调器据此报不可搜区）");
  assert.equal(overCap.hasUnrenderedContent?.(), true);

  const atCap = createConversationFindInPageProvider(
    createStubDeps({ total: 100, rendered: 10, cap: 100 }).deps,
  );
  assert.equal(typeof atCap.loadRest, "function", "帽内仍提供批增长");
  assert.equal(FIND_TIMELINE_FULL_MOUNT_CAP > 0, true);
});

test("clear 作废在途批增长：代际失配循环退出，resetExpandedMount 复位 overscan", async () => {
  const { deps, calls } = createStubDeps({
    total: 1000,
    rendered: 10,
    batchSize: 400,
    manualCommits: true,
  });
  const provider = createConversationFindInPageProvider(deps);
  const pending = provider.loadRest?.();
  assert.deepEqual(calls.requests, [410], "首批同步发出");

  provider.clear();
  assert.equal(calls.resets, 1, "clear 复位扩展态");
  assert.equal(calls.commitWaiters.length, 0, "reset 放行 commit 等待者");
  await pending;
  assert.deepEqual(calls.requests, [410], "代际作废后不再发出新批");

  const again = provider.loadRest?.();
  assert.notEqual(again, undefined, "clear 后新一轮 loadRest 可重新批增长");
  // 泵 commit 直到循环退出（每醒一次发一批， rendered 由 stub 按 overscan 公式推进）。
  for (let pump = 0; pump < 10 && calls.commitWaiters.length > 0; pump += 1) {
    for (const resolve of calls.commitWaiters.splice(0)) {
      resolve();
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  await again;
  assert.ok(calls.requests.length > 1);
});

test("loadRest 重入复用在途 promise，不重复发批", async () => {
  const { deps, calls } = createStubDeps({ total: 100, rendered: 10, manualCommits: true });
  const provider = createConversationFindInPageProvider(deps);
  const first = provider.loadRest?.();
  const second = provider.loadRest?.();
  assert.equal(first, second);
  assert.deepEqual(calls.requests, [100], "一批即到全量（batch 400 大于剩余量）");
  for (const resolve of calls.commitWaiters.splice(0)) {
    resolve();
  }
  await first;
  assert.equal(provider.hasUnrenderedContent?.(), false);
});

// ── 高亮：追加不清层 / active / surgical clear（验收 24 前置）──

interface FakeHighlight {
  ranges: Set<unknown>;
  priority?: number;
  add(range: unknown): void;
  delete(range: unknown): void;
  clear(): void;
}

function createFakeHighlight(): FakeHighlight {
  return {
    ranges: new Set<unknown>(),
    priority: undefined,
    add(range) {
      this.ranges.add(range);
    },
    delete(range) {
      this.ranges.delete(range);
    },
    clear() {
      this.ranges.clear();
    },
  };
}

function createFakeDocument() {
  const registry = new Map<string, FakeHighlight>();
  class FakeStyleSheet {
    rules: string[] = [];
    get cssRules() {
      return { length: this.rules.length };
    }
    insertRule(rule: string, index: number) {
      this.rules.splice(index, 0, rule);
    }
  }
  const doc = {
    defaultView: {
      CSS: { highlights: registry },
      Highlight: createFakeHighlight,
      CSSStyleSheet: FakeStyleSheet,
    },
    adoptedStyleSheets: [] as unknown[],
  };
  return { doc, registry };
}

test("show 追加进共享全部命中层（不清 dom 腿既有高亮），active 落腿内时绘制并滚动", () => {
  const { doc, registry } = createFakeDocument();
  // 协调器每轮先画 dom 腿：共享层已有一个 dom range——provider 必须追加而非清层。
  const domHighlight = createFakeHighlight();
  const domRange = { id: "dom" };
  domHighlight.add(domRange);
  registry.set(FIND_HIGHLIGHT_NAME, domHighlight);

  const scrollCalls: unknown[] = [];
  const scopeRangeA = makeFakeRange("a");
  const scopeRangeB = makeFakeRange("b", scrollCalls);
  const scopeEl = { ownerDocument: doc } as unknown as Element;
  const { deps } = createStubDeps({
    total: 10,
    rendered: 10,
    scopeEl,
    rangesFor: () => [scopeRangeA, scopeRangeB],
  });
  const provider = createConversationFindInPageProvider(deps);

  provider.show("abc", 1, 0);
  assert.ok(domHighlight.ranges.has(domRange), "dom 腿既有高亮未被清掉");
  assert.ok(domHighlight.ranges.has(scopeRangeA) && domHighlight.ranges.has(scopeRangeB));
  assert.ok(doc.adoptedStyleSheets.length >= 1, "::highlight 规则 sheet 已 adopt");
  const active = registry.get("acode-find-in-page-active");
  assert.ok(active?.ranges.has(scopeRangeB), "active 层绘制腿内命中");
  assert.equal(active?.priority, 1);
  assert.equal(scrollCalls.length, 1, "provider 腿的 active 自滚进视口");

  // active 不在本腿（-1）：不动 active 层（协调器/其他腿负责）。
  provider.show("abc", -1, 0);
  assert.ok(active?.ranges.has(scopeRangeB), "activeIndexInScope=-1 不触碰 active 层");

  // clear：surgical 撤除——共享层只删本腿 ranges，dom range 保留；active 只清自己画的。
  provider.clear();
  assert.ok(domHighlight.ranges.has(domRange), "surgical 清理保留 dom 腿高亮");
  assert.equal(domHighlight.ranges.size, 1);
  assert.equal(active?.ranges.size, 0, "本腿画过的 active 被清除");
});

// ── 协调器集成（验收 22/23/24）──

async function dispatchWithProvider(
  provider: FindInPageScopeProvider,
  text: string,
  after: (dispose: () => void) => void,
) {
  const dispose = registerFindInPageProvider(provider);
  after(dispose);
  const { env } = createStubCoordinatorEnv();
  const coordinator = createFindInPageCoordinator({ env });
  const result = await coordinator.dispatchFind(dispatchPayload(text));
  coordinator.clear();
  return result;
}

test("集成：渲染窗口内命中——total/activeIndex 正常，无不可搜标记（验收 22）", async (t) => {
  const hit = makeFakeRange("hit");
  const { deps, calls } = createStubDeps({
    total: 10,
    rendered: 10,
    scopeEl: SCOPE_EL,
    rangesFor: () => [hit],
  });
  const provider = createConversationFindInPageProvider(deps);
  const result = await dispatchWithProvider(provider, "abc", (dispose) => t.after(dispose));
  assert.deepEqual(result, { activeIndex: 1, total: 1, activeInRenderedWindow: true });
  assert.equal(calls.requests.length, 0, "有命中不触发 loadRest");
});

test("集成：窗口外命中——total=0 触发 loadRest 批增长，grow 重搜命中（验收 23）", async (t) => {
  const hits = [makeFakeRange("h1"), makeFakeRange("h2"), makeFakeRange("h3")];
  const { deps, calls } = createStubDeps({
    total: 100,
    rendered: 10,
    batchSize: 400,
    scopeEl: SCOPE_EL,
    rangesFor: (rendered, total) => (rendered >= total ? hits : []),
  });
  const provider = createConversationFindInPageProvider(deps);
  const result = await dispatchWithProvider(provider, "abc", (dispose) => t.after(dispose));
  assert.deepEqual(calls.requests, [100], "批增长一次到全量（batch 大于剩余量）");
  assert.equal(result.total, 3, "grow 重搜看到物化后的窗口外命中");
  assert.equal(result.activeIndex, 1);
  assert.ok(calls.searches.length >= 2, "首搜 + grow 重搜各搜一次");
});

test("集成：无剩余能力（超帽）→ hasUnsearchableRegions=true，不对未渲染区作假命中（验收 23）", async (t) => {
  const { deps, calls } = createStubDeps({
    total: 200,
    rendered: 10,
    cap: 100,
    scopeEl: SCOPE_EL,
    rangesFor: () => [],
  });
  const provider = createConversationFindInPageProvider(deps);
  const result = await dispatchWithProvider(provider, "abc", (dispose) => t.after(dispose));
  assert.deepEqual(result, { activeIndex: 0, total: 0, hasUnsearchableRegions: true });
  assert.equal(calls.requests.length, 0, "无 loadRest 能力时不发任何挂载请求");
});

test("集成：unmount 注销后 provider 路静默——注册表归零，后续 dispatch 零命中（验收 24）", async (t) => {
  const { deps, calls } = createStubDeps({
    total: 10,
    rendered: 10,
    scopeEl: SCOPE_EL,
    rangesFor: () => [makeFakeRange("hit")],
  });
  const provider = createConversationFindInPageProvider(deps);
  const dispose = registerFindInPageProvider(provider);
  t.after(dispose);
  const { env } = createStubCoordinatorEnv();
  const coordinator = createFindInPageCoordinator({ env });
  t.after(() => coordinator.clear());

  const before = await coordinator.dispatchFind(dispatchPayload("abc"));
  assert.equal(before.total, 1);
  const searchesBefore = calls.searches.length;

  // 模拟 hook 卸载清理：先 clear（复位扩展/撤高亮）再摘注册表。
  provider.clear();
  dispose();
  assert.equal(getFindInPageProviders().length, 0, "注册表归零（桥将申报 providerActive=false）");
  assert.equal(calls.resets, 1);

  const after = await coordinator.dispatchFind(dispatchPayload("abc"));
  assert.deepEqual(after, { activeIndex: 0, total: 0 });
  assert.equal(calls.searches.length, searchesBefore, "注销后 provider 腿不再被调用");
});
