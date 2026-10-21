/**
 * 页内查找二期：内置 DOM 腿搜索（specs: packages/desktop/specs/find-in-page.md R9/R12）。
 *
 * 协调器的默认搜索腿：对 document.body 做应用级全文搜索（等价覆盖 Chromium 原生路
 * 能找到的已渲染文本），产出按文档序的命中 Range 列表。纯核心（文本拼接搜索 +
 * 命中区间→跨节点 Range 映射）与 DOM 适配层（TreeWalker 收集）分离，node 可测。
 *
 * 纪律：
 * - 零 DOM 变更——只读遍历 + createRange，高亮由 findInPageHighlight.ts 的
 *   CSS Custom Highlight API 承担；
 * - 排除 provider scope 子树（各腿互斥不重复计数）与查找栏自身
 *   （[data-find-in-page-overlay]，收口一期「匹配到计数文本」已知边界）；
 * - 块级边界插 \n 哨兵防跨块假命中；inline 边界不断（<b> 拆分的命中可跨节点）；
 * - 穿透 open shadow root（宿主元素处同样落哨兵，closed root 不可见=不可搜，不作假命中）。
 */

/** provider scope / 查找栏自身的排除属性（协调器与宿主组件共用常量）。 */
const FIND_OVERLAY_EXCLUDE_ATTRIBUTE = "data-find-in-page-overlay";
export const FIND_SCOPE_EXCLUDE_ATTRIBUTE = "data-find-provider-scope";

/** 不可见/非内容标签：整棵子树跳过。 */
const SKIPPED_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"]);

/**
 * 块级边界标签（哨兵插入点）。按标签名判定而非 computed display——搜索是每查询一次的
 * 低频操作，但全树 getComputedStyle 仍过于昂贵；display:block 的 span/div 自定义块
 * 由 DIV/P 等常见标签覆盖，漏网的自定义块最坏产生一处跨块假命中（登记为已知近似，
 * 不造假命中方向的错误——只会多报不会少报）。
 */
const BLOCK_BOUNDARY_TAGS = new Set([
  "ADDRESS",
  "ARTICLE",
  "ASIDE",
  "BLOCKQUOTE",
  "BR",
  "DD",
  "DIV",
  "DL",
  "DT",
  "FIELDSET",
  "FIGCAPTION",
  "FIGURE",
  "FOOTER",
  "FORM",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "HEADER",
  "HR",
  "LI",
  "MAIN",
  "NAV",
  "OL",
  "P",
  "PRE",
  "SECTION",
  "TABLE",
  "TBODY",
  "TD",
  "TFOOT",
  "TH",
  "THEAD",
  "TR",
  "UL",
]);

/** 收集产物：拼接文本 + 文本节点偏移表（映射 Range 用）。 */
export interface SearchableTextBuffer {
  haystack: string;
  entries: Array<{ node: { data: string }; start: number }>;
}

/** 命中区间（haystack 偏移，半开 [start,end)）。 */
export interface TextMatchInterval {
  start: number;
  end: number;
}

/** Range 工厂（纯核心注入点：浏览器 = document.createRange.bind(document)）。 */
export interface RangeFactory {
  createRange(): {
    setStart(node: unknown, offset: number): void;
    setEnd(node: unknown, offset: number): void;
  };
}

/**
 * 纯核心：大小写不敏感搜索全部非重叠命中。
 * 含 \n 的查询直接无命中（哨兵字符不参与用户可见文本，跨块命中本来就不成立）。
 */
export function findTextMatchIntervals(haystack: string, query: string): TextMatchInterval[] {
  if (query.length === 0 || query.includes("\n")) {
    return [];
  }
  const lowerHaystack = haystack.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const matches: TextMatchInterval[] = [];
  let cursor = lowerHaystack.indexOf(lowerQuery);
  while (cursor !== -1) {
    matches.push({ start: cursor, end: cursor + lowerQuery.length });
    cursor = lowerHaystack.indexOf(lowerQuery, cursor + lowerQuery.length);
  }
  return matches;
}

/**
 * 纯核心：命中区间 → 跨节点 Range 列表（蓝本渲染层映射算法的移植）。
 * entries 按文档序、start 单调；单个命中可横跨多个文本节点（inline 拆分）。
 * 落在哨兵上的命中不存在（查询不含 \n），无需特判。
 */
