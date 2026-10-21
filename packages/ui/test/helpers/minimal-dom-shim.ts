// ============================================================
// 单测用的最小 DOM shim。
// ============================================================
// 仓库的 ui 包测试走 `node:test` + tsx（见 src 下现有 *.test.tsx），Node 环境没有
// jsdom/happy-dom（仓库刻意未引入 DOM 测试依赖）。R5 的错误边界单测需要 createRoot 的
// 客户端渲染路径（getDerivedStateFromError/componentDidCatch 只在交互式渲染里走），
// React 19 对宿主 DOM 实际触达的面很小（nodeType / namespaceURI / createElement /
// appendChild / ownerDocument / style / addEventListener），这里手写一个只实现该子集的
// document/Element，够把卡片边界树挂起来并序列化断言。
//
// 注意：React 会向 style 上写 cssFloat/setProperty、向节点挂 onclick=noop、按
// nodeType=9 找 body、按 documentElement.namespaceURI 推 host context——shim 都给了
// 占位实现。测试里不模拟布局与事件派发，只断言结构。

class MiniElement {
  tagName: string;
  nodeType = 1;
  childNodes: MiniElement[] = [];
  parentNode: MiniElement | null = null;
  attributes: Record<string, string> = {};
  textContent: string | null = null;
  /** createElementNS 生成的节点带命名空间（svg/math），React 读它推 host context。 */
  namespace: string | null = null;
  /** React 会写 style.cssFloat / style[styleName]，并可能调 setProperty。 */
  declare style: Record<string, string> & {
    setProperty?: (name: string, value: string) => void;
  };
  private styleRecord: Record<string, string> & {
    setProperty?: (name: string, value: string) => void;
  };
  ownerDocument: MiniDocument;
  /** React 在容器/节点上挂 onclick=noop（focus 事件兜底），占位可写。 */
  onclick: unknown = null;
  innerHTML = "";
  constructor(tagName: string, doc: MiniDocument) {
    // setProperty 写回自身键：Record 索引签名与函数成员互斥（对象字面量直标会 TS2322），
    // 先建纯 Record 再动态挂方法，让索引签名与可选方法成员两侧类型各自成立。
    const style: Record<string, string> = {};
    (style as Record<string, unknown>)["setProperty"] = (name: string, value: string) => {
      style[name] = value;
    };
    this.styleRecord = style;
    this.style = this.styleRecord;
    this.tagName = tagName;
    this.ownerDocument = doc;
  }
  get namespaceURI(): string | null {
    return this.namespace;
  }
  appendChild(child: MiniElement) {
    if (child.parentNode !== null) {
      child.parentNode.removeChild(child);
    }
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }
  removeChild(child: MiniElement) {
    const index = this.childNodes.indexOf(child);
    if (index >= 0) this.childNodes.splice(index, 1);
    child.parentNode = null;
    return child;
  }
  insertBefore(child: MiniElement, before: MiniElement | null) {
    if (child.parentNode !== null) {
      child.parentNode.removeChild(child);
    }
    child.parentNode = this;
    if (before === null || !this.childNodes.includes(before)) {
      this.childNodes.push(child);
    } else {
      const index = this.childNodes.indexOf(before);
      this.childNodes.splice(index, 0, child);
    }
    return child;
  }
  setAttribute(name: string, value: string) {
    this.attributes[name] = value;
  }
  getAttribute(name: string) {
    return this.attributes[name] ?? null;
  }
  removeAttribute(name: string) {
    delete this.attributes[name];
  }
  getBoundingClientRect() {
    return { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };
  }
  addEventListener() {}
  removeEventListener() {}
  /** 工作流卡片的表情动画直接写 dataset.expression / style 属性（workflow-face-motion）。 */
  get dataset(): Record<string, string> {
    return (this.attributes as Record<string, string>) ?? {};
  }
  get firstChild(): MiniElement | null {
    return this.childNodes[0] ?? null;
  }
  get lastChild(): MiniElement | null {
    return this.childNodes[this.childNodes.length - 1] ?? null;
  }
  /** React 的 setTextContent 优先进 nodeValue，缺省走 textContent。 */
  get nodeValue(): string | null {
    return this.textContent;
  }
  set nodeValue(value: string | null) {
    this.textContent = value;
  }
  get nextSibling(): MiniElement | null {
    if (this.parentNode === null) return null;
    const siblings = this.parentNode.childNodes;
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }
  /** React 用 Object.prototype.toString 判别未知元素（"[object HTMLUnknownElement]"）；
      这里给各元素标准的 tag 类名，让 React 走“已知元素”分支。 */
  get [Symbol.toStringTag]() {
    return `HTML${this.tagName.charAt(0).toUpperCase()}${this.tagName.slice(1)}Element`;
  }
}

