/**
 * 页内查找二期：CSS Custom Highlight API 封装（specs: packages/desktop/specs/find-in-page.md R12）。
 *
 * 零 DOM 变更高亮：命中 Range 注册进 CSS.highlights 的命名 Highlight，::highlight()
 * 规则经 adoptedStyleSheets 注入——不包 <mark>、不改文本节点、不触发布局脏化。
 * shadow root 感知：命中 range 位于 shadow root 时，样式 sheet 同步 adopt 到该 root
 * （::highlight 规则只在 sheet 所属 root 生效）。
 *
 * 颜色走 --color-find-highlight / --color-find-highlight-active token（主题化，与
 * ModelTrajectorySearchHighlight 同一视觉语言）。API 缺席（老内核/非浏览器环境）时
 * 全部操作 no-op——provider 路降级不中断：搜索与计数照常，只是不绘制高亮。
 */

/** 全部命中 Highlight 名（CSS.highlights 注册表键）。 */
export const FIND_HIGHLIGHT_NAME = "acode-find-in-page";
/** 活动命中 Highlight 名；priority=1 压过全部命中层。 */
export const FIND_HIGHLIGHT_ACTIVE_NAME = "acode-find-in-page-active";

/** Highlight API 的最小结构视图（浏览器实现 / 测试 stub 共用）。 */
interface HighlightLike {
  add(range: unknown): void;
  clear(): void;
  priority?: number;
}

interface HighlightRegistryLike {
  get(name: string): HighlightLike | undefined;
  set(name: string, highlight: HighlightLike): void;
  delete(name: string): void;
}

interface ShadowRootLike {
  adoptedStyleSheets: readonly CSSStyleSheet[];
}

interface DocumentLike {
  defaultView:
    | (Window & {
        CSS?: { highlights?: HighlightRegistryLike };
        Highlight?: new () => HighlightLike;
        CSSStyleSheet?: new () => CSSStyleSheet;
      })
    | null;
  adoptedStyleSheets?: readonly CSSStyleSheet[];
}

interface RangeLike {
  /** getRootNode() 返回 Document 或 ShadowRoot；结构探测在 adoptSheetForRange 内做。 */
  startContainer: { getRootNode(): unknown };
}

interface SheetRecord {
  sheet: CSSStyleSheet;
  rulesInserted: boolean;
}

/** per-document sheet 缓存（蓝本 WeakMap 同构）；文档回收即 sheet 消亡。 */
const sheetRecords = new WeakMap<DocumentLike, SheetRecord>();
/** 已写入高亮的文档集合：clearAll 需要遍历（蓝本 fa Set 同构）。 */
const highlightedDocuments = new Set<DocumentLike>();

function getHighlightRegistry(doc: DocumentLike): HighlightRegistryLike | undefined {
  return doc.defaultView?.CSS?.highlights;
}

/** 特性探测：CSS.highlights 注册表 + Highlight 构造器都在场才算支持。 */
export function isHighlightApiSupported(doc: DocumentLike): boolean {
  const view = doc.defaultView;
  return (
    Boolean(view) &&
    getHighlightRegistry(doc) !== undefined &&
    typeof view?.Highlight === "function"
  );
}

function ensureHighlightSheet(doc: DocumentLike): CSSStyleSheet | null {
  const view = doc.defaultView;
  if (!view || typeof view.CSSStyleSheet !== "function") {
    return null;
  }
  let record = sheetRecords.get(doc);
  if (!record) {
    record = { sheet: new view.CSSStyleSheet(), rulesInserted: false };
    sheetRecords.set(doc, record);
  }
  if (!record.rulesInserted) {
    // token 回退值与 ModelTrajectorySearchHighlight 一致（styles.css 各主题都有定义，
    // 回退仅覆盖 sheet 先于主题注入的窗口期）。
    record.sheet.insertRule(
      `::highlight(${FIND_HIGHLIGHT_NAME}) { background-color: var(--color-find-highlight, #fde68a); }`,
      record.sheet.cssRules.length,
    );
    record.sheet.insertRule(
      `::highlight(${FIND_HIGHLIGHT_ACTIVE_NAME}) { background-color: var(--color-find-highlight-active, #facc15); }`,
      record.sheet.cssRules.length,
    );
    record.rulesInserted = true;
  }
  return record.sheet;
}