export function mapMatchesToRanges<R>(
  entries: ReadonlyArray<{ node: { data: string }; start: number }>,
  matches: readonly TextMatchInterval[],
  factory: RangeFactory,
): R[] {
  const ranges: R[] = [];
  let cursor = 0;
  for (const match of matches) {
    // 推进到包含 match.start 的文本节点（noUncheckedIndexedAccess：逐项判空）。
    let startEntry = entries[cursor];
    while (startEntry && startEntry.start + startEntry.node.data.length <= match.start) {
      cursor += 1;
      startEntry = entries[cursor];
    }
    if (!startEntry) {
      break;
    }
    const range = factory.createRange();
    range.setStart(startEntry.node, match.start - startEntry.start);
    for (let index = cursor; index < entries.length; index += 1) {
      const entry = entries[index];
      if (!entry) {
        continue;
      }
      if (match.end <= entry.start + entry.node.data.length) {
        range.setEnd(entry.node, match.end - entry.start);
        break;
      }
    }
    ranges.push(range as R);
  }
  return ranges;
}

interface CollectEnv {
  getClientRects(el: Element): number;
  isElement(node: unknown): node is Element;
  isText(node: unknown): node is { data: string };
  childNodes(node: unknown): ReadonlyArray<unknown>;
  shadowRootOf(el: Element): unknown | null;
  tagNameOf(el: Element): string;
  hasAttribute(el: Element, name: string): boolean;
}

/**
 * 纯核心：深度优先收集可搜文本（块级边界插 \n 哨兵）。
 * 环境访问全部经 CollectEnv 注入——浏览器传真实 DOM 适配，测试传最小 stub。
 */
export function collectSearchableText(
  root: unknown,
  exclude: ReadonlySet<unknown>,
  env: CollectEnv,
): SearchableTextBuffer {
  let haystack = "";
  const entries: SearchableTextBuffer["entries"] = [];

  const appendText = (node: { data: string }): void => {
    entries.push({ node, start: haystack.length });
    haystack += node.data;
  };
  const appendSentinel = (): void => {
    haystack += "\n";
  };

  const walkChildren = (parent: unknown): void => {
    for (const child of env.childNodes(parent)) {
      if (env.isText(child)) {
        appendText(child);
        continue;
      }
      if (!env.isElement(child)) {
        continue;
      }
      const el = child;
      if (
        exclude.has(el) ||
        SKIPPED_TAGS.has(env.tagNameOf(el)) ||
        env.hasAttribute(el, FIND_OVERLAY_EXCLUDE_ATTRIBUTE) ||
        env.hasAttribute(el, FIND_SCOPE_EXCLUDE_ATTRIBUTE) ||
        env.getClientRects(el) === 0
      ) {
        // 排除子树整体落哨兵：前后可见文本不得因排除而拼接成假命中。
        appendSentinel();
        continue;
      }
      const isBoundary = BLOCK_BOUNDARY_TAGS.has(env.tagNameOf(el));
      if (isBoundary) {
        appendSentinel();
      }
      walkChildren(el);
      const shadow = env.shadowRootOf(el);
      if (shadow) {
        // open shadow root：宿主边界同样落哨兵（跨 root 拼接不成立）。
        appendSentinel();
        walkChildren(shadow);
        appendSentinel();
      }
      if (isBoundary) {
        appendSentinel();
      }
    }
  };

  walkChildren(root);
  return { haystack, entries };
}

/** 浏览器 DOM 适配：把 collectSearchableText 接到真实 document。 */
export function createDomCollectEnv(): CollectEnv {
  return {
    getClientRects: (el) => el.getClientRects().length,
    isElement: (node): node is Element => node instanceof Element,
    isText: (node): node is { data: string } => node instanceof Text,
    childNodes: (node) => Array.from((node as { childNodes: ArrayLike<unknown> }).childNodes ?? []),
    shadowRootOf: (el) => el.shadowRoot,
    tagNameOf: (el) => el.tagName,
    hasAttribute: (el, name) => el.hasAttribute(name),
  };
}

/**
 * 内置 DOM 腿入口（浏览器专用）：搜索 document.body，产出文档序命中 Range。
 * exclude = provider scope 元素集合（各腿互斥）；查找栏自身由属性排除兜底。
 */
export function searchDocumentRanges(text: string, exclude: ReadonlySet<Element>): Range[] {
  if (typeof document === "undefined" || !document.body) {
    return [];
  }
  const env = createDomCollectEnv();
  const buffer = collectSearchableText(document.body, exclude as ReadonlySet<unknown>, env);
  const matches = findTextMatchIntervals(buffer.haystack, text);
  return mapMatchesToRanges<Range>(buffer.entries, matches, {
    createRange: () => document.createRange(),
  });
}
