/**
 * 页内查找二期：协调器环境适配（specs: packages/desktop/specs/find-in-page.md R9-R13）。
 *
 * 协调器（findInPageCoordinator.ts）对 DOM 的全部触面收敛在这里——node 单测注入
 * 最小 stub，浏览器用默认实现。分离纪律：协调器只做归并/选择/epoch 编排，不直接
 * 触碰 document/window。
 */
import {
  applyActiveHighlight,
  applyMatchHighlight,
  clearAllFindHighlights,
} from "./findInPageHighlight.js";
import { searchDocumentRanges } from "./findInPageDomSearch.js";

export interface FindInPageCoordinatorEnv {
  /** 是否具备文档面（Web/node 环境探测；false 时协调器全部收口空结果）。 */
  hasDocument(): boolean;
  /** 内置 DOM 腿：全文搜索（排除 scope 子树/查找栏），返回文档序命中 Range。 */
  searchDocument(text: string, exclude: ReadonlySet<unknown>): unknown[];
  /** Range 起点节点（归并排序键的提取）。 */
  rangeStartNode(range: unknown): unknown;
  /** 节点上浮到最外层 shadow host（文档序比较必须在同一 tree scope 下进行）。 */
  hostify(node: unknown): unknown;
  isConnected(node: unknown): boolean;
  /** 文档序比较：-1 = a 在 b 前，0 = 同一位置，1 = a 在 b 后。 */
  comparePosition(a: unknown, b: unknown): number;
  /** 两个 Range 边界全等（增量重搜的 exact remap 判据）。 */
  sameRangeBoundaries(a: unknown, b: unknown): boolean;
  applyMatchHighlight(ranges: readonly unknown[]): void;
  applyActiveHighlight(range: unknown | null): void;
  clearHighlights(): void;
  scrollRangeIntoView(range: unknown): void;
  /** active range 的布局高度（重绘重试预算的判据：0 = 布局未就绪）。 */
  measureRangeHeight(range: unknown): number;
  /** double-rAF 调度（重绘重试；测试注入同步/手动泵）。 */
  scheduleFramePair(callback: () => void): void;
}

interface NodeLike {
  getRootNode?(): { host?: unknown };
  parentElement?: unknown;
  isConnected?: boolean;
}

function asNode(value: unknown): NodeLike | null {
  return typeof value === "object" && value !== null ? (value as NodeLike) : null;
}

/** shadow root 上浮：getRootNode() 返回 shadow root（带 host）时循环上到最外层 host。 */
function hostifyNode(node: unknown): unknown {
  let current = asNode(node);
  if (!current) {
    return node;
  }
  for (
    let root = current.getRootNode?.();
    root && "host" in root && root.host;
    root = asNode(root.host)?.getRootNode?.()
  ) {
    current = asNode(root.host);
    if (!current) {
      return root.host;
    }
  }
  return current;
}

/** 浏览器默认环境：真实 DOM + CSS Custom Highlight 封装。 */
export function createBrowserCoordinatorEnv(): FindInPageCoordinatorEnv {
  return {
    hasDocument: () => typeof document !== "undefined" && document.body !== null,
    searchDocument: (text, exclude) => searchDocumentRanges(text, exclude as ReadonlySet<Element>),
    rangeStartNode: (range) => (range as Range).startContainer,
    hostify: hostifyNode,
    isConnected: (node) => asNode(node)?.isConnected === true,
    comparePosition: (a, b) => {
      const left = a as Node;
      const right = b as Node;
      if (left === right) {
        return 0;
      }
      const position = left.compareDocumentPosition(right);
      // DOCUMENT_POSITION_FOLLOWING(4) = right 在 left 后 → left 排前（-1）。
      if (position & Node.DOCUMENT_POSITION_FOLLOWING) {
        return -1;
      }
      if (position & Node.DOCUMENT_POSITION_PRECEDING) {
        return 1;
      }
      return 0;
    },
    sameRangeBoundaries: (a, b) => {
      const left = a as Range;
      const right = b as Range;
      return (
        left.startContainer === right.startContainer &&
        left.startOffset === right.startOffset &&
        left.endContainer === right.endContainer &&
        left.endOffset === right.endOffset
      );
    },
    applyMatchHighlight: (ranges) => applyMatchHighlight(document, ranges as Range[]),
    applyActiveHighlight: (range) => applyActiveHighlight(document, range as Range | null),
    clearHighlights: () => clearAllFindHighlights(),
    scrollRangeIntoView: (range) => {
      const start = asNode((range as Range).startContainer);
      const element =
        start && "parentElement" in start && start.parentElement
          ? (start.parentElement as Element)
          : null;
      element?.scrollIntoView({ block: "nearest" });
    },
    measureRangeHeight: (range) => {
      try {
        return (range as Range).getBoundingClientRect().height;
      } catch {
        return 0;
      }
    },
    scheduleFramePair: (callback) => {
      if (typeof requestAnimationFrame !== "function") {
        return;
      }
      requestAnimationFrame(() => requestAnimationFrame(callback));
    },
  };
}