/** shadow root 感知：把 sheet adopt 到 range 起点所在的根（document 或 shadow root）。 */
function adoptSheetForRange(doc: DocumentLike, sheet: CSSStyleSheet, range: RangeLike): void {
  const root = range.startContainer.getRootNode() as DocumentLike | ShadowRootLike;
  const target = (root && "adoptedStyleSheets" in root ? root : doc) as {
    adoptedStyleSheets: readonly CSSStyleSheet[];
  };
  if (!target.adoptedStyleSheets.includes(sheet)) {
    target.adoptedStyleSheets = [...target.adoptedStyleSheets, sheet];
  }
}

function getOrCreateHighlight(doc: DocumentLike, name: string): HighlightLike | null {
  const view = doc.defaultView;
  const registry = getHighlightRegistry(doc);
  if (!view || !registry || typeof view.Highlight !== "function") {
    return null;
  }
  ensureHighlightSheet(doc);
  let highlight = registry.get(name);
  if (!highlight) {
    highlight = new view.Highlight();
    if (name === FIND_HIGHLIGHT_ACTIVE_NAME) {
      highlight.priority = 1; // 活动层压过全部命中层（蓝本 priority=+isActive 同构）。
    }
    registry.set(name, highlight);
  }
  return highlight;
}

/**
 * 绘制全部命中：清空既有 all-highlight 后逐 range 注册（含 shadow root adopt）。
 * API 缺席时 no-op。ranges 须按文档序（调用方=协调器归并产物）。
 */
export function applyMatchHighlight(doc: DocumentLike, ranges: readonly RangeLike[]): void {
  if (!isHighlightApiSupported(doc)) {
    return;
  }
  const highlight = getOrCreateHighlight(doc, FIND_HIGHLIGHT_NAME);
  const sheet = ensureHighlightSheet(doc);
  if (!highlight || !sheet) {
    return;
  }
  highlight.clear();
  for (const range of ranges) {
    adoptSheetForRange(doc, sheet, range);
    highlight.add(range);
  }
  if (ranges.length > 0) {
    highlightedDocuments.add(doc);
  }
}

/** 绘制活动命中（null = 只清活动层）；活动层独立于全部命中层，可单独更新。 */
export function applyActiveHighlight(doc: DocumentLike, range: RangeLike | null): void {
  if (!isHighlightApiSupported(doc)) {
    return;
  }
  const highlight = getOrCreateHighlight(doc, FIND_HIGHLIGHT_ACTIVE_NAME);
  const sheet = ensureHighlightSheet(doc);
  if (!highlight || !sheet) {
    return;
  }
  highlight.clear();
  if (range) {
    adoptSheetForRange(doc, sheet, range);
    highlight.add(range);
    highlightedDocuments.add(doc);
  }
}

/** 清除单个文档的全部查找高亮（两层 + 注册表键删除）。 */
export function clearFindHighlights(doc: DocumentLike): void {
  highlightedDocuments.delete(doc);
  const registry = getHighlightRegistry(doc);
  if (!registry) {
    return;
  }
  registry.delete(FIND_HIGHLIGHT_NAME);
  registry.delete(FIND_HIGHLIGHT_ACTIVE_NAME);
}

/** 清除所有已跟踪文档的高亮（协调器 clear 的兜底面）。 */
export function clearAllFindHighlights(): void {
  // 快照遍历：clearFindHighlights 会从跟踪集合删除条目，先取快照再清集合防漏。
  const docs = Array.from(highlightedDocuments);
  highlightedDocuments.clear();
  for (const doc of docs) {
    clearFindHighlights(doc);
  }
}