class MiniDocument extends MiniElement {
  declare nodeType: 9;
  body: MiniElement;
  head: MiniElement;
  documentElement: MiniElement;
  /** React 按 ownerDocument.defaultView 回到 window。 */
  defaultView: unknown = null;
  activeElement: MiniElement | null = null;
  constructor() {
    super("#document", null as unknown as MiniDocument);
    this.ownerDocument = this;
    this.documentElement = new MiniElement("html", this);
    this.head = new MiniElement("head", this);
    this.body = new MiniElement("body", this);
    this.appendChild(this.documentElement);
  }
  createElement(tag: string) {
    return new MiniElement(tag, this);
  }
  /** SVG/Math 元素走 createElementNS（lucide 图标是 svg + path）。 */
  createElementNS(namespace: string, tag: string) {
    const node = new MiniElement(tag, this);
    node.namespace = namespace;
    return node;
  }
  createTextNode(text: string) {
    const node = new MiniElement("#text", this);
    node.nodeType = 3;
    node.textContent = text;
    return node;
  }
  createComment() {
    const node = new MiniElement("#comment", this);
    node.nodeType = 8;
    return node;
  }
  createDocumentFragment() {
    const node = new MiniElement("#fragment", this);
    node.nodeType = 11;
    return node;
  }
  getElementById() {
    return null;
  }
  querySelector() {
    return null;
  }
  querySelectorAll() {
    return [] as unknown as MiniElement[];
  }
  addEventListener() {}
  removeEventListener() {}
}

const doc = new MiniDocument();
const miniWindow = {
  document: doc,
  navigator: { language: "zh-CN" },
  /** React 的 getActiveElementDeep 走 defaultView.document.activeElement / body。 */
  HTMLIFrameElement: class HTMLIFrameElement {},
  addEventListener() {},
  removeEventListener() {},
  setTimeout,
  clearTimeout,
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(callback, 0),
  cancelAnimationFrame: clearTimeout,
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
};
doc.defaultView = miniWindow;
(globalThis as Record<string, unknown>).document = doc;
(globalThis as Record<string, unknown>).window = miniWindow;
// Node 24 自带只读 navigator（language 恰好解析成 zh-CN），无需覆盖；
// ErrorBoundary 的 resolveBoundaryLocale 只读 navigator.language。

export { MiniElement, MiniDocument };

/** 序列化成断言可用的伪 HTML（只保留 tag、属性与文本）。 */
export function serializeDom(node: MiniElement): string {
  if (node.nodeType === 3) {
    return node.textContent ?? "";
  }
  if (node.nodeType !== 1) {
    return node.childNodes.map(serializeDom).join("");
  }
  const attrs = Object.entries(node.attributes)
    .map(([name, value]) => ` ${name}="${value}"`)
    .join("");
  // React 把字符串子节点直接写进 textContent（不生成子 text 节点），序列化时展开。
  const text = node.textContent ?? "";
  const children = node.childNodes.map(serializeDom).join("");
  return `<${node.tagName}${attrs}>${text}${children}</${node.tagName}>`;
}
