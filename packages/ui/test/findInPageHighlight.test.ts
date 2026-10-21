import assert from "node:assert/strict";
import test from "node:test";
import {
  FIND_HIGHLIGHT_ACTIVE_NAME,
  FIND_HIGHLIGHT_NAME,
  applyActiveHighlight,
  applyMatchHighlight,
  clearAllFindHighlights,
  clearFindHighlights,
  isHighlightApiSupported,
} from "../src/find-in-page/findInPageHighlight.js";

/**
 * 页内查找二期：CSS Custom Highlight API 调用面单测（最小 DOM stub，无 jsdom）
 * （specs: packages/desktop/specs/find-in-page.md 验收 20 / R12）。
 */

// ── 最小 stub：只实现封装消费的 window/document/Range 表面 ──

class FakeHighlight {
  ranges: unknown[] = [];
  priority = 0;
  add(range: unknown): void {
    this.ranges.push(range);
  }
  clear(): void {
    this.ranges = [];
  }
}

class FakeStyleSheet {
  rules: string[] = [];
  cssRules = {
    get length(): number {
      return 0;
    },
  };
  insertRule(rule: string): number {
    this.rules.push(rule);
    return this.rules.length;
  }
}

interface FakeDocOptions {
  supported?: boolean;
}

function createFakeDoc(options: FakeDocOptions = {}) {
  const highlights = new Map<string, FakeHighlight>();
  const sheetCtor = options.supported === false ? undefined : FakeStyleSheet;
  const doc = {
    defaultView: {
      CSS: options.supported === false ? undefined : { highlights },
      Highlight: options.supported === false ? undefined : FakeHighlight,
      CSSStyleSheet: sheetCtor,
    },
    adoptedStyleSheets: [] as unknown[],
  };
  return { doc, highlights };
}

function createFakeRange(root: unknown) {
  return { startContainer: { getRootNode: () => root } };
}

type DocParam = Parameters<typeof applyMatchHighlight>[0];
type RangeParam = Parameters<typeof applyMatchHighlight>[1][number];

const asDoc = (doc: unknown): DocParam => doc as DocParam;
const asRange = (range: unknown): RangeParam => range as RangeParam;

// ── 用例 ──

test("特性探测：CSS.highlights + Highlight 构造器齐备才算支持", () => {
  const supported = createFakeDoc();
  assert.equal(isHighlightApiSupported(asDoc(supported.doc)), true);
  const unsupported = createFakeDoc({ supported: false });
  assert.equal(isHighlightApiSupported(asDoc(unsupported.doc)), false);
});

test("applyMatchHighlight：ranges 进全部命中层，::highlight 规则用主题 token，sheet adopt 到文档", () => {
  const { doc, highlights } = createFakeDoc();
  const r1 = createFakeRange(doc);
  const r2 = createFakeRange(doc);
  applyMatchHighlight(asDoc(doc), [asRange(r1), asRange(r2)]);

  const all = highlights.get(FIND_HIGHLIGHT_NAME);
  assert.ok(all, "全部命中 Highlight 已注册");
  assert.deepEqual(all.ranges, [r1, r2]);
  assert.equal(all.priority, 0, "全部命中层无 priority 抬升");
  assert.ok(doc.adoptedStyleSheets.length >= 1, "sheet 已 adopt 到文档");

  // 重放清空旧 ranges（幂等重绘）。
  applyMatchHighlight(asDoc(doc), [asRange(r2)]);
  assert.deepEqual(highlights.get(FIND_HIGHLIGHT_NAME)?.ranges, [r2]);
});

test("::highlight 规则内容：全部/活动两层，颜色走 --color-find-highlight* token", () => {
  const { doc } = createFakeDoc();
  applyMatchHighlight(asDoc(doc), [asRange(createFakeRange(doc))]);
  const sheet = doc.adoptedStyleSheets[0] as FakeStyleSheet;
  assert.ok(sheet, "sheet 已创建并 adopt");
  const joined = sheet.rules.join("\n");
  assert.ok(joined.includes(`::highlight(${FIND_HIGHLIGHT_NAME})`), "全部命中规则在场");
  assert.ok(joined.includes(`::highlight(${FIND_HIGHLIGHT_ACTIVE_NAME})`), "活动命中规则在场");
  assert.ok(joined.includes("var(--color-find-highlight,"), "主题 token + 回退值");
  assert.ok(joined.includes("var(--color-find-highlight-active,"), "活动层主题 token");
});

test("applyActiveHighlight：活动层 priority=1 压过全部命中层；null 只清活动层", () => {
  const { doc, highlights } = createFakeDoc();
  const r1 = createFakeRange(doc);
  applyMatchHighlight(asDoc(doc), [asRange(r1)]);
  applyActiveHighlight(asDoc(doc), asRange(r1));
  const active = highlights.get(FIND_HIGHLIGHT_ACTIVE_NAME);
  assert.ok(active);
  assert.equal(active.priority, 1);
  assert.deepEqual(active.ranges, [r1]);
  applyActiveHighlight(asDoc(doc), null);
  assert.deepEqual(highlights.get(FIND_HIGHLIGHT_ACTIVE_NAME)?.ranges, []);
  assert.deepEqual(
    highlights.get(FIND_HIGHLIGHT_NAME)?.ranges,
    [r1],
    "全部命中层不受活动层清理影响",
  );
});

test("shadow root 感知：命中在 shadow root 内时 sheet adopt 到该 root（零 DOM 变更）", () => {
  const { doc } = createFakeDoc();
  const shadowRoot = { adoptedStyleSheets: [] as unknown[] };
  const shadowRange = createFakeRange(shadowRoot);
  const lightRange = createFakeRange(doc);
  applyMatchHighlight(asDoc(doc), [asRange(shadowRange), asRange(lightRange)]);
  assert.equal(
    shadowRoot.adoptedStyleSheets.length,
    1,
    "shadow root 采纳同一 sheet（::highlight 规则在其内生效）",
  );
  assert.equal(doc.adoptedStyleSheets.length, 1, "文档层采纳（light DOM 命中）");
  assert.equal(
    shadowRoot.adoptedStyleSheets[0],
    doc.adoptedStyleSheets[0],
    "同一 per-document sheet 复用",
  );
});

test("clearFindHighlights：两层注册表键删除；clearAll 覆盖已跟踪文档", () => {
  const { doc, highlights } = createFakeDoc();
  applyMatchHighlight(asDoc(doc), [asRange(createFakeRange(doc))]);
  applyActiveHighlight(asDoc(doc), asRange(createFakeRange(doc)));
  assert.equal(highlights.size, 2);
  clearFindHighlights(asDoc(doc));
  assert.equal(highlights.has(FIND_HIGHLIGHT_NAME), false);
  assert.equal(highlights.has(FIND_HIGHLIGHT_ACTIVE_NAME), false);

  // clearAll：另一文档的高亮也被清空。
  const second = createFakeDoc();
  applyMatchHighlight(asDoc(second.doc), [asRange(createFakeRange(second.doc))]);
  clearAllFindHighlights();
  assert.equal(second.highlights.size, 0);
});

test("API 缺席（老内核）：全部操作 no-op——不抛错、不注册、不 adopt（R12 降级不中断）", () => {
  const { doc, highlights } = createFakeDoc({ supported: false });
  const range = createFakeRange(doc);
  applyMatchHighlight(asDoc(doc), [asRange(range)]);
  applyActiveHighlight(asDoc(doc), asRange(range));
  clearFindHighlights(asDoc(doc));
  assert.equal(highlights.size, 0);
  assert.equal(doc.adoptedStyleSheets.length, 0);
});
